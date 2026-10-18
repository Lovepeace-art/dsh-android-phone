/**
 * adb 设备层：定位 adb、跑命令、截屏、读控件树、注入输入。
 *
 * 设计约束：
 * 1) 零第三方依赖（插件宿主半边不能 import @deepseek-ai/*，也不想再装 npm 包）。
 * 2) 二进制安全：`exec-out screencap -p` 的 PNG 必须按 Buffer 收，不能当文本；收到后校验 IHDR，
 *    坏了就退化成「shell 写文件 + pull」这条字节精确的路。
 * 3) 环境注意：**受限沙箱里 spawn 带 piped stdio 会被拒（EPERM）**，所以跑自测脚本要用无约束任务；
 *    插件宿主进程（DSH）不受限，正式使用没问题。
 * 4) 一次只认一台设备：多台时必须显式给 serial，避免操作到错的手机（不可逆的操作别赌）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPng, pngSize } from '../core/png.js';

/** 插件自己的根目录（src/android → ../..）。用来找插件自带的 vendor/，不依赖进程 cwd。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEVICE_STATE = {
  device: '已授权（可用）',
  unauthorized: '未授权：请在手机上点「允许 USB 调试」',
  offline: '离线：拔插数据线或 adb kill-server 重试',
  'no permissions': '无权限：数据线/驱动问题（华为需选「传输文件」模式）',
};

/* ------------------------------------------------------------------ adb 定位 */

function qtScrcpyCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  // 桌面也要扫：用户把新版解压在 <桌面>\QtScrcpy-win-x64-v4.2.1\QtScrcpy-win-x64-v4.2.1\
  const roots = [home && path.join(home, 'Desktop'), 'D:\\Ruan', 'C:\\Ruan', 'D:\\', 'C:\\'].filter(Boolean);
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !/qt[-_]?scrcpy/i.test(e.name)) continue;
      const flat = path.join(root, e.name, 'adb.exe');
      if (existsSync(flat)) {
        found.push({ tag: e.name, p: flat });
        continue;
      }
      // 有些发布包解压成 <dir>/<dir>/adb.exe（多一层）
      let inner = [];
      const mid = path.join(root, e.name);
      try {
        inner = readdirSync(mid, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const i2 of inner) {
        if (!i2.isDirectory()) continue;
        const nested = path.join(mid, i2.name, 'adb.exe');
        if (existsSync(nested)) found.push({ tag: i2.name, p: nested });
      }
    }
  }
  // 版本号大的优先：v4.2.1 > v3.3.3（用户明确要求用最新版）
  const ver = (s) => (String(s).match(/v?(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  found.sort((a, b) => {
    const A = ver(a.tag);
    const B = ver(b.tag);
    for (let i = 0; i < 3; i += 1) {
      const d = (B[i] || 0) - (A[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  return found.map((f) => f.p);
}

/** 按优先级找一个能用的 adb.exe；找不到返回 null（调用方给出安装提示）。 */
export function resolveAdb(explicit) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    explicit,
    process.env.DSH_ADB,
    // 插件自带的 vendor（相对插件目录，**不看 cwd**：DSH 宿主进程的 cwd 是 DSH 安装目录）
    path.join(PLUGIN_ROOT, 'vendor', 'platform-tools', 'adb.exe'),
    path.join(PLUGIN_ROOT, 'vendor', 'adb.exe'),
    path.join(process.cwd(), 'vendor', 'platform-tools', 'adb.exe'),
    home && path.join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    ...qtScrcpyCandidates(),
    'C:\\Program Files\\Android\\platform-tools\\adb.exe',
    'C:\\platform-tools\\adb.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null; // 也可能在 PATH 上，调用方决定是否用裸名 'adb'
}

/* ------------------------------------------ adb server 自举（坑 16，2026-10-16） */

/**
 * DSH 宿主在文件沙箱里时，`adb` 起不来自己的常驻 daemon：被 fork 出去的 daemon 写
 * `%TEMP%\adb.log` 会被拒 —— 实测原文：
 *   F adb : main.cpp:54 cannot open C:\Users\...\Temp\adb.log: Permission denied
 *   could not read ok from ADB Server
 *   * failed to start daemon / adb.exe: failed to check server version: cannot connect to daemon
 * （手动创建 adb.log、换 TEMP、WMI 拉起 `adb start-server` 都照样失败。）
 * 但同一个 adb.exe 用 `nodaemon server` **前台**跑 —— 就在本进程树里 —— 完全正常，设备列表立刻出来。
 * 所以这里自己把 server 起起来（子进程生命周期 = DSH 进程，退出一起走，不留残留），
 * 后续命令连它就行；server 掉线时下一次 adb 调用会自动再自举一次。
 */
let serverBoot = null; // 单飞：并发调用只引导一次
const DAEMON_DOWN_RE = /could not read ok from ADB Server|cannot connect to daemon|failed to start daemon|cannot open .*adb\.log/i;

/** 这条 adb 输出看起来是「server 没起来」而不是命令本身的错。 */
export function looksLikeDaemonDown(r) {
  if (!r || r.ok) return false;
  return DAEMON_DOWN_RE.test(`${r.stderr || ''}\n${r.text || ''}\n${r.err || ''}`);
}

export function adbServerPort() {
  const p = Number(process.env.ADB_SERVER_PORT);
  return Number.isFinite(p) && p > 0 ? p : 5037;
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * 确保 adb server 在跑。已经在跑就直接返回（already:true）；否则 `nodaemon server` 前台起一个并等端口。
 * @returns {Promise<{ok:boolean, port:number, already?:boolean, ms?:number, pid?:number, error?:string, exit?:number, timeout?:boolean}>}
 */
export async function ensureAdbServer({ adbPath, port = adbServerPort(), waitMs = 12000 } = {}) {
  if (await portOpen(port)) return { ok: true, already: true, port };
  if (serverBoot) return serverBoot;
  serverBoot = (async () => {
    const exe = adbPath || resolveAdb() || 'adb';
    let child;
    try {
      child = spawn(exe, ['-L', `tcp:${port}`, 'nodaemon', 'server'], { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      return { ok: false, port, error: `${exe}: ${e.message}` };
    }
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    child.on('error', () => { exited = -1; });
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (await portOpen(port)) return { ok: true, port, ms: Date.now() - t0, pid: child.pid };
      if (exited !== null) return { ok: false, port, exit: exited, ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, port, timeout: true, ms: Date.now() - t0 };
  })().finally(() => { setTimeout(() => { serverBoot = null; }, 1000); });
  return serverBoot;
}

/* ------------------------------------------------------------------ 执行 */

/** 跑一条 adb 命令（不判错、不重试）。 */
function runAdbOnce(args, opts = {}) {
  const { serial, timeoutMs = 30000, adbPath } = opts;
  const exe = adbPath || resolveAdb() || 'adb';
  const full = serial ? ['-s', String(serial), ...args] : args;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, full, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, code: null, buf: Buffer.alloc(0), text: '', stderr: '', err: `${exe}: ${e.message}` });
      return;
    }
    const outs = [];
    const errs = [];
    let done = false;
    const finish = (extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const buf = Buffer.concat(outs);
      resolve({
        ok: extra.code === 0,
        code: extra.code ?? null,
        buf,
        text: buf.toString('utf8'),
        stderr: Buffer.concat(errs).toString('utf8').trim(),
        err: extra.err,
      });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ code: null, err: `超时 ${timeoutMs}ms: adb ${full.join(' ')}` });
    }, timeoutMs);
    child.stdout.on('data', (d) => outs.push(d));
    child.stderr.on('data', (d) => errs.push(d));
    child.on('error', (e) => finish({ code: null, err: e.message }));
    child.on('close', (code) => finish({ code }));
  });
}

/**
 * 跑一条 adb 命令。server 没起来时（沙箱里 adb 自己拉不起 daemon，见坑 16）先自举再重试一次。
 * @returns {Promise<{ok:boolean, code:number|null, buf:Buffer, text:string, stderr:string, err?:string}>}
 */
export async function adbRun(args, opts = {}) {
  const first = await runAdbOnce(args, opts);
  if (opts.ensureServer === false || !looksLikeDaemonDown(first)) return first;
  const boot = await ensureAdbServer({ adbPath: opts.adbPath, port: adbServerPort() });
  if (!boot.ok) return first;
  return runAdbOnce(args, opts);
}

/** 跑命令并返回去掉首尾空白的文本（失败抛错）。 */
export async function adbText(args, opts = {}) {
  const r = await adbRun(args, opts);
  if (r.err) throw new Error(r.err);
  if (!r.ok) throw new Error(`adb ${args.join(' ')} 失败(code=${r.code}): ${r.stderr || r.text.slice(0, 200)}`);
  return r.text.trim();
}

export async function adbVersion(adbPath) {
  const r = await adbRun(['version'], { adbPath });
  const first = r.text.split(/\r?\n/)[0] || '';
  return { ok: r.ok, path: adbPath || resolveAdb() || 'adb(from PATH)', text: r.text.trim(), version: first.replace(/^Android Debug Bridge version\s*/, ''), err: r.err, stderr: r.stderr };
}

/* ------------------------------------------------------------------ 设备 */

/** 解析 `adb devices -l`。 */
export async function listDevices(adbPath) {
  const r = await adbRun(['devices', '-l'], { adbPath, timeoutMs: 20000 });
  const lines = r.text.split(/\r?\n/).slice(1).filter((l) => l.trim());
  return lines.map((line) => {
    const m = line.trim().match(/^(\S+)\s+(\S+)(.*)$/);
    const serial = m ? m[1] : line.trim();
    const state = m ? m[2] : 'unknown';
    const rest = (m && m[3]) || '';
    const grab = (k) => (rest.match(new RegExp(`${k}:([^\\s]+)`)) || [])[1] || '';
    return { serial, state, label: DEVICE_STATE[state] || state, model: grab('model'), product: grab('product'), transportId: grab('transport_id') };
  });
}

let lastHeal = 0;   // 自愈节流：状态轮询很密，别每次都 kill-server

/**
 * adb 自愈（坑 16 的补完）：server 卡死 / 设备列表空的时候，唯一能本地清掉的手段就是
 * `adb kill-server` 再自己前台起一个 `nodaemon server`，然后等设备回到 `device` 状态。
 * 只做这两件事，不碰手机侧设置 —— 拔线/没授权这种事它救不了，只能报清楚。
 */
export async function healAdb({ adbPath, waitMs = 6000 } = {}) {
  lastHeal = Date.now();
  const steps = [];
  const k = await runAdbOnce(['kill-server'], { adbPath, timeoutMs: 8000 });
  steps.push({ step: 'kill-server', ok: k.ok, stderr: (k.stderr || '').slice(0, 200) || undefined });
  serverBoot = null;
  const boot = await ensureAdbServer({ adbPath, port: adbServerPort(), waitMs: 12000 });
  steps.push({ step: 'nodaemon server', ok: boot.ok, ms: boot.ms, error: boot.error, exit: boot.exit, timeout: boot.timeout });
  if (!boot.ok) return { ok: false, reason: 'adb server 起不来', steps };
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const ds = await listDevices(adbPath);
    if (ds.some((d) => d.state === 'device')) return { ok: true, ms: Date.now() - t0, devices: ds, steps };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: 'server 起来了但设备没回来（拔插数据线 / 手机上重新允许 USB 调试）', steps };
}

