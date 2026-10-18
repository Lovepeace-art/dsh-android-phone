/**
 * dsh-android-phone —— 宿主半边。
 *
 * 职责（与网页版插件同一套思路：能力在宿主，插件只做眼睛和手）：
 *  1) 给模型一组 phone_* 工具：状态 / 应用列表 / 打开 App / 截屏 / 长截图 / 控件树 / 动作注入 / 文字输入 / 视频流控制
 *  2) 给侧栏 client 一组 HTTP 接口：/status /video(H.264 帧流) /snapshot /open /action /shot /inspect /apps /stream
 *
 * 注意（宿主半边铁律）：
 *  - 这里**不能** `import '@deepseek-ai/*'`（profile 插件解析不到，一个缺失具名 import 会打挂整个 boot）；
 *    一律用 ctx.get('tools') / ctx.inject(['webServer'], cb) 结构化访问，并整体 try/catch。
 *  - 所有工具返回值都要过 jsonSafe()：DSH 的工具输出校验（walkJsonValue）会把含 undefined 的返回值判为
 *    "value is not lossless JSON"，而 JSON.stringify 与假 ctx 测试都发现不了。
 *  - 改完这个文件必须重启 DSH 才会生效（替换已装包要换 JS 模块代数）；client.js 改动只要硬刷新。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  adbVersion, currentFocus, deviceProps, healAdb, keyevent, launchApp, listDevices, listPackages, longPress,
  pickDevice, resolveAdb, screenMetrics, screencap, scrollByScreen, swipe, tap, typeText, uiDump, wake,
} from './src/android/adb.js';
import { ensureForeground, listActions, runAction, runActions, validateAction } from './src/android/actions.js';
import { androidLongshot, androidShot, scrollToTop } from './src/android/longshot.js';
import { DEFAULT_VIDEO, resolveServerJar, killStrayServerSync, sweepScrcpyReverseSync } from './src/android/video.js';
import {
  configure as configureSession, ensureSession, stopSession, sessionInfo, getControl, getOwner, setOwner,
  onSessionEvent, touchActivity, addSubscriber, shutdown as shutdownSession, assertAiAllowed, ownerInfo,
  readDeviceClipboard, writeDeviceClipboard, deviceClipboard,
} from './src/android/session.js';
import { createImageAttacher, jsonSafe } from './src/core/attach.js';
import { checkStitchQuality } from './src/core/quality.js';
import { decodePng, encodePng, pngSize } from './src/core/png.js';

export const name = 'dsh-android-phone';

const PREFIX = '/dsh-android-phone/api';
const FRAME_HEADER = 13; // 4 字节长度 + 1 字节 flag + 8 字节 pts

/**
 * 设备信息缓存（坑 18，2026-10-16）—— 「鼠标点完一会手机才动」的直接原因。
 *
 * 实测（真实宿主、控制通道已就绪）：`POST /action` 的**固定开销 520~580ms**，其中没有一次触摸注入，
 * 全是动作之前的 adb 往返 —— `pickDevice`(adb devices ~57ms) + `screenMetrics`(wm size/wm density/
 * dumpsys window ~190ms) + `currentFocus`(dumpsys ~150ms)，而控制通道写一条 INJECT_TOUCH_EVENT 只要 ~100µs。
 * 也就是 99% 的延迟花在「问手机自己是谁」上，人点击的手感就是被这个吃掉的。
 *
 * 所以：① 有控制会话时直接用会话里的 serial（一个 adb 都不问）；② 其余缓存 20s；
 * ③ 控制通道的坐标换算用它自带的 video 尺寸（坑 8），根本不需要 screenMetrics；
 * ④ 人（`by='human'`）的动作不回读 currentFocus。缓存失效：动作报错 / 超过 TTL。
 *
 * ⚠️ 必须放模块级：`buildToolDefs` 每个 HTTP 请求都会重新执行（`buildToolset()`），
 * 缓存写进函数体就等于每请求一个空缓存（第一版实测 270ms 毫无改善）。
 */
const MODULE_DEVICE_CACHE = { serial: null, metrics: null, devices: null, at: 0, devicesAt: 0 };
const DEVICE_TTL_MS = 20_000;
const DEVICES_TTL_MS = 1_500;
const invalidateDevice = () => {
  MODULE_DEVICE_CACHE.at = 0;
  MODULE_DEVICE_CACHE.serial = null;
  MODULE_DEVICE_CACHE.metrics = null;
};

/**
 * 侧栏「截图机」的长截图状态（模块级，理由同上面的 MODULE_DEVICE_CACHE）。
 * 为什么要它：旧的长截图是一次 16 秒的阻塞调用，期间界面没有任何反馈，用户以为卡死、
 * 也停不下来。现在改成「立刻返回 + 轮询进度 + 随时能停」：
 *   POST /shot {mode:'long', op:'start'} → 启动，立刻返回
 *   GET  /longshot                      → {running, frames, height, ms, result}
 *   POST /shot {mode:'long', op:'stop'} → 置停止位，已拼好的部分照样保存
 */
const MODULE_LONGSHOT = {
  running: false, stopRequested: false, startedAt: 0, frames: 0, height: 0,
  error: null, result: null,
};

/**
 * 长截图的对外入口（给 HTTP 路由用）。
 * 为什么要有这个桥：longshotInfo/startLongshot/stopLongshot 定义在 buildToolDefs 里面
 * （它们要用到 takeLongshot 的闭包），而路由处理函数在 apply 里 —— 两个作用域互不可见，
 * 直接调用就会 `startLongshot is not defined`（2026-10-17 用户实测的报错）。
 * buildToolDefs 每次构建时把这三个函数挂到这里，路由侧通过 LONG_SHOT_API 调。
 */
let LONG_SHOT_API = null;

const DEFAULT_CONFIG = {
  defaultSerial: '',
  adbPath: '',
  scrcpyServer: '',
  shotsDir: '',
  /** 没订阅者且没人/模型操作时，多久停会话（省编码器；0 = 不停，跟随侧栏一直开着） */
  idleStopMs: 45_000,
  /** 人在侧栏接管控制权后，静默多久自动交还模型（0 = 不自动交还） */
  humanHoldMs: 90_000,
  video: { ...DEFAULT_VIDEO },
};

/**
 * 画质档位（侧栏下拉用）。maxSize 是**长边**像素上限：这台真机是 1080x2400，
 * 所以 1800 → 810x1800，2400 → 原始 1080x2400。bitRate 跟着像素走，不然高分辨率会糊。
 */
const VIDEO_PRESETS = [
  // maxFps 统一 60（2026-10-18 与 client.js 的 QUALITY 对齐）：手机屏本身 60Hz，
  // 实测 808x1800@60 → 56fps / 4.1Mbps，1080x2400@60 → 58fps / 6.9Mbps，
  // 顺滑度靠的就是这 60 帧，代价约 +30% 码率。
  { id: 'eco', label: '省流', maxSize: 1200, bitRate: 2_500_000, maxFps: 60 },
  { id: 'std', label: '标准', maxSize: 1800, bitRate: 4_000_000, maxFps: 60 },
  { id: 'hd', label: '高清', maxSize: 2400, bitRate: 8_000_000, maxFps: 60 },
];

/* ------------------------------------------------------------------ 小工具 */

