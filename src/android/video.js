/**
 * scrcpy-server 视频/控制通道（QtScrcpy 同款）：H.264 裸流 + 控制消息，用来做 DSH 侧栏的实时画面与输入。
 *
 * 实测（真机 HUAWEI WLZ-AN00 / Android 12，scrcpy-server v5.0.1 / adb 37.0.1）：
 *  - 启动：adb shell CLASSPATH=/data/local/tmp/scrcpy-server app_process / com.genymobile.scrcpy.Server <版本> <key=value...>
 *  - 版本必须与 server 内置版本一致，否则报 "The server version (4.1) does not match the client (0.0.0)"（我们据此自动探测）
 *
 * 连接方向（两种，2026-10-16 实测结论见 PROGRESS.md 坑 8）：
 *  - **reverse（默认，必须用这个）**：server 侧 `tunnel_forward=false`，**server 主动 connect** 到宿主的
 *    `tcp:PORT`；宿主先 `createServer()` 听本地端口，再 `adb reverse localabstract:scrcpy_<scid> tcp:PORT`。
 *    实测反向模式 4/4 轮稳活 20s（childExit=null、无 close/err），而同参数的正向模式
 *    （`tunnel_forward=true` + `adb forward`）会在 2~4 秒后**静默停流并干净退出**（0 异常、exit code 0）。
 *    最可能的原因是 `adb forward` 那条路径（含“server 还没监听时的失败连接”）把 adbd 侧的映射搞成半死状态。
 *  - forward（兜底）：`tunnel_forward=true` + `adb forward tcp:PORT localabstract:scrcpy_<scid>`，客户端主动连。
 *    慢、且上面那个坑会复现（旧版实现就是这条路，起流 9.8s 且长跑不稳）。
 *
 * 流头布局（`DesktopConnection` / `Streamer` 源码核实）：
 *  - reverse（`send_dummy_byte=false`）：64 字节设备名 + 4 字节 codec("h264") + 4 字节 flags(0x80000000) + 4 宽 + 4 高 → 包从 **80** 开始
 *    （v4.x 无 session meta 时是 64 + 4 + 4 + 4 → 包从 **76** 开始）
 *  - forward（`send_dummy_byte=true`）：上面整体前插 1 字节 dummy(0) → 包从 **81** / **77** 开始
 *  - flags 高位 0x80000000 是“有 session meta”的标志（宽度不可能是 21 亿），据此判布局是安全的
 *  - **注意：设备名（64 字节）是在所有 socket 都连完之后才发的**；control=true 时若不把控制连接接上，
 *    server 会卡在 accept，客户端只能看到 1 字节 dummy。
 *
 * 每个包 = 12 字节头（u64 raw + u32 size）+ payload(Annex-B)；
 *  raw 的 bit62(0x4000000000000000) = config 包（SPS/PPS），bit61(0x2000000000000000) = 关键帧，PTS = raw & ((1<<61)-1)
 *  payload 自带 00 00 00 01 起始码（实测 config 包 = SPS `6742c020...` + PPS `68ce`），可直接喂 WebCodecs（avc format=annexb）
 *
 * 其它两个实测要点：
 *  - `cleanup=false`：scrcpy 的 CleanUp 子进程唯一副作用就是 `unlinkSelf()` 删掉我们 push 上去的 jar
 *    （`CleanUp.main()` → `new File(Server.SERVER_PATH).delete()`），我们一个恢复项都不需要它，所以关掉它
 *    反而省一个进程、省掉每次重推 jar。
 *  - scrcpy 的日志默认走 stdout，但 `internalMain` 在 `Options.parse` 之后调 `Ln.disableSystemStreams()`，
 *    所以 stdout 里只有 `Device: [...]` 一行；要查 server 行为必须抓 `adb logcat`（tag = `scrcpy` / `ACodec`）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adbRun, resolveAdb, pickDevice } from './adb.js';

export const SERVER_VERSION_FALLBACK = '4.1';
export const DEFAULT_VIDEO = {
  maxSize: 1800,         // 长边像素上限（1080x2400 的设备 → 810x1800；0 = 原始分辨率）
  bitRate: 4_000_000,
  // 60 而不是 30：手机屏幕本身是 60Hz，QtScrcpy 默认也不设上限。
  // 卡在 30 帧时侧栏拖动/滚动的跟手感只有一半（用户原话「不如 qtscrcpy 那么流畅」）。
  maxFps: 60,
  // 关键帧间隔（秒）。1 = 每秒一个 IDR：迟到连上来的客户端最多等 1 秒就有起播点，
  // 否则屏幕不动时可能等十几秒（编码器只在画面变化大时才出 IDR）。代价是码率略涨。
  keyFrameInterval: 1,
  videoCodec: 'h264',
  startTimeoutMs: 15000,
};

/** server jar 位置：显式 → env → 插件自带 vendor → adb 同目录 → 常见 QtScrcpy 目录（动态扫，不写死用户名） */
export function resolveServerJar(explicit) {
  const cands = [];
  if (explicit) cands.push(explicit);
  if (process.env.DSH_SCRCPY_SERVER) cands.push(process.env.DSH_SCRCPY_SERVER);
  // 插件自带（vendor/ 随包分发，装到 profile 时一起带过去；这是换机器后唯一可靠的位置）
  try { cands.push(fileURLToPath(new URL('../../vendor/scrcpy-server', import.meta.url))); } catch { /* ignore */ }
  const adb = resolveAdb();
  if (adb) cands.push(join(dirname(adb), 'scrcpy-server'));
  for (const root of qtScrcpyServerDirs()) cands.push(join(root, 'scrcpy-server'));
  for (const c of cands) {
    try { if (c && existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/** 动态找 QtScrcpy 目录（不写死 C:\Users\<某人>\Desktop），支持嵌套一层 */
function qtScrcpyServerDirs() {
  const roots = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) roots.push(join(home, 'Desktop'), join(home, 'Downloads'));
  roots.push('D:\\Ruan', 'C:\\Ruan', 'D:\\', 'C:\\');
  const out = [];
  for (const root of roots) {
    let entries = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const e of entries) {
      if (!/qt[-_]?scrcpy|scrcpy[-_]?win/i.test(e)) continue;
      const p = join(root, e);
      out.push(p);
      try {
        for (const sub of readdirSync(p)) {
          if (/qt[-_]?scrcpy|scrcpy[-_]?win/i.test(sub)) out.push(join(p, sub));
        }
      } catch { /* ignore */ }
    }
  }
  return out;
}

/** 探测 server 内置版本：故意用 0.0.0 调一次，从报错里读出 "server version (4.1)"。 */
export async function detectServerVersion({ adbPath, serial, remotePath = '/data/local/tmp/scrcpy-server' } = {}) {
  const r = await adbRun(['shell', `CLASSPATH=${remotePath} app_process / com.genymobile.scrcpy.Server 0.0.0`],
    { serial, adbPath, timeoutMs: 20000 });
  const text = r.text + r.stderr;
  const m = text.match(/server version \(([0-9][^\s)]*)\)/i);
  if (m) return m[1];
  return SERVER_VERSION_FALLBACK;
}

/** push server jar（大小不同才重推；cleanup=false 之后 jar 会留在设备上，正常情况只推一次）。 */
export async function ensureServerPushed({ adbPath, serial, jar, remotePath = '/data/local/tmp/scrcpy-server' } = {}) {
  const src = jar || resolveServerJar();
  if (!src) throw new Error('找不到 scrcpy-server；可用 DSH_SCRCPY_SERVER 指定，或放到插件 vendor/ 里');
  const size = statSync(src).size;
  const probe = await adbRun(['shell', `ls -l ${remotePath}`], { serial, adbPath, timeoutMs: 15000 });
  if (probe.ok && probe.text.includes(String(size))) return { pushed: false, path: src, size };
  const r = await adbRun(['push', src, remotePath], { serial, adbPath, timeoutMs: 120000 });
  if (!r.ok) throw new Error(`push scrcpy-server 失败: ${r.stderr || r.text || r.err}`);
  return { pushed: true, path: src, size };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * 解析流头；返回 {codecId, marker, width, height, dataStart, name, layout} / {need:true} / {error}
 * base=1（forward，含 1 字节 dummy）/ base=0（reverse，无 dummy）。
 * 布局判定用「包头的 size 能否对上 payload 起始码」，避免只靠常数。
 */
function packetLooksValid(buf, start) {
  if (buf.length < start + 16) return null; // 数据不够，先不定
  const size = buf.readUInt32BE(start + 8);
  if (size <= 0 || size > 8_000_000) return false;
  if (buf.length < start + 12 + 8) return null;
  const p = start + 12;
  const sc4 = buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 0 && buf[p + 3] === 1;
  const sc3 = buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1;
  return sc4 || sc3;
}

export function parseStreamHeader(buf, { base = 1 } = {}) {
  if (buf.length < base + 64) return null;
  const name = buf.subarray(base, base + 64).toString('utf8').replace(/\0.*$/, '');
  if (buf.length < base + 80) return { need: true, name };
  const codecId = buf.readUInt32BE(base + 64);
  const hasMeta = (buf.readUInt32BE(base + 68) >>> 31) === 1; // 0x80000000 = 本包带 session meta（v5.0）
  const layouts = hasMeta
    ? [{ dataStart: base + 80, marker: buf.readUInt32BE(base + 68), width: buf.readUInt32BE(base + 72), height: buf.readUInt32BE(base + 76), layout: `v5-${base ? 'dummy' : 'noDummy'}` }]
    : [
      { dataStart: base + 80, marker: buf.readUInt32BE(base + 68), width: buf.readUInt32BE(base + 72), height: buf.readUInt32BE(base + 76), layout: `v5-${base ? 'dummy' : 'noDummy'}` },
      { dataStart: base + 76, marker: 0, width: buf.readUInt32BE(base + 68), height: buf.readUInt32BE(base + 72), layout: `v4-${base ? 'dummy' : 'noDummy'}` },
    ];
  let undecided = false;
  for (const l of layouts) {
    const san = l.width > 0 && l.height > 0 && l.width < 20000 && l.height < 20000;
    if (!san) continue;
    const v = packetLooksValid(buf, l.dataStart);
    if (v === true) return { codecId, name, ...l };
    if (v === null) undecided = true;
  }
  if (undecided) return { need: true, name };
  return { error: `无法识别流头: codec=0x${codecId.toString(16)} u32@68=0x${buf.readUInt32BE(base + 68).toString(16)} u32@72=${buf.readUInt32BE(base + 72)} u32@76=${buf.readUInt32BE(base + 76)}`, name };
}

export const PACKET_FLAG_CONFIG = 0x4000000000000000n;
export const PACKET_FLAG_KEY = 0x2000000000000000n;
export const PACKET_PTS_MASK = 0x1fffffffffffffffn;

/** 从 buf 里切出完整包；返回 {packets:[{pts,size,config,key,data}], rest:Buffer} */
export function splitPackets(buf, dataStart = 0) {
  const packets = [];
  let off = dataStart || 0;
  while (off + 12 <= buf.length) {
    const raw = buf.readBigUInt64BE(off);
    const size = buf.readUInt32BE(off + 8);
    if (size <= 0 || size > 8_000_000 || off + 12 + size > buf.length) break;
    packets.push({
      pts: Number(raw & PACKET_PTS_MASK),
      size,
      config: (raw & PACKET_FLAG_CONFIG) !== 0n,
      key: (raw & PACKET_FLAG_KEY) !== 0n,
      data: buf.subarray(off + 12, off + 12 + size),
    });
    off += 12 + size;
  }
  return { packets, rest: buf.subarray(off) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** server 版本探测很贵（要起一次 app_process 等它报错退出），同一条 adb 只探一次就缓存 */
let cachedServerVersion = '';

/** 规范化 scid：必须是 ≤ 0x7fffffff 的 1~8 位十六进制字符串（server 用 Integer.parseInt(value,16)） */
export function normalizeScid(scid) {
  return /^[0-9a-fA-F]{1,8}$/.test(String(scid ?? '')) && parseInt(String(scid), 16) <= 0x7fffffff
    ? String(scid).toLowerCase().padStart(8, '0')
    : Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
}

/**
 * 起一条 scrcpy 会话（视频流 + 可选控制通道）。
 *
 * @param {object} opts
 * @param {boolean} [opts.control=false] true = 同时也接收控制 socket（server 会按 video→control 顺序连第二遍）
 * @param {'reverse'|'forward'|'auto'} [opts.tunnel='auto'] 连接方向；auto = 先 reverse，失败退 forward
 * @param {boolean} [opts.cleanupScrcpy=true] false = 不传 CleanUp 选项，jar 保留在设备上（快、省一次 push）
 * @returns {Promise<object>} {width,height,name,codec,version,port,tunnel,stats,controlSocket,serverLog,onPacket,onClose,onExit,stop}
 */
/**
 * 进程退出时的同步兜底：把设备上残留的 scrcpy-server（进程名是 app_process）杀掉。
 * 只在我们的会话还在跑时才调（见 index.js 的 onExit）—— 否则会把别人开的 scrcpy/QtScrcpy 一起杀掉。
 */
export function killStrayServerSync({ adbPath, serial, timeoutMs = 4000 } = {}) {
  try {
    const args = [...(serial ? ['-s', String(serial)] : []), 'shell', 'pkill', '-f', 'com.genymobile.scrcpy.Server'];
    spawnSync(adbPath || resolveAdb() || 'adb', args, { stdio: 'ignore', timeout: timeoutMs, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 清掉设备侧残留的 scrcpy 反向映射（`adb reverse --list` 里 `localabstract:scrcpy_*` 的那些）。
 * 为什么需要：正常关会话时会清映射，但探针崩溃 / 宿主被强杀时不会，于是一条条攒下来
 * （本机实测攒到 22 条）。只动 `scrcpy_*`，绝不碰用户自己的 reverse 规则。
 * 返回**真正**被移除的端口数组（`adb reverse --remove` 用错 spec 会返回 1，必须看状态）。
 *
 * 坑 13：`adb reverse --remove` 只认 **device 侧那个 spec**，即 `localabstract:scrcpy_xxxx`；
 * 拿 `tcp:PORT` 去删会报 `error: listener 'tcp:3522' not found` 且**什么都不删**。
 * （`adb forward` 是反的，`--remove tcp:PORT` 才对。）
 */
export function sweepScrcpyReverseSync({ adbPath, serial, keepPort = null, timeoutMs = 4000 } = {}) {
  const removed = [];
  try {
    const bin = adbPath || resolveAdb() || 'adb';
    const serialArgs = serial ? ['-s', String(serial)] : [];
    const r = spawnSync(bin, [...serialArgs, 'reverse', '--list'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (r.status !== 0) return removed;
    for (const line of String(r.stdout || '').split('\n')) {
      const m = /(localabstract:scrcpy_\S+)\s+tcp:(\d+)/i.exec(line.trim());
      if (!m) continue;
      const spec = m[1];
      const port = Number(m[2]);
      if (keepPort && port === Number(keepPort)) continue;
      const d = spawnSync(bin, [...serialArgs, 'reverse', '--remove', spec], { stdio: 'ignore', timeout: timeoutMs, windowsHide: true });
      if (d.status === 0) removed.push(port);
    }
  } catch {
    /* 尽力而为 */
  }
  return removed;
}

export async function startVideoStream(opts = {}) {
  const {
    adbPath = resolveAdb(), jar, maxSize = DEFAULT_VIDEO.maxSize, bitRate = DEFAULT_VIDEO.bitRate,
    maxFps = DEFAULT_VIDEO.maxFps, videoCodec = DEFAULT_VIDEO.videoCodec, scid, port: wantPort,
    keyFrameInterval = DEFAULT_VIDEO.keyFrameInterval, codecOptions = '',
    startTimeoutMs = DEFAULT_VIDEO.startTimeoutMs, log = () => {}, remotePath = '/data/local/tmp/scrcpy-server',
    control = false, tunnel = 'auto', cleanupScrcpy = true, logLevel = 'warn', skipPush = false,
  } = opts;
  const t0 = Date.now();
  const mark = (label) => log(`${label}（${Date.now() - t0}ms）`);
  // 没给 serial 就自动挑（恰好一台，否则抛带指引的错误）
  const serial = opts.serial || (await pickDevice(undefined, adbPath)).serial;

  if (!skipPush) {
    await ensureServerPushed({ adbPath, serial, jar, remotePath });
    mark('server 就位');
  }
  const version = opts.version || cachedServerVersion
    || await detectServerVersion({ adbPath, serial, remotePath });
  if (version && !cachedServerVersion) cachedServerVersion = version;
  mark(`版本 ${version} 就绪`);

  const scidHex = normalizeScid(scid);
  const socketName = 'scrcpy_' + scidHex;
  const port = wantPort || await freePort();
  mark(`scid=${scidHex} socket=${socketName} port=${port}`);

  // i-frame-interval 是 MediaCodec 的标准键，理论上能让编码器每秒吐一个 IDR，迟到订阅者不用干等。
  const codecOptString = [codecOptions, keyFrameInterval > 0 ? `i-frame-interval:int=${keyFrameInterval}` : '']
    .filter(Boolean).join(',');

  const base = { serial, adbPath, version, remotePath, scidHex, socketName, port,
    maxSize, maxFps, bitRate, videoCodec, codecOptString, control, startTimeoutMs, cleanupScrcpy, logLevel, mark, log,
    killStray: true };
  const mode = tunnel === 'auto' ? 'reverse' : tunnel;
  const attempt = await openSession({ ...base, mode });
  if (!attempt.ok && mode === 'reverse' && tunnel === 'auto') {
    log(`[video] reverse 模式失败（${attempt.error}），回落 forward 模式（慢且长跑不稳，仅兜底）`);
    const fb = await openSession({ ...base, mode: 'forward' });
    if (!fb.ok) throw new Error(`scrcpy 会话启动失败（reverse: ${attempt.error}；forward: ${fb.error}）`);
    return fb.session;
  }
  if (!attempt.ok) throw new Error(`scrcpy 会话启动失败（${mode}: ${attempt.error}）`);
  return attempt.session;
}

/** 一次连接尝试（含 server 进程生命周期）。成功返回 {ok:true, session}，失败返回 {ok:false, error} */
async function openSession(ctx) {
  const { mode, serial, adbPath, version, remotePath, scidHex, socketName, port: startPort,
    maxSize, maxFps, bitRate, videoCodec, codecOptString, control, startTimeoutMs, cleanupScrcpy, logLevel, mark, log } = ctx;
  const reverse = mode === 'reverse';
  const base = reverse ? 0 : 1;            // 流头里的 dummy 字节：只有 forward 有
  const expected = control ? 2 : 1;
  let port = startPort;

  // 1) 连接载体：reverse 先在宿主侧监听，forward 直接由 adb forward 打开
  let listener = null;
  let accepted = [];
  let acceptWaiters = [];
  if (reverse) {
    listener = createServer((s) => {
      // 交互式画面禁用 Nagle：否则小帧会被攒到 40ms 再发（本地环回同样适用）。
      try { s.setNoDelay(true); } catch { /* ignore */ }
      accepted.push(s);
      acceptWaiters.forEach((w) => w());
      acceptWaiters = [];
    });
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    port = listener.address().port;
  }

  const serverArgs = ['shell', `CLASSPATH=${remotePath}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', version,
    `log_level=${logLevel}`, 'audio=false', `control=${control ? 'true' : 'false'}`,
    `tunnel_forward=${reverse ? 'false' : 'true'}`,
    `send_dummy_byte=${reverse ? 'false' : 'true'}`,
    ...(cleanupScrcpy ? [] : ['cleanup=false']),
    `max_size=${maxSize}`, `max_fps=${maxFps}`, `video_bit_rate=${bitRate}`, `video_codec=${videoCodec}`,
    ...(codecOptString ? [`video_codec_options=${codecOptString}`] : []),
    'send_frame_meta=true', `scid=${scidHex}`];

  const child = spawn(adbPath, ['-s', String(serial), ...serverArgs], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  mark('已拉起 server 进程');
  let serverLog = '';
  let exitInfo = null;
  const exitCbs = [];
  child.stdout.on('data', (d) => { serverLog += d.toString('latin1'); });
  child.stderr.on('data', (d) => { serverLog += d.toString('latin1'); });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal, at: Date.now() };
    exitCbs.forEach((cb) => { try { cb(exitInfo); } catch { /* ignore */ } });
    // 进程一死，accept 等待立刻结束（否则会白等到超时）
    acceptWaiters.forEach((w) => w());
    acceptWaiters = [];
  });

  const cleanup = async () => {
    try { child.kill(); } catch { /* ignore */ }
    if (listener) { try { listener.close(); } catch { /* ignore */ } }
    for (const s of accepted) { try { s.destroy(); } catch { /* ignore */ } }
    accepted = [];
    // 坑 13：reverse 的 --remove 只认 device 侧 spec（localabstract:...），用 tcp:PORT 删不掉；两种都试
    if (reverse) {
      await adbRun(['reverse', '--remove', `localabstract:${socketName}`], { serial, adbPath, timeoutMs: 10000 }).catch(() => {});
      await adbRun(['reverse', '--remove', `tcp:${port}`], { serial, adbPath, timeoutMs: 10000 }).catch(() => {});
    } else await adbRun(['forward', '--remove', `tcp:${port}`], { serial, adbPath, timeoutMs: 10000 }).catch(() => {});
    if (ctx.killStray) await adbRun(['shell', 'pkill -f com.genymobile.scrcpy.Server'], { serial, adbPath, timeoutMs: 10000 }).catch(() => {});
  };
  const fail = async (error) => { await cleanup(); return { ok: false, error }; };

  // 2) 建立映射（先扫掉上轮崩溃残留的 scrcpy 反向映射，否则会一条条攒下来）
  if (reverse) {
    const swept = sweepScrcpyReverseSync({ adbPath, serial, keepPort: port });
    if (swept.length) log.info?.(`清掉 ${swept.length} 条残留的 scrcpy 反向映射: ${swept.join(', ')}`);
    const r = await adbRun(['reverse', `localabstract:${socketName}`, `tcp:${port}`], { serial, adbPath, timeoutMs: 10000 });
    if (!r.ok) return fail(`adb reverse 失败: ${r.stderr || r.text || r.err}`);
    mark('adb reverse 就绪');
  }

  // 3) 等连接：reverse 等 server 主动 connect（video 先、control 后，且都在设备名/流头之前）
  const deadline = Date.now() + startTimeoutMs;
  let sock = null;
  let controlSocket = null;
  let lastErr = '';

  if (reverse) {
    while (Date.now() < deadline && accepted.length < expected && !exitInfo) {
      await new Promise((resolve) => {
        acceptWaiters.push(resolve);
        setTimeout(resolve, 250);
      });
    }
    if (exitInfo) return fail(`server 进程提前退出（exit=${exitInfo.code}）; ${serverLog.slice(0, 300)}`);
    if (accepted.length < expected) return fail(`等 server 连接超时（拿到 ${accepted.length}/${expected} 条）`);
    sock = accepted[0];
    controlSocket = accepted[1] || null;
    mark(`server 已连回（${accepted.length}/${expected} 条）`);
  } else {
    // forward：客户端主动连，server 起来需要时间，失败就重试
    while (Date.now() < deadline && !sock) {
      await adbRun(['forward', `tcp:${port}`, `localabstract:${socketName}`], { serial, adbPath, timeoutMs: 10000 });
      sock = await new Promise((resolve) => {
        const s = createConnection({ host: '127.0.0.1', port });
        try { s.setNoDelay(true); } catch { /* ignore */ }
        s.once('connect', () => resolve(s));
        s.once('error', (e) => { lastErr = e.message; try { s.destroy(); } catch { /* ignore */ } resolve(null); });
        setTimeout(() => { try { s.destroy(); } catch { /* ignore */ } resolve(null); }, 1200);
      });
      if (!sock) await sleep(250);
    }
    if (!sock) return fail(`TCP 连接超时（${lastErr || 'server 未监听'}）`);
    mark('TCP 连上（server 已在监听）');
    if (control && !exitInfo) {
      controlSocket = await new Promise((resolve) => {
        const s = createConnection({ host: '127.0.0.1', port });
        s.once('connect', () => resolve(s));
        s.once('error', () => resolve(null));
        setTimeout(() => { try { s.destroy(); } catch { /* ignore */ } resolve(null); }, 3000);
      });
    }
  }

  // 4) 读流头（control 连接也建立了 server 才会发设备名，所以这一步必须在 accept/connect 之后）
  const header = await new Promise((resolve) => {
    let acc = Buffer.alloc(0);
    const onData = (b) => {
      acc = Buffer.concat([acc, b]);
      const h = parseStreamHeader(acc, { base });
      if (h && !h.need && !h.error) { sock.off('data', onData); resolve({ header: h, acc }); }
      else if (h && h.error) { sock.off('data', onData); resolve({ error: h.error }); }
    };
    sock.on('data', onData);
    sock.once('error', (e) => resolve({ error: e.message }));
    // adb forward 会先接受 TCP 连接、若设备侧还没监听就**静默关掉**（只发 FIN，不报 error）。
    // reverse 模式下这条基本不会触发，但保留：server 起错/崩了会表现为连接断开。
    sock.once('end', () => resolve({ error: '连接被对端关闭（server 未监听或已退出）' }));
    sock.once('close', () => resolve({ error: '连接已关闭' }));
    setTimeout(() => resolve({ error: '流头超时' }), 8000);
  });
  if (header.error) return fail(header.error);

  const { header: h, acc } = header;
  mark(`流头就绪 ${h.width}x${h.height}（${h.layout}）`);

  // 5) 收流
  const stats = { packets: 0, config: 0, key: 0, bytes: 0, startedAt: Date.now(), firstPts: null, lastPts: null, lastPacketAt: Date.now() };
  // 迟到订阅者的起播材料：保留「最近的 config(SPS/PPS) + 最新关键帧及其后续帧」。
  // config 必须单独存：关键帧到来时 backlog 会被清空，config 若只在 backlog 里就会丢，
  // 新客户端拿到「关键帧但没有 SPS/PPS」→ 解码器建不起来（表现为黑屏/花屏）。
  const backlog = [];
  let lastConfig = null;
  let backlogBytes = 0;
  const BACKLOG_MAX = 6 * 1024 * 1024;
  let rest = acc.subarray(h.dataStart);
  let onPacket = null;
  let onClose = null;
  const trimBacklog = () => {
    while (backlogBytes > BACKLOG_MAX && backlog.length > 1) {
      const dropped = backlog.shift();
      backlogBytes -= dropped.size;
    }
  };
  const drain = () => {
    const { packets: ps, rest: r } = splitPackets(rest, 0);
    rest = r;
    for (const p of ps) {
      stats.packets++;
      if (p.config) stats.config++;
      if (p.key) stats.key++;
      stats.bytes += p.size;
      stats.lastPacketAt = Date.now();
      if (!p.config) { if (stats.firstPts === null) stats.firstPts = p.pts; stats.lastPts = p.pts; }
      if (p.config) lastConfig = p;
      if (p.key) { backlog.length = 0; backlogBytes = 0; }       // 新关键帧 = 新的起播点（config 单独留）
      backlog.push(p); backlogBytes += p.size; trimBacklog();
      if (onPacket) { try { onPacket(p); } catch { /* ignore */ } }
    }
  };
  drain();
  sock.on('data', (b) => { rest = Buffer.concat([rest, b]); drain(); });
  sock.once('close', () => { if (onClose) onClose(); });
  if (listener) { try { listener.close(); } catch { /* ignore */ } listener = null; }
  log(`[video] 流已连上 ${h.name} ${h.width}x${h.height} scrcpy-server ${version} ${mode} port=${port}${controlSocket ? ' (+control)' : ''}`);

  const session = {
    width: h.width, height: h.height, name: h.name, codec: h.codecId, version, port, tunnel: mode, layout: h.layout, stats,
    controlSocket,
    backlogPackets: () => backlog.length,
    backlogBytes: () => backlogBytes,
    serverLog: () => serverLog,
    pid: child.pid,
    exited: () => exitInfo,
    /** 注册消费回调；replay=true 时先把 backlog（config+关键帧+后续帧）回放给你，保证能立刻解码 */
    onPacket: (cb, { replay = false } = {}) => {
      if (replay) {
        if (lastConfig) { try { cb(lastConfig); } catch { /* ignore */ } }
        for (const p of backlog) { try { cb(p); } catch { /* ignore */ } }
      }
      onPacket = cb;
    },
    onClose: (cb) => { onClose = cb; },
    onExit: (cb) => { if (exitInfo) { try { cb(exitInfo); } catch { /* ignore */ } } else exitCbs.push(cb); },
    stop: async () => { try { sock.destroy(); } catch { /* ignore */ } try { controlSocket?.destroy(); } catch { /* ignore */ } await cleanup(); },
  };
  return { ok: true, session };
}

export { sleep };