/**
 * 选一台设备：显式 serial 优先；否则要求「恰好一台 device 状态」。
 * 三台以上/状态异常时抛带指引的错误（宁可不做，也不要在错的手机上瞎点）。
 * 一台可用的都没有时，先自愈一次（30 秒内最多一次）再重试。
 */
export async function pickDevice(serial, adbPath, opts = {}) {
  const first = await listDevices(adbPath);
  const usable = (ds) => ds.filter((d) => d.state === 'device').length;
  try {
    return pickFrom(first, serial);
  } catch (e) {
    // 只有「一台可用的都没有」才值得自愈；多台设备/指定错 serial 是人的问题，别乱 kill-server
    if (opts.heal === false || usable(first) > 0) throw e;
    if (Date.now() - lastHeal < 30000) throw e;
    const h = await healAdb({ adbPath }).catch((err) => ({ ok: false, reason: err.message }));
    if (!h.ok) throw e;
    return pickFrom(await listDevices(adbPath), serial);
  }
}

function pickFrom(devices, serial) {
  if (serial) {
    const hit = devices.find((d) => d.serial === serial);
    if (!hit) throw new Error(`找不到设备 ${serial}；当前: ${devices.map((d) => `${d.serial}(${d.state})`).join(', ') || '无'}`);
    if (hit.state !== 'device') throw new Error(`设备 ${serial} 状态是 ${hit.state}：${hit.label}`);
    return hit;
  }
  const ok = devices.filter((d) => d.state === 'device');
  if (ok.length === 1) return ok[0];
  if (ok.length === 0) {
    const bad = devices.map((d) => `${d.serial}:${d.state}(${d.label})`).join(', ');
    throw new Error(devices.length ? `没有可用设备（${bad}）` : '没有检测到设备：数据线插好了吗？开发者选项里 USB 调试开了吗？');
  }
  throw new Error(`检测到 ${ok.length} 台可用设备，请显式指定 serial：${ok.map((d) => d.serial).join(', ')}`);
}