function makeLogger(ctx) {
  const logger = (() => {
    try { return ctx.logger; } catch { return undefined; }
  })();
  const line = (level, msg) => {
    const text = `[android-phone] ${msg}`;
    try {
      if (logger && typeof logger[level] === 'function') logger[level](text);
      else if (level === 'error') console.error(text);
      else console.log(text);
    } catch { /* ignore */ }
  };
  return { info: (m) => line('info', m), warn: (m) => line('warn', m), error: (m) => line('error', m) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 设置（侧栏「⚙ 设置」页；落盘 ~/.dsh/android-phone/settings.json） ----------------
// 只放「用户可改」的少量项。优先级：设置文件 > 插件 config > 环境变量 > 默认。
const SETTINGS_CLEANUP_CHOICES = ['off', '1', '3', '7', '30'];   // off / 保留 N 天
const SETTINGS_DEFAULT = { shotsDir: "", cleanup: "7" };
let SETTINGS_CACHE = null;
function settingsFile() { return join(homedir(), ".dsh", "android-phone", "settings.json"); }
function readSettings() {
  if (SETTINGS_CACHE) return SETTINGS_CACHE;
  let raw = {};
  try { raw = JSON.parse(readFileSync(settingsFile(), "utf8")) || {}; } catch { raw = {}; }
  const s = { ...SETTINGS_DEFAULT, ...(raw && typeof raw === "object" ? raw : {}) };
  if (typeof s.shotsDir !== "string") s.shotsDir = "";
  if (!SETTINGS_CLEANUP_CHOICES.includes(String(s.cleanup))) s.cleanup = SETTINGS_DEFAULT.cleanup;
  SETTINGS_CACHE = s;
  return s;
}
function writeSettings(patch) {
  const cur = { ...readSettings() };
  const p = patch && typeof patch === "object" ? patch : {};
  if ("shotsDir" in p) cur.shotsDir = String(p.shotsDir == null ? "" : p.shotsDir).trim();
  if ("cleanup" in p) cur.cleanup = SETTINGS_CLEANUP_CHOICES.includes(String(p.cleanup)) ? String(p.cleanup) : cur.cleanup;
  try {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(cur, null, 2) + "\n", "utf8");
  } catch { /* 落盘失败不影响本次生效 */ }
  SETTINGS_CACHE = cur;
  return cur;
}
function shotsRoot(cfg) {
  const s = readSettings();
  if (s.shotsDir) return s.shotsDir;
  if (cfg && cfg.shotsDir) return cfg.shotsDir;
  if (process.env.DSH_PHONE_SHOTS) return process.env.DSH_PHONE_SHOTS;
  return join(homedir(), ".dsh", "android-phone", "shots");
}

// 只删「我们自己产出的截图」：文件名以 2026-10-16T23-06-49 这种时间戳开头，且是 .png 或无扩展名。
// 别的文件（.json 旁注、用户自己放的东西）一律不碰。
function cleanupShots({ force = false } = {}) {
  const dir = shotsRoot({});
  const days = Number(readSettings().cleanup);
  if (!force && (!Number.isFinite(days) || days <= 0)) return { skipped: true, dir, days: 0 };
  if (!existsSync(dir)) return { removed: 0, kept: 0, dir, days };
  const cutoff = Date.now() - days * 86400000;
  let removed = 0, kept = 0, bytes = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/^\d{4}-\d{2}-\d{2}T[\d-]+/.test(e.name)) continue;
      const hasExt = /\.[a-z0-9]{1,5}$/i.test(e.name);
      if (hasExt && !/\.png$/i.test(e.name)) continue;
      let st; try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs >= cutoff) { kept += 1; continue; }
      try { rmSync(p, { force: true }); removed += 1; bytes += st.size; } catch { kept += 1; }
    }
  };
  walk(dir);
  return { removed, kept, bytes, dir, days };
}
let LAST_CLEANUP_MS = 0;
function maybeCleanupShots() {
  if (Date.now() - LAST_CLEANUP_MS < 6 * 3600 * 1000) return;
  LAST_CLEANUP_MS = Date.now();
  try { cleanupShots(); } catch { /* 清理失败绝不影响截图 */ }
}

// skill 索引（只读）：扫插件包里的 skills/<id>/SKILL.md，抽 frontmatter 的 name/description
function listSkills() {
  const root = join(PLUGIN_ROOT, "skills");
  const out = [];
  let ents = [];
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return { dir: root, skills: [] }; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const md = join(root, e.name, "SKILL.md");
    if (!existsSync(md)) continue;
    let text = "";
    try { text = readFileSync(md, "utf8"); } catch { continue; }
    const name = (/^name:\s*(.+)$/m.exec(text) || [])[1] || e.name;
    let desc = (/^description:\s*(.+)$/m.exec(text) || [])[1] || "";
    if (!desc) {
      const body = text.replace(/^---[\s\S]*?---/, "").trim();
      desc = body.split("\n").filter((l) => l.trim())[0] || "";
    }
    out.push({ id: e.name, name: String(name).trim(), description: String(desc).trim().slice(0, 240), dir: join(root, e.name) });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return { dir: root, skills: out };
}
function revealDir(dir) {
  try {
    const p = spawnProcess("explorer.exe", [dir], { detached: true, stdio: "ignore" });
    p.unref();
    return true;
  } catch { return false; }
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function slugify(s, max = 60) {
  const out = String(s || 'shot').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/[^0-9A-Za-z._\u4e00-\u9fa5-]+/g, '').slice(0, max);
  return out || 'shot';
}

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * 读 actions/*.json 声明式动作表（借 QtScrcpy keymap 的口径：坐标一律 0~1 归一化）。
 * 一张表 = 一个 App 的「页面坐标字典」，侧栏和 skill 共用，换分辨率不用改表。
 * 表写坏了只跳过那一张，不能让插件起不来。
 */
function loadActionMaps(log) {
  const dir = join(PLUGIN_ROOT, 'actions');
  const maps = {};
  try {
    if (!existsSync(dir)) return maps;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const key = raw.name || f.replace(/\.json$/, '');
        const problems = Object.entries(raw.actions || {}).flatMap(([n, a]) => validateAction(n, a).map((p) => `${n} ${p}`));
        if (problems.length) { log.warn(`动作表 ${f} 有 ${problems.length} 处问题，已跳过：${problems.slice(0, 3).join('; ')}`); continue; }
        maps[key] = { name: key, key, app: raw.app || key, package: raw.package || '', screen: raw.screen || null, actions: raw.actions || {} };
      } catch (e) { log.warn(`动作表 ${f} 解析失败：${e.message}`); }
    }
  } catch (e) { log.warn(`actions 目录读取失败：${e.message}`); }
  return maps;
}

/* ------------------------------------------------------------------ 工具 */

function buildToolDefs(ctx, cfg, state, log) {
  const warn = log.warn;
  const attachPng = createImageAttacher({
    getService: () => state.attachments ?? (() => { try { return ctx.get('attachments'); } catch { return undefined; } })(),
    warn: (m) => warn(m),
  });

  /**
   * 设备信息缓存（坑 18，2026-10-16）—— 这是「鼠标点完一会手机才动」的直接原因。
   *
   * 实测（真实宿主，控制通道已就绪）：`POST /action` 的**固定开销 520~580ms**，
   * 里面没有一次触摸注入，全是动作之前的 adb 往返：`pickDevice`(adb devices) +
   * `screenMetrics`(wm size / wm density / dumpsys window) + `currentFocus`(dumpsys window)。
   * 而控制通道本身写一条 INJECT_TOUCH_EVENT 只要 ~100µs —— 也就是说 99% 的延迟花在「问手机自己是谁」上。
   *
   * 串号/分辨率/密度在一次会话里不会变，所以：
   *   ① 有控制会话时直接用它带的 serial（一次 adb 都不问）；
   *   ② 其余情况缓存 20s；
   *   ③ 控制通道的坐标换算用它自带的 video 尺寸（坑 8），根本不需要 screenMetrics。
   * 缓存失效：命令报设备错、拔插设备、或超过 TTL。
   * 注意：**缓存必须放模块级**（见文件上方 `deviceCache`）。`buildToolDefs` 是**每个 HTTP 请求现场调一次**的
   * （`buildToolset()`），把缓存写在函数体里等于每请求一个空缓存 —— 我第一版就是这么写的，
   * 实测 `POST /action {wait}` 仍然稳定 270ms 没变，才回头发现。
   */
  const deviceCache = MODULE_DEVICE_CACHE; // 模块级缓存（跨请求共享）

  const resolveSerial = async (serial) => {
    const explicit = serial || cfg.defaultSerial || '';
    if (explicit) return String(explicit);
    const sess = sessionInfo();
    if (sess && sess.running && sess.serial) return sess.serial; // 会话里就有，别再问 adb
    if (deviceCache.serial && Date.now() - deviceCache.at < DEVICE_TTL_MS) return deviceCache.serial;
    const hit = await pickDevice(undefined, cfg.adbPath || undefined);
    deviceCache.serial = hit.serial;
    deviceCache.at = Date.now();
    return hit.serial;
  };

  /** 设备像素尺寸（缓存）。注意：控制通道要的是 video 尺寸，别把这个喂给 ctl（坑 8）。 */
  const metricsFor = async (serial, { fresh = false } = {}) => {
    if (!fresh && deviceCache.metrics && Date.now() - deviceCache.at < DEVICE_TTL_MS) return deviceCache.metrics;
    const m = await screenMetrics(serial, { adbPath: cfg.adbPath });
    deviceCache.metrics = m;
    deviceCache.at = Date.now();
    return m;
  };

  /** `adb devices` 列表（短缓存，给每 5s 轮询一次的 /status 省事）。 */
  const listDevicesCached = async ({ fresh = false } = {}) => {
    if (!fresh && deviceCache.devices && Date.now() - deviceCache.devicesAt < DEVICES_TTL_MS) return deviceCache.devices;
    const d = await listDevices(cfg.adbPath || undefined);
    deviceCache.devices = d;
    deviceCache.devicesAt = Date.now();
    return d;
  };

  const withImage = (value) => {
    const blocks = [{ type: 'text', text: JSON.stringify(jsonSafe({ ...value, image: undefined }), null, 1) }];
    if (value && value.image) {
      const extra = value.image.preview
        ? `\n（附件是缩小到 ${value.image.preview.width}x${value.image.preview.height} 的预览；完整原图见上面的 path）`
        : '';
      blocks[0].text += extra;
      blocks.push({ type: 'image', attachment: value.image });
    }
    return blocks;
  };

  const takeShot = async (args = {}) => {
    const serial = await resolveSerial(args.serial);
    const metrics = await metricsFor(serial);
    const dir = args.outDir || shotsRoot(cfg);
    mkdirSync(dir, { recursive: true });
    const png = join(dir, `${timestamp()}-${slugify(args.name || 'screen')}.png`);
    const shot = await androidShot(serial, png, { adbPath: cfg.adbPath, metrics });
    const image = await attachPng(shot.path);
    return { ok: true, path: shot.path, bytes: shot.bytes, width: shot.width, height: shot.height, serial, image };
  };

  const takeLongshot = async (args = {}) => {
    const serial = await resolveSerial(args.serial);
    const metrics = await metricsFor(serial);
    const dir = args.outDir || shotsRoot(cfg);
    mkdirSync(dir, { recursive: true });
    // 长截图也必须带 .png：writeStitched 只把 .png 剥掉再拼 -pNN，扩展名不能指望调用方自觉。
    // （坑：侧栏长截图曾写出无后缀文件，用户改名后打不开/看错文件）
    const base = join(dir, `${timestamp()}-${slugify(args.name || 'long')}.png`);
    const res = await androidLongshot(serial, base, {
      adbPath: cfg.adbPath, metrics,
      maxSteps: Number(args.maxSteps) || 8,
      maxHeight: Number(args.maxHeight) || 22000,
      maskTop: args.maskTop, maskBottom: args.maskBottom,
      // 侧栏点「停止」时保留已拼好的部分（见 startLongshot）
      shouldStop: typeof args.shouldStop === 'function' ? args.shouldStop : undefined,
      onStep: (s) => {
        log.info(`长截图第 ${s.i} 步 dy=${s.dy} height=${s.height}`);
        if (typeof args.onStep === 'function') { try { args.onStep(s); } catch { /* ignore */ } }
      },
    });
    let quality = null;
    try {
      const img = decodePng(readFileSync(res.path));
      quality = checkStitchQuality(img);
    } catch (e) {
      warn(`长截图自检失败：${e.message}`);
    }
    const image = await attachPng(res.path);
    // 只截到一屏时要明说：用户看到"长截图和短截图一样高"会以为功能坏了，
    // 其实多半是页面已经到顶/到底、或这一屏根本不支持滑动（小程序页、弹层）。
    const accepted = (res.steps || []).filter((s) => s.accepted).length;
    const scrolledSteps = Math.max(0, accepted - 1);
    const warning = scrolledSteps === 0
      ? '页面没有滚动：已到顶/到底，或当前这一屏不支持滑动，所以只截到 1 屏'
      : null;
    return {
      ok: true, path: res.path, bytes: res.bytes, width: res.width, height: res.height, mode: res.mode,
      steps: res.steps, offsets: res.offsets, masks: res.masks, quality, serial, image,
      scrolledSteps, warning,
    };
  };

  /** 长截图进度（给 GET /longshot 轮询用） */
  const longshotInfo = () => ({
    running: MODULE_LONGSHOT.running,
    frames: MODULE_LONGSHOT.frames,
    height: MODULE_LONGSHOT.height,
    ms: MODULE_LONGSHOT.startedAt ? Date.now() - MODULE_LONGSHOT.startedAt : 0,
    error: MODULE_LONGSHOT.error,
    result: MODULE_LONGSHOT.result,
  });

  /**
   * 侧栏截图机的「长截图」：立刻返回，进度进 MODULE_LONGSHOT，随时可以停。
   * 与 takeLongshot 的区别只是不 await —— 模型工具 phone_longshot 仍然用阻塞版（它要结果当返回值）。
   */
  const startLongshot = (args = {}) => {
    if (MODULE_LONGSHOT.running) return { ok: true, already: true, ...longshotInfo() };
    MODULE_LONGSHOT.running = true;
    MODULE_LONGSHOT.stopRequested = false;
    MODULE_LONGSHOT.startedAt = Date.now();
    MODULE_LONGSHOT.frames = 0;
    MODULE_LONGSHOT.height = 0;
    MODULE_LONGSHOT.error = null;
    MODULE_LONGSHOT.result = null;
    const startedAt = MODULE_LONGSHOT.startedAt;
    takeLongshot({
      ...args,
      shouldStop: () => MODULE_LONGSHOT.stopRequested,
      onStep: (s) => {
        MODULE_LONGSHOT.frames = s.i + 1;
        MODULE_LONGSHOT.height = s.height || 0;
      },
    }).then((r) => {
      MODULE_LONGSHOT.result = {
        path: r.path, width: r.width, height: r.height, bytes: r.bytes, mode: r.mode,
        quality: r.quality, ms: Date.now() - startedAt,
        scrolledSteps: r.scrolledSteps, warning: r.warning,
      };
    }).catch((e) => {
      MODULE_LONGSHOT.error = String(e?.message || e);
    }).finally(() => {
      MODULE_LONGSHOT.running = false;
      MODULE_LONGSHOT.stopRequested = false;
    });
    return { ok: true, started: true, ...longshotInfo() };
  };

  const stopLongshot = () => {
    if (!MODULE_LONGSHOT.running) return { ok: true, running: false, ...longshotInfo() };
    MODULE_LONGSHOT.stopRequested = true;
    return { ok: true, stopping: true, ...longshotInfo() };
  };

  // 把入口挂到模块级，供 HTTP 路由使用（见 LONG_SHOT_API 的注释）
  LONG_SHOT_API = { info: longshotInfo, start: startLongshot, stop: stopLongshot };

  /** 把「一个动作」翻译成 actions.js 的规范化动作（坐标一律 0~1，宿主自己换算设备像素） */
  const toAction = (args = {}) => {
    const a = String(args.action || '').toLowerCase();
    const nx = args.nx ?? args.x;
    const ny = args.ny ?? args.y;
    if (a === 'tap') return { type: 'tap', at: [nx, ny] };
    if (a === 'long_press' || a === 'longpress') return { type: 'long_press', at: [nx, ny], ms: Number(args.ms) || 700 };
    if (a === 'swipe' || a === 'drag') return { type: 'drag', from: [nx, ny], to: [args.toNx ?? args.toX, args.toNy ?? args.toY], ms: Number(args.ms) || 320 };
    if (a === 'scroll') return { type: 'scroll', dir: args.dir === 'down' ? 'down' : 'up', pages: Number(args.pages) || 0.5 };
    if (a === 'wheel') {
      // 真滚轮（INJECT_SCROLL_EVENT）：`notches` 是滚轮格数，可为小数、可为负（负 = 往回滚）
      return { type: 'wheel', at: [nx ?? 0.5, ny ?? 0.5], notches: Number(args.notches) || 0, notchesH: Number(args.notchesH) || 0 };
    }
    if (a === 'touch') {
      // 逐事件触摸回放：侧栏鼠标拖拽就是这条（down/move/up 逐个过控制通道）
      const phase = ['down', 'move', 'up'].includes(args.phase) ? args.phase : 'down';
      // raw = 原始 action 码（双指缩放要 5/6 = POINTER_DOWN/POINTER_UP，见 actions.js 注释）
      const raw = Number.isFinite(Number(args.raw)) ? Number(args.raw) : undefined;
      const pointerId = Number.isFinite(Number(args.pointerId)) ? Number(args.pointerId) : undefined;
      return { type: 'touch', phase, at: [nx ?? 0.5, ny ?? 0.5], pointerId, raw };
    }
    if (a === 'key') return { type: 'key', key: args.key || 'BACK' };
    if (a === 'type' || a === 'text') return { type: 'text', text: String(args.text ?? '') };
    if (a === 'launch') return { type: 'launch', package: args.package || args.pkg };
    if (a === 'wait') return { type: 'wait', ms: Number(args.ms) || 500 };
    throw new Error(`不认识的动作 ${JSON.stringify(args.action)}（可用 tap/long_press/swipe/scroll/wheel/touch/key/type/launch/wait）`);
  };

  /**
   * 模型发动作前把会话拉起来。
   *
   * 为什么必须做：没有控制通道时 `runAction` 会**静默回落** `adb shell input`
   * （tap 约 300ms、scroll 约 670ms，中文直接抛错），对「模型自动跑」是灾难，
   * 而且模型看不到自己走的是哪条路（只能从 `via` 字段猜）。
   * 侧栏（人）不需要它：侧栏挂载时会自己 POST /session。
   */
  const ensureSessionForAi = async (args = {}) => {
    if (getControl()) return { started: false, reason: 'already-running' };
    const info = sessionInfo();
    if (info.running || info.starting) return { started: false, reason: 'starting' };
    const t0 = Date.now();
    try {
      await state.ensureStream({
        serial: args.serial,
        maxSize: Number(args.maxSize) || undefined,
        maxFps: Number(args.maxFps) || undefined,
        bitRate: Number(args.bitRate) || undefined,
      });
      log.info?.(`为模型动作预起会话成功（${Date.now() - t0}ms）：动作将走 scrcpy 控制通道`);
      return { started: true, ms: Date.now() - t0 };
    } catch (e) {
      log.warn?.(`为模型动作预起会话失败（${Date.now() - t0}ms），动作回落 adb shell input：${e?.message || e}`);
      return { started: false, reason: 'failed', error: String(e?.message || e) };
    }
  };

  const doAction = async (args = {}) => {
    const by = args.human ? 'human' : 'ai';
    // 侧栏（人）点按也在用同一条 /action：人点之前会先把控制权抢过来（client.js 里先 POST /takeover），
    // 所以这里按 human 处理不再做守门检查；模型走 ai 路径，人已接管时直接被拒。
    if (by !== 'human') assertAiAllowed();
    touchActivity();
    const serial = await resolveSerial(args.serial);
    if (args.action === 'wake') { await wake(serial, { adbPath: cfg.adbPath }); return { ok: true, action: 'wake', by }; }
    const sessionStart = by === 'human' ? null : await ensureSessionForAi(args);
    if (args.action === 'home') {
      const c = getControl();
      if (c) { const r = await c.keycode('home'); return { ok: true, action: 'home', by, via: 'control', ms: r?.ms ?? null, sessionStart }; }
      await keyevent(serial, 'HOME', { adbPath: cfg.adbPath });
      return { ok: true, action: 'home', by, via: 'adb', sessionStart };
    }
    const metrics = await (async () => {
      const c = getControl();
      // 有控制通道：坐标换算用它自带的 video 尺寸（坑 8），**一个 adb 都不用跑**
      if (c && c.available && c.screen && c.screen.width) return { width: c.screen.width, height: c.screen.height };
      return metricsFor(serial);
    })();
    const action = toAction(args);
    // 人的点击优先「手感」：不等 settle（模型才需要等 UI 稳定下来）
    const settleMs = by === 'human' ? 0 : (Number(args.settleMs) || 120);
    let step;
    try {
      step = await runAction(serial, metrics, action, { adbPath: cfg.adbPath, settleMs, by });
    } catch (e) {
      invalidateDevice(); // 很可能是设备不见了 —— 让下一次重新问 adb，别一直拿陈旧串号
      throw e;
    }
    // 人的动作不回读前台：那是一次 dumpsys（~130ms），而侧栏本来就不看这个字段（它读 /status）。
    // 模型的动作保留这个观测 —— 它需要「动作有没有落地」的证据。
    const fg = by === 'human' ? null : await currentFocus(serial, { adbPath: cfg.adbPath }).catch(() => null);
    return { ok: true, by, via: step?.via || null, step, sessionStart, foreground: fg ? { package: fg.package, activity: fg.activity } : undefined, screen: { width: metrics.width, height: metrics.height } };
  };

  const status = async (args = {}) => {
    const sess = sessionInfo();
    let devices = [];
    let adbError = null;
    try {
      devices = await listDevicesCached();
    } catch (e) {
      adbError = String(e?.message || e);
    }
    const online = devices.filter((d) => d.state === 'device');
    let serial = args.serial || cfg.defaultSerial || '';
    if (!serial && online.length === 1) serial = online[0].serial;
    const out = {
      ok: true,
      adbPath: cfg.adbPath || resolveAdb() || null,
      devices: devices.map((d) => ({ serial: d.serial, state: d.state, label: d.label, model: d.model })),
      serial: serial || null,
      ready: !!serial,
      video: sess.running
        ? {
          running: true, width: sess.width, height: sess.height, name: sess.deviceName, version: sess.version,
          tunnel: sess.tunnel, clients: sess.subscribers, maxSize: sess.maxSize, maxFps: sess.maxFps,
          bitRate: sess.bitRate, stats: sess.stats || {},
        }
        : { running: false, clients: 0, maxSize: sess.maxSize, maxFps: sess.maxFps, bitRate: sess.bitRate },
      // 会话与控制权（人 = 宿主/侧栏点击；ai = 模型）：
      // 规则 —— ai 优先，但人随时可以抢（/takeover），抢了之后 ai 的动作会被守门人拒绝，直到 /owner 交还。
      session: {
        running: sess.running, starting: sess.starting, tunnel: sess.tunnel, control: sess.control,
        serial: sess.serial, width: sess.width, height: sess.height, deviceName: sess.deviceName,
        version: sess.version, maxSize: sess.maxSize, maxFps: sess.maxFps, bitRate: sess.bitRate,
        stats: sess.stats || null,
        subscribers: sess.subscribers, startedAt: sess.startedAt, restarts: sess.restarts,
        idleMs: sess.idleMs, idleStopMs: cfg.idleStopMs || null, lastExit: sess.lastExit,
      },
      owner: sess.owner,
      control: sess.control,
      // 剪贴板（手机 → 电脑方向）：面板轮询 /status 时发现 `at` 变了就把文本写进系统剪贴板。
      // 服务端 autosync 默认开着，手机上复制任何东西都会主动推给我们（见 session.js）。
      clipboard: deviceClipboard(),
      videoPresets: VIDEO_PRESETS,
      scrcpyServer: resolveServerJar(cfg.scrcpyServer || undefined),
      shotsDir: shotsRoot(cfg),
      actions: Object.values(state.actionMaps).map((m) => ({
        map: m.key, app: m.app, package: m.package,
        count: Object.keys(m.actions).length, names: Object.keys(m.actions),
      })),
    };
    if (serial) {
      try {
        const [props, metrics, fg] = await Promise.all([
          deviceProps(serial, { adbPath: cfg.adbPath }),
          metricsFor(serial),
          currentFocus(serial, { adbPath: cfg.adbPath }),
        ]);
        out.device = { serial, model: props.model, brand: props.brand, release: props.release, sdk: props.sdk, android: props.android };
        out.screen = { width: metrics.width, height: metrics.height, density: metrics.density };
        out.foreground = { package: fg.package, activity: fg.activity };
      } catch (e) {
        out.deviceError = e.message;
      }
    }
    const adbv = await adbVersion(cfg.adbPath || undefined).catch((e) => ({ ok: false, err: e.message }));
    out.adbVersion = adbv.version || null;

    // 「连接」胶囊的三色语义（侧栏只按 link.state 上色，不再自己猜）：
    //   ok    = 绿：adb 可用 + 恰有一台已授权设备
    //   none  = 灰：没检测到设备（线没插 / 手机没连上）
    //   error = 红：手机侧或 adb 侧有问题，message / hint 说清「怎么了 + 怎么办」
    out.link = (() => {
      if (adbError) {
        return {
          state: 'error', code: 'adb-down',
          message: `adb 起不来：${adbError.split('\n')[0]}`,
          hint: '插件会自动尝试拉起 adb server；如果一直失败，看看 5037 端口是不是被别的程序占着',
        };
      }
      if (!out.adbPath) {
        return { state: 'error', code: 'no-adb', message: '找不到 adb.exe', hint: '把 platform-tools 放进插件 vendor/platform-tools/，或在插件配置里填 adbPath' };
      }
      const bad = devices.filter((d) => d.state !== 'device');
      if (!online.length) {
        if (bad.length === 1 && /unauthorized/i.test(bad[0].state)) {
          return { state: 'error', code: 'unauthorized', message: '手机没授权 USB 调试', hint: '解锁手机 → 点「允许 USB 调试」→ 勾选「一律允许」' };
        }
        if (bad.length) {
          return { state: 'error', code: bad[0].state, message: `设备状态异常：${bad[0].label || bad[0].state}`, hint: '拔插数据线 / 关掉再开 USB 调试 / 换根线试试' };
        }
        return { state: 'none', code: 'no-device', message: '没有检测到手机', hint: '① 数据线插好（选「传输文件」）② 开发者选项 → USB 调试 ③ 手机上点「允许」' };
      }
      if (online.length > 1 && !cfg.defaultSerial) {
        return { state: 'error', code: 'multiple', message: `有 ${online.length} 台设备，不知道用哪台`, hint: '在插件配置里填 defaultSerial（设备序列号）' };
      }
      return { state: 'ok', code: 'ok', message: '已连接', hint: '' };
    })();
    return out;
  };

  const toolDefs = [];
  const push = (d) => toolDefs.push(d);

  push({
    name: 'phone_status',
    description: '安卓真机状态：adb 路径、在线设备、机型/Android 版本、屏幕分辨率、当前前台 App、侧栏视频流状态。改动默认设备后先用它确认。',
    parameters: {
      type: 'object',
      properties: {
        serial: { type: 'string', description: '设备序列号（省略则用唯一在线设备）' },
        heal: { type: 'boolean', description: '先修一次 adb（kill-server → 自己前台起 server → 等设备回来）。设备列表空/掉线时用' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args = {}) => {
      if (!args.heal) return await status(args);
      const h = await healAdb({ adbPath: cfg.adbPath }).catch((e) => ({ ok: false, reason: e.message }));
      return { ...(await status(args)), heal: h };
    },
  });

  push({
    name: 'phone_apps',
    description: '列出手机上的应用包名（默认只看第三方应用，可用 filter 过滤关键字，如 jingdong/pinduoduo）。',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '包名关键字（大小写不敏感）' },
        system: { type: 'boolean', description: 'true 时连系统应用一起列（很多）' },
        serial: { type: 'string' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: `共 ${v.count} 个：\n${(v.packages || []).join('\n')}` }] },
    execute: async (args = {}) => {
      const serial = await resolveSerial(args.serial);
      let pkgs = await listPackages(serial, undefined, { adbPath: cfg.adbPath, system: !!args.system });
      if (args.filter) {
        const f = String(args.filter).toLowerCase();
        pkgs = pkgs.filter((p) => p.toLowerCase().includes(f));
      }
      return { ok: true, count: pkgs.length, packages: pkgs.slice(0, 300) };
    },
  });

  push({
    name: 'phone_open',
    description: '把某个 App 切到前台（默认京东 com.jingdong.app.mall）。会先看当前前台，不在才启动，随后等它稳定。',
    parameters: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '包名，默认 com.jingdong.app.mall' },
        serial: { type: 'string' },
        waitMs: { type: 'number', description: '等待前台稳定的最长时间，默认 8000' },
        human: { type: 'boolean', description: '标记这是人在操作（不触发 AI 所有权检查）' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args = {}) => {
      const serial = await resolveSerial(args.serial);
      const pkg = args.package || 'com.jingdong.app.mall';
      const by = args.human ? 'human' : 'ai';
      touchActivity();
      if (by !== 'human') assertAiAllowed();
      const pkgOf = (v) => (typeof v === 'string' ? v : (v?.package || null));
      const before = pkgOf(await currentFocus(serial, { adbPath: cfg.adbPath }).catch(() => null));

      // 有控制通道就优先用它：START_APP 是亚毫秒的，之后 300ms 轮询前台，而不是 monkey + 死等 8 秒
      const sessionStart = by === 'human' ? null : await ensureSessionForAi(args);
      const ctl = getControl();
      if (ctl && ctl.available && before !== pkg) {
        const t0 = Date.now();
        const limit = Number(args.waitMs) || 8000;
        let after = before;
        let sent = false;
        while (Date.now() - t0 < limit) {
          if (!sent) { ctl.startApp(pkg); sent = true; }
          await sleep(300);
          after = pkgOf(await currentFocus(serial, { adbPath: cfg.adbPath }).catch(() => null));
          if (after === pkg) break;
        }
        if (after !== pkg) {
          // 控制通道没能拉到前台（有些 ROM 对 START_APP 挑 Activity），退回 monkey 再试一次
          const r = await ensureForeground(serial, pkg, { adbPath: cfg.adbPath, waitMs: limit });
          return { ok: true, package: pkg, launched: true, before, after: pkgOf(r.after) || pkgOf(r.focus), via: 'adb-fallback', ms: Date.now() - t0 };
        }
        return { ok: true, package: pkg, launched: true, before, after, via: 'control', ms: Date.now() - t0, sessionStart };
      }
      if (before === pkg) return { ok: true, package: pkg, launched: false, before, after: before, via: ctl?.available ? 'control' : 'adb', ms: 0, sessionStart };

      const r = await ensureForeground(serial, pkg, { adbPath: cfg.adbPath, waitMs: Number(args.waitMs) || 8000 });
      return { ok: true, package: pkg, launched: r.launched, before: pkgOf(r.focus) || before, after: pkgOf(r.after) || pkgOf(r.focus), via: 'adb' };
    },
  });

  push({
    name: 'phone_screenshot',
    description: '抓一张单屏截图（真机物理像素，如 1080x2400），落盘并作为图片附件返回，模型可以直接看图。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名里的标记' },
        outDir: { type: 'string' },
        serial: { type: 'string' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => withImage(v) },
    execute: async (args) => await takeShot(args || {}),
  });

  push({
    name: 'phone_longshot',
    description: '「一页一屏到底」的长截图：逐帧滚动抓屏 + 运动估计拼接（自动量固定栏当遮罩）+ 重复贴段自检，落盘 PNG 并作为图片附件返回。跑之前先确认目标页面在前台。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        outDir: { type: 'string' },
        maxSteps: { type: 'number', description: '最多拼几步，默认 8' },
        maskTop: { type: 'number', description: '手动指定顶部固定栏高度（像素，一般不用填）' },
        maskBottom: { type: 'number', description: '手动指定底部固定栏高度（像素，一般不用填）' },
        serial: { type: 'string' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => withImage(v) },
    execute: async (args) => await takeLongshot(args || {}),
  });

  push({
    name: 'phone_inspect',
    description: '用 uiautomator 拿控件树：返回「看得见/可点/可滚」的节点，带文字、描述、包名和中心坐标 x/y（设备像素）。做自动化先看它，再决定点哪里。',
    parameters: {
      type: 'object',
      properties: {
        max: { type: 'number', description: '最多返回多少节点，默认 60' },
        serial: { type: 'string' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args = {}) => {
      const serial = await resolveSerial(args.serial);
      const max = Number(args.max) || 60;
      // 偶发空树：WebView 表面 / 正在切页面时 uiautomator 会 dump 出没有可用节点的 hierarchy。
      // 重试一次（并去掉 --compressed）比直接告诉模型「0 个节点」有用得多。
      // 真机上还有一种失败：前台界面一直在动（视频/Lottie）→ uiautomator 永远等不到 idle，
      // 报 `ERROR: could not get idle state`。这种情况不抛错，改成「降级结果」告诉模型换条路。
      let dump = null;
      let retried = false;
      let failReason = '';
      try {
        dump = await uiDump(serial, { adbPath: cfg.adbPath, max });
      } catch (e) { failReason = e.message; }
      if (!dump || dump.nodes.length === 0) {
        retried = true;
        await sleep(dump ? 700 : 900);
        dump = await uiDump(serial, { adbPath: cfg.adbPath, max, compressed: false })
          .catch((e) => { failReason = e.message; return null; });
      }
      const metrics = await metricsFor(serial).catch(() => null);
      const fg = await currentFocus(serial, { adbPath: cfg.adbPath }).catch(() => null);
      if (!dump) {
        return {
          ok: false,
          degraded: true,
          retried,
          reason: failReason,
          screen: metrics ? { width: metrics.width, height: metrics.height } : null,
          foreground: fg?.package ? { package: fg.package, activity: fg.activity } : null,
          hint: 'uiautomator 拿不到控件树：前台界面在持续动画/播放视频时它会一直等不到 idle（真机实测京东首页偶发）。'
            + '先用 phone_screenshot 看画面，再用 phone_action 的相对坐标点击；或等几秒重试。',
        };
      }
      return {
        ok: true,
        count: dump.nodes.length,
        total: dump.total,
        truncated: dump.truncated,
        retried,
        nodes: dump.nodes,
        screen: metrics ? { width: metrics.width, height: metrics.height } : null,
        foreground: fg?.package ? { package: fg.package, activity: fg.activity } : null,
        hint: dump.nodes.length === 0 ? '控件树里没有可读节点（可能是 WebView/游戏画面）：改用 phone_screenshot 看图，再按坐标点 phone_action' : undefined,
      };
    },
  });

  push({
    name: 'phone_action',
    description: '在真机上做一个动作。坐标一律用 0~1 的相对值（nx/ny），宿主按屏幕像素换算，所以你不用管分辨率。支持 tap/long_press/swipe/scroll/wheel/touch/key/type/launch/wait/wake/home。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['tap', 'long_press', 'swipe', 'scroll', 'wheel', 'touch', 'key', 'type', 'launch', 'wait', 'wake', 'home'] },
        nx: { type: 'number', description: '相对 x（0=左，1=右）' },
        ny: { type: 'number', description: '相对 y（0=顶，1=底）' },
        toNx: { type: 'number', description: 'swipe 终点相对 x' },
        toNy: { type: 'number', description: 'swipe 终点相对 y' },
        text: { type: 'string', description: 'type 动作的文字（有控制通道时中文也能直接输入，回落 adb 时只能 ASCII）' },
        key: { type: 'string', description: 'key 动作的键名：BACK/HOME/APP_SWITCH/ENTER/DEL/POWER/WAKEUP…' },
        package: { type: 'string', description: 'launch 动作的包名' },
        dir: { type: 'string', enum: ['up', 'down'], description: 'scroll 方向，默认 up（手指上滑 = 内容往下走）' },
        pages: { type: 'number', description: 'scroll 滚几屏，默认 0.5' },
        notches: { type: 'number', description: 'wheel 滚轮格数（可小数，正=往下滚，负=往回滚）' },
        phase: { type: 'string', enum: ['down', 'move', 'up'], description: 'touch 的相位（侧栏鼠标拖拽用，模型一般不需要）' },
        ms: { type: 'number' },
        settleMs: { type: 'number', description: '动作后等待多久再回报，默认 120' },
        serial: { type: 'string' },
        human: { type: 'boolean', description: '内部使用：标记这次点击来自侧栏里的人（人接管后模型调用会被拒）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args) => await doAction(args || {}),
  });

  push({
    name: 'phone_keyboard',
    description: '输入一段文字（优先走 scrcpy 控制通道的 INJECT_TEXT，中文也能直接输；没有控制通道时回落 adb input text，只支持 ASCII），可选回车提交。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'true 时输入完按一次回车' },
        clear: { type: 'boolean', description: 'true 时先把输入框清空（MOVE_END + 连发 DEL），再输文字。输入框里有残留内容时用' },
        serial: { type: 'string' },
        human: { type: 'boolean', description: '内部使用：标记这次输入来自侧栏里的人（人已接管时模型调用会被拒）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args = {}) => {
      if (!args.human) assertAiAllowed();
      touchActivity();
      const serial = await resolveSerial(args.serial);
      const sessionStart = args.human ? null : await ensureSessionForAi(args);
      const text = String(args.text ?? '');
      const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 127);
      const ctl = getControl();
      if (ctl) {
        const cleared = args.clear ? await ctl.clearText({ count: Number(args.clearCount) || 80 }) : null;
        const sent = await ctl.text(text, { gapMs: 100 });
        if (args.submit) await ctl.keycode('enter');
        return {
          ok: true, via: 'control', cleared, sent, submit: !!args.submit, nonAsciiCount: nonAscii.length, sessionStart,
          note: nonAscii.length ? '非 ASCII 已通过控制通道直接注入，不需要 ADBKeyboard' : undefined,
        };
      }
      const sent = await typeText(serial, text, { adbPath: cfg.adbPath });
      if (args.submit) await keyevent(serial, 'ENTER', { adbPath: cfg.adbPath });
      return {
        ok: true, via: 'adb', sent, submit: !!args.submit, nonAsciiCount: nonAscii.length, sessionStart,
        note: nonAscii.length ? '包含非 ASCII 字符：如果没输进去，说明手机没装 ADBKeyboard，可改用侧栏的 scrcpy 输入或先用英文' : undefined,
      };
    },
  });

  push({
    name: 'phone_clipboard',
    description: '手机剪贴板（走 scrcpy 控制通道，不是 adb）：get 读手机剪贴板最近内容，set 把电脑上的文字写进手机剪贴板（paste=true 时顺手粘贴到当前焦点，中文也能进），status 看最近一次收到的值。往手机输入框送中文的正路就是 set + paste。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['get', 'set', 'status'] },
        text: { type: 'string', description: 'op=set 时要写进手机剪贴板的文字' },
        paste: { type: 'boolean', description: 'op=set 时是否顺手粘贴到当前焦点（默认 true）' },
        copy: { type: 'boolean', description: 'op=get 时先让手机按一下 COPY 键再读（手机剪贴板自动同步开着时，这是主动读唯一可靠的路子，需要手机上先选中文字）' },
        timeoutMs: { type: 'number', description: 'op=get 等手机回话的超时（默认 1500ms）' },
        serial: { type: 'string' },
        human: { type: 'boolean', description: '内部使用：标记来自侧栏里的人' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args = {}) => {
      if (!args.human) assertAiAllowed();
      touchActivity();
      if (args.op === 'status') return { ok: true, ...deviceClipboard() };
      if (args.op === 'set') {
        if (!args.human) await ensureSessionForAi(args);
        const r = writeDeviceClipboard(args.text ?? '', { paste: args.paste !== false });
        return { ok: r.ok, op: 'set', ...r };
      }
      if (!args.human) await ensureSessionForAi(args);
      const r = await readDeviceClipboard({ timeoutMs: Number(args.timeoutMs) || 1500, copy: !!args.copy });
      return { ok: true, op: 'get', ...r };
    },
  });

  push({
    name: 'phone_stream',
    description: '控制侧栏实时画面用的 scrcpy 视频流（H.264）：start 起流（可指定 maxSize/bitRate/maxFps），stop 停流省电，status 看状态。侧栏自己会用，模型一般只在要腾出编码器时用 stop。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['start', 'stop', 'status'] },
        maxSize: { type: 'number', description: '长边像素上限：1200 省流 / 1800 标准（默认）/ 2400 原始分辨率' },
        bitRate: { type: 'number', description: '视频码率（bps），默认 4000000' },
        maxFps: { type: 'number' },
        serial: { type: 'string' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args = {}) => {
      if (args.op === 'stop') {
        await state.stopStream?.();
        return { ok: true, stopped: true, running: false };
      }
      if (args.op === 'status') {
        const sess = sessionInfo();
        return { ok: true, running: sess.running, session: sess };
      }
      const st = await state.ensureStream?.({ maxSize: Number(args.maxSize) || undefined, bitRate: Number(args.bitRate) || undefined, maxFps: Number(args.maxFps) || undefined, serial: args.serial });
      return { ok: !!st, running: true, width: st?.width, height: st?.height, fps: st?.stats ? st.stats.packets : null, version: st?.version };
    },
  });

  push({
    name: 'phone_preset',
    description: '按声明式动作表（actions/*.json，QtScrcpy keymap 口径：坐标 0~1 归一化）跑命名动作，例如 jd 表的 tab-home / search-tap / swipe-up。不带 name/names 时只列出表里有哪些动作。适合把「切频道、翻页、回首页」这类固定点击固化成一行调用。',
    parameters: {
      type: 'object',
      properties: {
        map: { type: 'string', description: '动作表名，默认第一张（jd）' },
        name: { type: 'string', description: '单个动作名' },
        names: { type: 'array', items: { type: 'string' }, description: '按顺序跑一串动作名' },
        settleMs: { type: 'number', description: '每个动作后等待，默认 200' },
        serial: { type: 'string' },
        human: { type: 'boolean', description: '内部使用：标记这次调用来自侧栏里的人' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args = {}) => {
      if (!args.human) assertAiAllowed();
      touchActivity();
      const key = args.map || state.defaultMapKey;
      const m = state.actionMaps[key];
      if (!m) throw new Error(`没有动作表 ${key}；现有：${Object.keys(state.actionMaps).join(', ') || '（actions 目录为空）'}`);
      const names = Array.isArray(args.names) && args.names.length ? args.names : (args.name ? [args.name] : []);
      if (!names.length) {
        return { ok: true, map: m.key, app: m.app, package: m.package, screen: m.screen, count: Object.keys(m.actions).length, actions: listActions(m) };
      }
      const serial = await resolveSerial(args.serial);
      const by = args.human ? 'human' : 'ai';
      const sessionStart = by === 'human' ? null : await ensureSessionForAi(args);
      const metrics = await metricsFor(serial);
      const steps = await runActions(serial, metrics, m, names, { adbPath: cfg.adbPath, settleMs: Number(args.settleMs) || 200, by });
      const fg = await currentFocus(serial, { adbPath: cfg.adbPath }).catch(() => null);
      return { ok: true, map: m.key, ran: names, steps, sessionStart, foreground: fg?.package ? { package: fg.package, activity: fg.activity } : null };
    },
  });

  push({
    name: 'phone_takeover',
    description: '控制权交接。owner="human" 时人接管（模型的动作会被拒绝，适合人自己上手改脚本/改配置）；owner="ai" 时把控制权交还模型继续跑。人停止操作一段时间后也会自动交还（默认 90s，可用 idleMs 调整）。',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', enum: ['ai', 'human'], description: '默认 human（抢过来）' },
        idleMs: { type: 'number', description: '人静默多久后自动交还模型，默认 90000；0 表示不自动交还' },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args = {}) => {
      const next = args.owner === 'ai' ? 'ai' : 'human';
      const holdMs = args.idleMs === undefined || args.idleMs === null ? null : Number(args.idleMs);
      const info = setOwner(next, { by: 'human', reason: String(args.reason || 'phone_takeover'), holdMs });
      return { ok: true, ...info };
    },
  });

  return toolDefs;
}

/* ------------------------------------------------------------------ 主入口 */

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  cfg.video = { ...DEFAULT_VIDEO, ...(config?.video || {}) };
  const log = makeLogger(ctx);

  const state = {
    ctx, cfg,
    attachments: undefined,
    stream: null,
    streamClients: 0,
    streamMaxSize: cfg.video.maxSize,
    streamMaxFps: cfg.video.maxFps,
    streamBitRate: cfg.video.bitRate,
    streamStarting: null,
    routes: [],
    warnings: [],
    actionMaps: {},
    defaultMapKey: '',
  };

  state.actionMaps = loadActionMaps(log);
  state.defaultMapKey = Object.keys(state.actionMaps)[0] || '';
  if (state.defaultMapKey) {
    const m = state.actionMaps[state.defaultMapKey];
    log.info(`动作表 ${m.key}（${m.app}）共 ${Object.keys(m.actions).length} 个动作`);
  }

  try {
    state.attachments = ctx.get?.('attachments');
  } catch { /* 宿主可能还没就绪，attachPng 会再取一次 */ }

  /* ---------- 视频流：**单会话**（视频 + 控制同一个 server 进程），懒启动 + 多客户端扇出 ---------- */
  // 与旧版的区别：
  //  1) 会话不再由 /video 独占 —— 侧栏一打开就可以 startSession（人先看见画面），模型动作也复用这条会话；
  //  2) 连接走 reverse（宿主听、server 连回来），实测长跑稳定（见 video.js 头部注释 / PROGRESS.md 坑 8）；
  //  3) 客户端写帧做真背压：某客户端积压就丢帧（视频宁可丢帧也不要拖慢别人）。

  const subscribers = new Set();

  configureSession({
    log: (m) => log.info(m),
    idleStopMs: cfg.idleStopMs,
    humanHoldMs: cfg.humanHoldMs,
    onSessionEvent: (evt, payload) => {
      if (evt === 'start') log.info(`[session] 已启动 ${JSON.stringify(sessionInfo())}`);
      if (evt === 'exit') log.warn(`[session] server 退出：${JSON.stringify(payload?.info || {})}`);
      if (evt === 'stop') log.info(`[session] 已停止（${payload?.reason || ''}）`);
      if (evt === 'owner') log.info(`[session] 控制权 → ${payload.owner}`);
    },
  });

  state.ensureStream = async (opts = {}) => {
    const st = await ensureSession({
      serial: opts.serial || cfg.defaultSerial || undefined,
      adbPath: cfg.adbPath || undefined,
      jar: cfg.scrcpyServer || resolveServerJar() || undefined,
      maxSize: Number(opts.maxSize) || cfg.video.maxSize,
      maxFps: Number(opts.maxFps) || cfg.video.maxFps,
      bitRate: Number(opts.bitRate) || cfg.video.bitRate,
      control: true, tunnel: cfg.video.tunnel || 'auto',
      log: (m) => log.info(m),
    });
    state.stream = st;
    return st;
  };

  state.stopStream = async () => {
    await stopSession('显式停流');
    state.stream = null;
    state.streamClients = 0;
    return { ok: true };
  };

  /** 把一帧写成侧栏能吃的二进制分帧：4B len + 1B flag(1=config,2=key) + 8B pts + payload */
  const frameBuffer = (p) => {
    const head = Buffer.alloc(FRAME_HEADER);
    head.writeUInt32BE(p.size, 0);
    head.writeUInt8((p.config ? 1 : 0) | (p.key ? 2 : 0), 4);
    head.writeBigUInt64BE(BigInt(p.pts), 5);
    return Buffer.concat([head, p.data]);
  };

  const streamTo = (res, st) => {
    // 交互式画面禁用 Nagle：一帧才几 KB，等了 40ms 攒包纯粹是白送延迟。
    try { res.socket?.setNoDelay?.(true); } catch { /* ignore */ }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Video-Width': String(st.width),
      'X-Video-Height': String(st.height),
      'X-Device-Name': String(st.name || ''),
      'X-Scrcpy-Version': String(st.version || ''),
      'X-Session-Owner': getOwner(),
      'X-Frame-Header': String(FRAME_HEADER),
    });
    // 真背压：res.write 返回 false 表示内核缓冲满了。视频流宁可丢帧（下一帧很快会来），
    // 也不能把 Node 的内存堆起来 —— 旧版这里是裸 write，等于把积压转嫁成内存和延迟。
    // 阈值从 4MB 收紧到 **512KB**：4MB 在 4Mbps 下是 **8 秒**的积压，那就是「手指松开了画面还在滚」；
    // 512KB ≈ 0.5 秒。而且**只丢非关键帧**：config（SPS/PPS）与关键帧必须放行，否则解码器没法重新对齐。
    const client = {
      dropped: 0,
      write: (buf) => {
        if (res.writableEnded) return;
        const flag = buf.length >= FRAME_HEADER ? buf.readUInt8(4) : 0;   // 1=config 2=关键帧
        const mustDeliver = (flag & 3) !== 0;
        if (!mustDeliver && res.writableLength > 512 * 1024) { client.dropped += 1; return; }
        try { res.write(buf); } catch { /* ignore */ }
      },
      end: () => { if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } } },
    };
    subscribers.add(client);
    const detachSession = addSubscriber(client);
    state.streamClients = subscribers.size;
    const onPacket = (p) => client.write(frameBuffer(p));
    st.onPacket(onPacket, { replay: true });
    const drop = () => {
      subscribers.delete(client);
      state.streamClients = subscribers.size;
      try { detachSession(); } catch { /* ignore */ }
      if (client.dropped) log.info(`[video] 客户端断开，期间丢帧 ${client.dropped}`);
      // 所有人都不看了也不立刻停：会话空闲到 idleStopMs 才停（模型可能还要接着操作手机）
    };
    res.on('close', drop);
    res.on('error', drop);
  };

  /* ---------- HTTP 路由 ---------- */

  const json = (res, code, value) => {
    const body = JSON.stringify(jsonSafe(value) ?? null);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };

  const readJson = (req) => new Promise((resolve) => {
    let data = '';
    req.on('data', (b) => {
      data += b.toString('utf8');
      if (data.length > 1_000_000) { req.destroy(); resolve({}); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });

  const buildToolset = () => buildToolDefs(ctx, cfg, state, log);

  /**
   * 拿长截图入口（GET /longshot 与 POST /shot op=… 用）。
   * 这三个函数是 buildToolDefs 里的闭包，只能通过模块级桥拿到；第一次调用时先构建一次工具集。
   */
  const longshotApi = () => {
    if (!LONG_SHOT_API) buildToolset();
    return LONG_SHOT_API;
  };

  async function handleRoute(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const q = Object.fromEntries(url.searchParams.entries());
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (method === 'GET' && (route === '' || route === 'status')) {
      const tools = buildToolset();
      const t = tools.find((x) => x.name === 'phone_status');
      json(res, 200, await t.execute({ serial: q.serial }));
      return;
    }

    if (method === 'GET' && route === 'session') {
      json(res, 200, { ok: true, ...sessionInfo() });
      return;
    }

    if (method === 'GET' && route === 'owner') {
      json(res, 200, { ok: true, ...ownerInfo(), session: sessionInfo() });
      return;
    }

    // 侧栏截图机轮询长截图进度（见 MODULE_LONGSHOT）
    if (method === 'GET' && route === 'longshot') {
      json(res, 200, { ok: true, ...longshotApi().info() });
      return;
    }

    if (method === 'GET' && route === 'video') {
      const st = await state.ensureStream({
        maxSize: Number(q.maxSize) || undefined, maxFps: Number(q.maxFps) || undefined,
        bitRate: Number(q.bitRate) || undefined, serial: q.serial,
      });
      streamTo(res, st);
      return;
    }

    if (method === 'GET' && route === 'snapshot') {
      const serial = await pickDevice(cfg.defaultSerial || undefined, cfg.adbPath || undefined);
      const shot = await screencap(serial.serial, { adbPath: cfg.adbPath });
      const scale = Number(q.scale) || 1;
      let buf = shot.buffer;
      if (scale > 0 && scale < 1) {
        const img = decodePng(buf);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const out = { width: w, height: h, channels: img.channels ?? 4, data: Buffer.alloc(w * h * (img.channels ?? 4)) };
        const ch = img.channels ?? 4;
        for (let y = 0; y < h; y++) {
          const sy = Math.min(img.height - 1, Math.floor(y / scale));
          for (let x = 0; x < w; x++) {
            const sx = Math.min(img.width - 1, Math.floor(x / scale));
            for (let c = 0; c < ch; c++) out.data[(y * w + x) * ch + c] = img.data[(sy * img.width + sx) * ch + c];
          }
        }
        buf = encodePng(out);
      }
      const size = pngSize(buf);
      res.writeHead(200, {
        'Content-Type': 'image/png', 'Cache-Control': 'no-store',
        'X-Image-Width': String(size.width), 'X-Image-Height': String(size.height),
      });
      res.end(buf);
      return;
    }

    if (method === 'POST') {
      const args = await readJson(req);
      const tools = buildToolset();
      const call = async (name, a) => {
        const t = tools.find((x) => x.name === name);
        if (!t) throw new Error(`没有工具 ${name}`);
        return await t.execute(a);
      };
      try {
        if (route === 'settings') {
          if (args.action === 'get') {
            const s = readSettings();
            json(res, 200, { ok: true, settings: s, dir: shotsRoot(cfg), choices: SETTINGS_CLEANUP_CHOICES });
            return;
          }
          if (args.action === 'cleanup') { json(res, 200, { ok: true, ...cleanupShots({ force: true }) }); return; }
          if (args.action === 'reveal') { json(res, 200, { ok: revealDir(shotsRoot(cfg)), dir: shotsRoot(cfg) }); return; }
          const saved = writeSettings(args);
          json(res, 200, { ok: true, settings: saved, dir: shotsRoot(cfg) });
          return;
        }
        if (route === 'skills') { json(res, 200, { ok: true, ...listSkills() }); return; }
        if (route === 'open') { json(res, 200, await call('phone_open', args)); return; }
        if (route === 'takeover') {
          // 人（侧栏）抢控制权。模型的动作之后会被 assertAiAllowed 拒绝，直到交还或租约到期。
          const info = setOwner('human', { by: 'human', reason: String(args.reason || '侧栏接管'), holdMs: args.idleMs });
          json(res, 200, { ok: true, ...info });
          return;
        }
        if (route === 'owner') {
          const next = args.owner === 'human' ? 'human' : 'ai';
          const info = setOwner(next, { by: 'human', reason: String(args.reason || '侧栏设置'), holdMs: args.idleMs });
          json(res, 200, { ok: true, ...info });
          return;
        }
        if (route === 'session') {
          if (args.op === 'stop') { json(res, 200, await state.stopStream()); return; }
          const st = await state.ensureStream({
            maxSize: Number(args.maxSize) || undefined, maxFps: Number(args.maxFps) || undefined,
            bitRate: Number(args.bitRate) || undefined, serial: args.serial,
          });
          json(res, 200, { ok: true, running: true, width: st?.width, height: st?.height, version: st?.version, ...sessionInfo() });
          return;
        }
        if (route === 'action') {
          // 既支持「一个原子动作」（action+nx/ny…），也支持「动作表里的命名动作」（preset/names）
          // 侧栏点按会带 human:true：人先抢了控制权，再由这条路直接注入。
          if (args.preset || args.names || args.presetList) {
            json(res, 200, await call('phone_preset', { map: args.map, name: args.preset, names: args.names, serial: args.serial, settleMs: args.settleMs, human: args.human }));
            return;
          }
          json(res, 200, await call('phone_action', args));
          return;
        }
        if (route === 'keyboard') { json(res, 200, await call('phone_keyboard', args)); return; }
        if (route === 'clipboard') { json(res, 200, await call('phone_clipboard', args)); return; }
        if (route === 'apps') { json(res, 200, await call('phone_apps', args)); return; }
        if (route === 'inspect') { json(res, 200, await call('phone_inspect', args)); return; }
        if (route === 'shot') {
          // 侧栏截图机：长截图支持 op=start / op=stop，进度走 GET /longshot（可随时停）
          if (args.mode === 'long' && args.op) {
            const ls = longshotApi();
            // 侧栏「单击截图 → 5 秒内按 L」会先存一张短图。既然真要长截图了，那张短图就是垃圾：
            // 这里顺手删掉（只删 shotsDir 里的 .png，别的地方一律不碰）。
            if (args.op !== 'stop' && args.drop) {
              try {
                const dir = shotsRoot(cfg);
                const p = String(args.drop);
                if (p.startsWith(dir) && /\.png$/i.test(p)) rmSync(p, { force: true });
              } catch (e) { warn(`清理等待中的短图失败：${e.message}`); }
            }
            json(res, 200, args.op === 'stop' ? ls.stop() : ls.start(args));
            return;
          }
          const r = args.mode === 'long' ? await call('phone_longshot', args) : await call('phone_screenshot', args);
          maybeCleanupShots();
          json(res, 200, { ...r, image: undefined });
          return;
        }
        if (route === 'stream') {
          if (args.op === 'stop') { json(res, 200, await state.stopStream()); return; }
          const st = await state.ensureStream({
            maxSize: Number(args.maxSize) || undefined, maxFps: Number(args.maxFps) || undefined,
            bitRate: Number(args.bitRate) || undefined,
          });
          json(res, 200, { ok: true, running: true, width: st.width, height: st.height, version: st.version });
          return;
        }
        if (route === 'close') { json(res, 200, await state.stopStream()); return; }
        json(res, 404, { ok: false, error: `未知接口 ${route}` });
      } catch (e) {
        log.warn(`接口 ${route} 失败：${e.message}`);
        json(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    json(res, 404, { ok: false, error: `未知接口 ${route}` });
  }

  function registerRoutes() {
    const inject = ctx.inject?.bind(ctx);
    if (typeof inject !== 'function') { log.warn('没有 ctx.inject，跳过 HTTP 路由注册'); return; }
    inject(['webServer'], (scoped) => {
      const webServer = scoped.get?.('webServer') ?? scoped.webServer;
      if (!webServer || typeof webServer.register !== 'function') { log.warn('webServer 服务不可用'); return; }
      const dispose = webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => { handleRoute(req, res).catch((e) => { try { json(res, 500, { ok: false, error: e.message }); } catch { /* ignore */ } }); },
      });
      state.routes.push(dispose);
      const effect = scoped.effect?.bind(scoped) ?? ctx.effect?.bind(ctx);
      if (typeof effect === 'function') effect(() => () => { try { if (typeof dispose === 'function') dispose(); } catch { /* ignore */ } }, 'android-phone: http routes');
      log.info(`HTTP 接口就绪：${PREFIX}/{status,session,owner,takeover,video,snapshot,open,action,shot,inspect,apps,stream,close}`);
    });
  }

  function registerTools() {
    const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
    if (!tools || typeof tools.register !== 'function') { log.warn('没有 tools 服务，跳过工具注册'); return; }
    const defs = buildToolset();
    const guard = (definition) => ({
      ...definition,
      execute: async (args = {}) => jsonSafe(await definition.execute(args)),
    });
    for (const def of defs) {
      const dispose = tools.register(guard(def));
      const effect = ctx.effect?.bind(ctx);
      if (typeof effect === 'function') effect(() => () => { try { if (typeof dispose === 'function') dispose(); } catch { /* ignore */ } }, `android-phone: tool ${def.name}`);
      else state.routes.push(dispose);
    }
    log.info(`注册了 ${defs.length} 个工具：${defs.map((d) => d.name).join(', ')}`);
  }

  try { registerTools(); } catch (e) { state.warnings.push(`工具注册失败：${e.message}`); log.error(`工具注册失败：${e.message}`); }
  try { registerRoutes(); } catch (e) { state.warnings.push(`路由注册失败：${e.message}`); log.error(`路由注册失败：${e.message}`); }

  // 进程退出：先把会话收干净（异步最多跑完同步部分），再同步 pkill 兜底 —— 否则设备上会留一个
  // 常驻的 app_process（scrcpy-server），下次起流会跟它抢同一个抽象 socket 名/编码器。
  const onExit = () => {
    let wasRunning = false;
    let serial = '';
    try { const s = sessionInfo(); wasRunning = s.running; serial = s.serial || ''; } catch { /* ignore */ }
    try { void shutdownSession(); } catch { /* ignore */ }
    try { state.stream?.stop?.(); } catch { /* ignore */ }
    if (wasRunning) {
      try { killStrayServerSync({ adbPath: cfg.adbPath || undefined, serial: serial || cfg.defaultSerial || undefined }); } catch { /* ignore */ }
    }
    // 反向映射也要清：异常退出时 `adb reverse --remove` 不会执行，攒下来会污染后续会话（坑 13）
    try { sweepScrcpyReverseSync({ adbPath: cfg.adbPath || undefined, serial: serial || cfg.defaultSerial || undefined }); } catch { /* ignore */ }
  };
  process.once('exit', onExit);
  state.open = (code = 0) => { onExit(); void code; };

  return { name, config: cfg, status: async () => await buildToolset().find((x) => x.name === 'phone_status').execute({}) };
}

export default { name, apply };