export function shell(serial, cmd, opts = {}) {
  return adbText(['shell', cmd], { serial, timeoutMs: opts.timeoutMs ?? 30000, adbPath: opts.adbPath });
}

/* ------------------------------------------------------------------ 设备信息 */

const propCache = new Map();

export async function deviceProps(serial, opts = {}) {
  if (propCache.has(serial)) return propCache.get(serial);
  const raw = await shell(serial, 'getprop | grep -E "ro.product.(model|brand)|ro.build.version.release|ro.build.version.sdk"', opts).catch(() => '');
  const pick = (key) => {
    const m = raw.match(new RegExp(`\\[${key}\\]:\\s*\\[([^\\]]*)\\]`));
    return m ? m[1] : '';
  };
  const info = { model: pick('ro.product.model'), brand: pick('ro.product.brand'), android: pick('ro.build.version.release'), sdk: pick('ro.build.version.sdk') };
  propCache.set(serial, info);
  return info;
}

/** 物理分辨率 / 密度 / 屏幕方向。screencap 出的是物理像素，所以长截图/坐标都按这个口径。 */
export async function screenMetrics(serial, opts = {}) {
  const [size, density, wm] = await Promise.all([
    shell(serial, 'wm size', opts).catch(() => ''),
    shell(serial, 'wm density', opts).catch(() => ''),
    shell(serial, 'dumpsys window | grep -E "mCurrentRotation|Rotation=" ', opts).catch(() => ''),
  ]);
  const nums = [...size.matchAll(/(\d+)x(\d+)/g)].map((m) => ({ width: Number(m[1]), height: Number(m[2]) }));
  const physical = nums[0] || null;
  const override = nums[1] || null;
  const d = density.match(/Physical density:\s*(\d+)/);
  const rotation = Number((wm.match(/mCurrentRotation=ROTATION_(\d+)/) || wm.match(/Rotation=(\d+)/) || [])[1] ?? 0);
  return {
    width: (override || physical)?.width ?? 0,
    height: (override || physical)?.height ?? 0,
    physical,
    override,
    density: d ? Number(d[1]) : null,
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
}

/** 当前前台应用。先试 Android 10+ 的 mResumedActivity，再退 mCurrentFocus / mFocusedApp。 */
export async function currentFocus(serial, opts = {}) {
  const dump = await shell(serial, 'dumpsys window | grep -E "mResumedActivity|mCurrentFocus|mFocusedApp"', opts).catch(() => '');
  const m = dump.match(/mResumedActivity.*?\s([\w.]+)\/([\w.$]+)/) || dump.match(/mCurrentFocus.*?\s([\w.]+)\/([\w.$]+)/) || dump.match(/mFocusedApp.*?\s([\w.]+)\/([\w.$]+)/);
  return { raw: dump.trim(), package: m ? m[1] : '', activity: m ? m[2] : '' };
}

/**
 * 列出包名。
 * @param {string} serial
 * @param {string} [filter] 透传给 `grep -i`（在设备上过滤，比拉回来再滤快）
 * @param {{adbPath?:string, system?:boolean, userOnly?:boolean}} [opts]
 *        system=false（默认）时用 `pm list packages -3` 只看第三方 App，避免把几百个系统包灌给模型。
 */
export async function listPackages(serial, filter, opts = {}) {
  const scope = opts.system ? ' -s' : ' -3';
  const out = await shell(serial, `pm list packages${scope}${filter ? ` | grep -i ${filter}` : ''}`, opts);
  return out.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean);
}

export async function launchApp(serial, pkg, opts = {}) {
  // monkey 比 am start 抗「找不到默认 Activity」，代价是偶发等 1s
  return shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { ...opts, timeoutMs: 20000 });
}

/* ------------------------------------------------------------------ 截屏 */

/**
 * 截一张整屏 PNG（物理像素）。
 * 主路径 `exec-out screencap -p`；若字节不是完整 PNG（少见：CR 污染/被截断）则退 `screencap -p <file>` + `pull`。
 */
export async function screencap(serial, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const r = await adbRun(['exec-out', 'screencap', '-p'], { serial, timeoutMs, adbPath: opts.adbPath });
  if (r.buf && isPng(r.buf)) {
    const size = pngSize(r.buf);
    if (size) return { buffer: r.buf, size, via: 'exec-out' };
  }
  const remote = '/sdcard/.dsh_shot.png';
  const local = path.join(process.env.TEMP || '/tmp', `dsh_shot_${Date.now()}.png`);
  await shell(serial, `screencap -p ${remote}`, { timeoutMs });
  await adbText(['pull', remote, local], { serial, timeoutMs });
  await shell(serial, `rm -f ${remote}`, { timeoutMs: 10000 }).catch(() => '');
  const { readFile } = await import('node:fs/promises');
  const buffer = await readFile(local);
  const size = pngSize(buffer);
  if (!size) throw new Error(`screencap 两条路都没拿到完整 PNG（exec-out 头: ${r.buf?.subarray(0, 8).toString('hex')}）`);
  return { buffer, size, via: 'pull' };
}

/* ------------------------------------------------------------------ 控件树 */

export function parseBounds(s) {
  const m = (s || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
}

const shortClass = (c) => (c || '').replace(/^android\.widget\./, '').replace(/^android\.view\./, '');
const shortId = (id, pkg) => (id || '').replace(new RegExp(`^${(pkg || '').replace(/\./g, '\\.')}:id/`), '');

/**
 * 解析 uiautomator dump 的 XML → 可用节点（带中心坐标）。
 * 只保留「有文字/描述/可点/可滚」的节点，避免把布局盒子灌给模型（观察预算）。
 */
export function parseUiXml(xml, opts = {}) {
  const max = opts.max ?? 200;
  const nodes = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  let total = 0;
  while ((m = re.exec(xml))) {
    total += 1;
    const attrs = {};
    const ar = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(m[1]))) attrs[a[1]] = a[2];
    const b = parseBounds(attrs.bounds);
    if (!b || b.width <= 0 || b.height <= 0) continue;
    const text = attrs.text || '';
    const desc = attrs['content-desc'] || '';
    const clickable = attrs.clickable === 'true';
    const scrollable = attrs.scrollable === 'true';
    if (!text && !desc && !clickable && !scrollable) continue;
    nodes.push({
      i: nodes.length,
      text,
      desc,
      id: shortId(attrs['resource-id'], attrs.package),
      cls: shortClass(attrs.class),
      pkg: attrs.package || '',
      clickable,
      scrollable,
      enabled: attrs.enabled !== 'false',
      bounds: b,
      x: b.x,
      y: b.y,
    });
  }
  return { nodes: nodes.slice(0, max), total, truncated: nodes.length > max };
}

/**
 * 取控件树：dump 到 /sdcard 再 cat（exec-out dump /dev/tty 在部分机型上会丢尾部）。
 * 带重试：真机上 `uiautomator dump` 偶尔回 `ERROR: could not get idle state`（上一个 dump 卡着，
 * 或界面一直在动），这时清掉残留进程歇一下再来基本都能过 —— 直接抛错会让 phone_inspect 白挂。
 */
export async function uiDump(serial, opts = {}) {
  const remote = '/sdcard/.dsh_ui.xml';
  const compressed = opts.compressed === false ? '' : '--compressed';
  const attempts = Math.max(1, Math.min(5, Number(opts.attempts) || 3));
  let lastErr = '';
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) {
      await shell(serial, 'pkill -f uiautomator', { timeoutMs: 8000, adbPath: opts.adbPath }).catch(() => '');
      await new Promise((r) => setTimeout(r, 400 + i * 300));
    }
    const out = await shell(serial, `uiautomator dump ${compressed} ${remote}`, { ...opts, timeoutMs: opts.timeoutMs ?? 60000 })
      .catch((e) => { lastErr = e.message; return ''; });
    const xml = await adbText(['exec-out', 'cat', remote], { serial, timeoutMs: 30000, adbPath: opts.adbPath })
      .catch((e) => { lastErr = e.message; return ''; });
    await shell(serial, `rm -f ${remote}`, { timeoutMs: 10000, adbPath: opts.adbPath }).catch(() => '');
    if (/<hierarchy/.test(xml)) return { xml, attempts: i + 1, ...parseUiXml(xml, opts) };
    lastErr = `${out || ''} / ${xml.slice(0, 120)}`.trim();
  }
  throw new Error(`uiautomator dump 输出异常（试了 ${attempts} 次，最后：${String(lastErr).slice(0, 160)}）`);
}

/* ------------------------------------------------------------------ 输入注入 */

export async function tap(serial, x, y, opts = {}) {
  return shell(serial, `input tap ${Math.round(x)} ${Math.round(y)}`, opts);
}

export async function longPress(serial, x, y, ms = 700, opts = {}) {
  return swipe(serial, x, y, x, y, ms, opts);
}

/** 滑动/拖拽；durationMs 越大越像人手（>=200ms 才不会变成 fling）。 */
export async function swipe(serial, x1, y1, x2, y2, durationMs = 300, opts = {}) {
  return shell(serial, `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs)}`, opts);
}

/**
 * 一次纵向滚屏（按整屏比例）。
 *
 * 两个真机实测教训：
 *  1) **时长必须跟距离挂钩**：`input swipe` 用默认 300ms 滑 0.75 屏会变成 fling，
 *     松手后惯性还能再飞一整屏以上 —— 逐帧拼接直接没有重叠（实测 dy 估计 1626/1984
 *     全被 low-confidence 拒掉，长截图拼不出来）。这里按 ≈1.5 屏/秒的速度算时长，
 *     慢拖不会有惯性，滚动距离 ≈ 手指位移。
 *  2) 起止点收在屏幕 0.18h~0.72h 之间：贴到顶/底边会触发华为的系统手势。
 */
export async function scrollByScreen(serial, metrics, ratio = 0.5, opts = {}) {
  const w = metrics.width;
  const h = metrics.height;
  const down = ratio >= 0; // 正 = 手指往上滑 = 内容上移（看更下面的内容）
  const dist = Math.round(h * Math.abs(ratio));
  const from = down ? Math.round(h * 0.72) : Math.round(h * 0.28);
  const raw = down ? from - dist : from + dist;
  const to = Math.max(Math.round(h * 0.16), Math.min(Math.round(h * 0.84), raw));
  const durationMs = opts.durationMs ?? Math.max(360, Math.round(Math.abs(from - to) * 0.65));
  return swipe(serial, w / 2, from, w / 2, to, durationMs, opts);
}

const KEYCODES = {
  home: 3, back: 4, call: 5, endcall: 6, power: 26, menu: 82, notification: 83, search: 84,
  enter: 66, del: 67, tab: 61, escape: 111, appswitch: 187, wakeup: 224, sleep: 223, screenshot: 120,
  // 下面这批是为了和 control.js 的键表对齐（侧栏「键盘直通」会把方向键/音量键也发过来，
  // 没有控制通道时走 adb 回落，这里缺一个就会抛「未知按键」）
  volumeup: 24, volumedown: 25, mute: 164, dpadup: 19, dpaddown: 20, dpadleft: 21, dpadright: 22,
  center: 23, movehome: 122, moveend: 123, pagedown: 93, pageup: 92,
};

/**
 * 键名归一化：`APP_SWITCH` / `app-switch` / `appswitch` 都收敛成 `appswitch`。
 * 之前侧栏「🗂 任务」按钮一直报「未知按键 APP_SWITCH」就是这个原因 ——
 * 键表里存的是 appswitch，而传进来的是 Android 官方的常量名。
 */
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

export async function keyevent(serial, key, opts = {}) {
  const code = typeof key === 'number' ? key : KEYCODES[normKey(key)];
  if (!code) throw new Error(`未知按键 ${key}（可用: ${Object.keys(KEYCODES).join(', ')}）`);
  return shell(serial, `input keyevent ${code}`, opts);
}

/**
 * 输入文本。`input text` 只吃 ASCII（中文/emoji 会被静默丢掉），
 * 所以非 ASCII 一律抛出明确错误，而不是假装成功——要打中文得装 ADBKeyboard 或走 scrcpy 控制通道。
 */
export async function typeText(serial, text, opts = {}) {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new Error('adb input text 只能输入 ASCII；中文请改用 scrcpy 控制通道或 ADBKeyboard IME');
  }
  const escaped = text.replace(/ /g, '%s').replace(/([()<>|;&*\\~"'])/g, '\\$1');
  return shell(serial, `input text ${escaped}`, opts);
}

export async function wake(serial, opts = {}) {
  await keyevent(serial, 'wakeup', opts).catch(() => '');
  await shell(serial, 'wm dismiss-keyguard', opts).catch(() => '');
}
