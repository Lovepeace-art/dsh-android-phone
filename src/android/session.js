/**
 * 单会话管理器：**一个** scrcpy server 进程同时提供视频流与控制通道，并管“谁在操作手机”。
 *
 * 为什么是单会话（用户 2026-10-16 的决定）：
 *  - 侧栏打开时就把会话带起来，人随时能看见手机画面（这是首要价值：方便看模型在干什么、方便改脚本）；
 *  - 一条控制连接串行注入事件，所以“人/模型同时操作”天然要排队 —— 干脆用所有权（owner）显式表达；
 *  - scrcpy 视频流与另一个 QtScrcpy 窗口互斥，多开会话只会打架。
 *
 * 所有权模型（用户原话：ai 使用时宿主只观看，ai 暂停时宿主可操作，宿主有强制操作的权限）：
 *  - owner = 'ai'（默认）：模型可操作；侧栏只读（客户端禁用手势，但点「接管」可强抢）；
 *  - owner = 'human'：人被 AI 操作打扰时点「接管」强抢；此后模型的 phone_* 动作会被拒绝，
 *    直到人点「交还」或模型调用 phone_takeover 拿回；
 *  - 任何人/模型的操作都会刷新 lastActivity，会话空闲（无订阅者 && 无操作）到 idleStopMs 才自动停。
 *
 * 崩溃自愈：server 进程意外退出（历史上正向模式 2~4 秒静默退出就是这么暴露的）时，
 * 自动重启会话并回放，最多连续 3 次。
 */
import { startVideoStream, resolveServerJar } from './video.js';
import { createControlChannel } from './control.js';
import { pickDevice, screenMetrics } from './adb.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_IDLE_STOP_MS = 45_000;
const DEFAULT_HUMAN_HOLD_MS = 90_000;   // 人抢到控制权后，静默这么久自动交还模型

let cur = null;               // { video, ctl, serial, metrics, opts, startedAt, subscribers:Set, restarts }
let starting = null;
let owner = 'ai';
let ownerAt = Date.now();
let lastActivity = Date.now();
let idleTimer = null;
let stopping = null;
let restarts = 0;             // 连续自动重启计数（手动重启会清零）
let ownerTimer = null;        // 人工接管的租约计时器
const listeners = new Set();
const cfgRef = { log: () => {}, idleStopMs: DEFAULT_IDLE_STOP_MS, humanHoldMs: DEFAULT_HUMAN_HOLD_MS, onSessionEvent: null };

function emit(evt, payload) {
  for (const cb of [...listeners]) { try { cb(evt, payload); } catch { /* ignore */ } }
  if (cfgRef.onSessionEvent) { try { cfgRef.onSessionEvent(evt, payload); } catch { /* ignore */ } }
}

export function configure({ log, idleStopMs, humanHoldMs, onSessionEvent } = {}) {
  if (log) cfgRef.log = log;
  if (Number.isFinite(idleStopMs)) cfgRef.idleStopMs = idleStopMs;
  if (Number.isFinite(humanHoldMs)) cfgRef.humanHoldMs = humanHoldMs;
  if (onSessionEvent) cfgRef.onSessionEvent = onSessionEvent;
}

export function onSessionEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); }

export function touchActivity() { lastActivity = Date.now(); }
export function idleForMs() { return Date.now() - lastActivity; }

/* ---------------------------------------------------------------- 所有权 */

export function getOwner() { return owner; }
export function ownerInfo() { return { owner, ownerAt, idleMs: idleForMs(), humanHoldMs: cfgRef.humanHoldMs }; }

/** 人接管是有租约的：静默超过 humanHoldMs 就自动交还模型，免得模型一直撞「已被人工接管」 */
function armOwnerLease() {
  if (ownerTimer) return;
  ownerTimer = setInterval(() => {
    if (owner !== 'human') { clearInterval(ownerTimer); ownerTimer = null; return; }
    const hold = cfgRef.humanHoldMs;
    if (hold > 0 && idleForMs() >= hold) {
      cfgRef.log(`[session] 人工静默 ${Math.round(idleForMs() / 1000)}s，控制权自动交还模型`);
      setOwner('ai', { by: 'auto', reason: '人工静默超时' });
    }
  }, 5_000);
  ownerTimer.unref?.();
}

export function setOwner(next, { by = 'human', reason = '', holdMs = null } = {}) {
  if (next !== 'ai' && next !== 'human') throw new Error(`owner 只能是 ai / human，收到 ${next}`);
  if (Number.isFinite(holdMs)) cfgRef.humanHoldMs = Math.max(0, Number(holdMs));
  const changed = owner !== next;
  owner = next;
  ownerAt = Date.now();
  touchActivity();
  if (next === 'human') armOwnerLease();
  if (changed) cfgRef.log(`[session] 控制权 ${next}（by=${by}${reason ? ' ' + reason : ''}）`);
  emit('owner', ownerInfo());
  return ownerInfo();
}

/** 模型侧动作的守门人：人被抢了控制权就拒绝（人可强抢，模型不能硬闯）。 */
export function assertAiAllowed() {
  if (owner === 'human') {
    const err = new Error('手机控制权已被人工接管（owner=human）：请先让用户在侧栏点「交还」，或调用 phone_takeover 拿回控制权后再操作');
    err.code = 'OWNER_HUMAN';
    throw err;
  }
  touchActivity();
}

/* ---------------------------------------------------------------- 会话 */

export function sessionInfo() {
  return {
    running: !!cur,
    starting: !!starting,
    owner,
    serial: cur?.serial || null,
    width: cur?.video?.width || null,
    height: cur?.video?.height || null,
    deviceName: cur?.video?.name || null,
    tunnel: cur?.video?.tunnel || null,
    version: cur?.video?.version || null,
    maxSize: cur?.opts?.maxSize ?? null,
    maxFps: cur?.opts?.maxFps ?? null,
    bitRate: cur?.opts?.bitRate ?? null,
    stats: cur?.video?.stats ? { ...cur.video.stats } : null,
    control: !!cur?.ctl?.available,
    // 控制通道实际用的坐标空间（= 视频尺寸）；设备像素尺寸另见 metrics
    screen: cur?.ctl?.screen || null,
    metrics: cur?.metrics ? { width: cur.metrics.width, height: cur.metrics.height, density: cur.metrics.density } : null,
    subscribers: cur ? cur.subscribers.size : 0,
    startedAt: cur?.startedAt || null,
    restarts: restarts,
    idleMs: idleForMs(),
    lastExit: cur?.lastExit || null,
  };
}

export function getControl() { return cur?.ctl?.available ? cur.ctl : null; }

/* ---------------------------------------------------------------- 剪贴板 */

// 最近一次从手机收到的剪贴板（CLIPBOARD 设备消息）
const clipboard = { text: '', at: 0, seq: 0 };
let clipboardWaiters = [];

export function deviceClipboard() {
  return { text: clipboard.text, at: clipboard.at, available: !!cur?.ctl?.available };
}

/**
 * 读手机剪贴板。
 *
 * 服务端源码（v5.0.1 `control/Controller.java` `getClipboard(copyKey)`）：
 * 只有 `clipboard_autosync=false` 时 GET_CLIPBOARD 才会回一条 CLIPBOARD 设备消息；
 * autosync 默认开着，此时手机剪贴板**一变就主动推**给我们（我们缓存起来）。
 * 所以：
 *   - 默认 copyKey=NONE：只是「问一下有没有新值」，多半读不到东西，返回缓存（fresh=false）；
 *   - `copy:true`：先让手机按一下 COPY 键（Android 7+），把当前选中的文字复制进剪贴板，
 *     autosync 随即推给我们 —— 这是「主动读」在这台机器上唯一可靠的路子。
 */
export async function readDeviceClipboard({ timeoutMs = 1500, copy = false } = {}) {
  const ctl = getControl();
  if (!ctl) throw new Error('没有控制通道：剪贴板只能走 scrcpy 控制通道（adb 做不到）');
  const before = clipboard.seq;
  const r = ctl.getClipboard({ copyKey: copy ? 1 : 0 });
  if (!r.ok) throw new Error(r.reason || 'GET_CLIPBOARD 发送失败');
  const got = await new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => {
      clipboardWaiters = clipboardWaiters.filter((w) => w !== done);
      resolve(null);
    }, timeoutMs);
    clipboardWaiters.push(done);
  });
  const fresh = clipboard.seq !== before;
  return {
    ...deviceClipboard(),
    fresh,
    got: got !== null,
    copy,
    us: r.us,
    ...(fresh ? {} : {
      hint: copy
        ? '按下 COPY 了，但剪贴板没变：手机上可能没有选中任何文字'
        : 'autosync 开着时 GET_CLIPBOARD 不会回包（服务端源码如此）。要强制读就传 copy=true，先在手机上选中文字',
    }),
  };
}

/**
 * 写手机剪贴板（手机 → 电脑的反向）。`paste:true` 时服务端会顺手在当前焦点执行粘贴，
 * 这就是「把电脑上的一段中文送进手机输入框」的正路 —— INJECT_TEXT 只能送 ASCII。
 */
export function writeDeviceClipboard(text, { paste = true } = {}) {
  const ctl = getControl();
  if (!ctl) throw new Error('没有控制通道：剪贴板只能走 scrcpy 控制通道（adb 做不到）');
  const r = ctl.setClipboard(String(text ?? ''), { paste });
  return { ok: r.ok, us: r.us, bytes: r.bytes, paste, len: String(text ?? '').length };
}

/** 会话参数变了就得重启（/video 上带 maxSize/maxFps 时用得到） */
function sameOpts(a, b) {
  return a.maxSize === b.maxSize && a.maxFps === b.maxFps && a.bitRate === b.bitRate && a.serial === b.serial;
}

/**
 * 确保会话在跑（幂等）。参数变化会重启。
 * @param {{serial?:string, adbPath?:string, jar?:string, maxSize?:number, maxFps?:number, bitRate?:number,
 *          control?:boolean, tunnel?:'reverse'|'forward'|'auto', log?:Function, allowRestart?:boolean}} opts
 */
export async function ensureSession(opts = {}) {
  const want = {
    serial: opts.serial ?? cur?.opts?.serial ?? null,
    adbPath: opts.adbPath ?? cur?.opts?.adbPath ?? null,
    jar: opts.jar ?? cur?.opts?.jar ?? null,
    maxSize: Number(opts.maxSize) || cur?.opts?.maxSize || 1024,
    maxFps: Number(opts.maxFps) || cur?.opts?.maxFps || 30,
    bitRate: Number(opts.bitRate) || cur?.opts?.bitRate || 3_000_000,
    control: opts.control !== false,
    tunnel: opts.tunnel || 'auto',
  };
  if (cur && sameOpts(cur.opts, want)) { touchActivity(); return cur.video; }
  if (starting) { await starting; if (cur && sameOpts(cur.opts, want)) return cur.video; }
  if (cur) await stopSession('参数变化');
  if (!opts.__autoRestart) restarts = 0;      // 手动/正常启动清零；自动重启不清零，否则会无限重启
  starting = (async () => {
    const log = opts.log || cfgRef.log;
    const adbPath = want.adbPath || undefined;
    const serial = want.serial || (await pickDevice(undefined, adbPath)).serial;
    const metrics = await screenMetrics(serial, { adbPath }).catch(() => ({ width: 1080, height: 2400, density: 480 }));
    const video = await startVideoStream({
      serial, adbPath, jar: want.jar || resolveServerJar() || undefined,
      maxSize: want.maxSize, maxFps: want.maxFps, bitRate: want.bitRate,
      control: want.control, tunnel: want.tunnel, cleanupScrcpy: false, log,
    });
    // ⚠️ 控制通道的坐标空间是**视频尺寸**（编码器出来的 808x1800），不是设备尺寸（1080x2400）！
    // scrcpy v5.0.1 的 PositionMapper.map() 会因为 Position.screenSize != videoSize 直接丢掉整个事件
    //（源码 control/PositionMapper.java:34-40，只有 VERBOSE 日志，warn 级别下完全静默）。
    // 所以这里必须用流头带回来的 video.width/height；设备像素只在 adb 兜底时用。
    const screen = { width: video.width || metrics.width, height: video.height || metrics.height };
    const ctl = video.controlSocket
      ? createControlChannel(video.controlSocket, { log, screen })
      : null;
    // 剪贴板同步：手机 → 宿主方向是服务端推的 CLIPBOARD 设备消息（GET_CLIPBOARD 触发，
    // 手机上自己复制东西时也会主动推）。存一份最近值，等 GET 的调用方直接拿。
    if (ctl) {
      ctl.on('clipboard', (text) => {
        clipboard.text = text || '';
        clipboard.at = Date.now();
        clipboard.seq += 1;
        const ws = clipboardWaiters;
        clipboardWaiters = [];
        for (const w of ws) { try { w(clipboard.text); } catch { /* ignore */ } }
        emit('clipboard', { text: clipboard.text, at: clipboard.at });
      });
    }
    cur = {
      video, ctl, serial, metrics, opts: want, startedAt: Date.now(),
      subscribers: new Set(), lastExit: null,
    };
    touchActivity();
    video.onExit((info) => {
      cfgRef.log(`[session] server 进程退出：code=${info.code} signal=${info.signal}`);
      if (!cur || cur.video !== video) return;             // 已经被 stop 掉或被新会话替换
      cur.lastExit = { ...info, at: new Date().toISOString() };
      restarts += 1;
      const n = restarts;
      const lastExit = cur.lastExit;
      cur = null;
      emit('exit', { info, restarts: n });
      if (n <= 3) {
        cfgRef.log(`[session] 自动重启会话（第 ${n}/3 次）`);
        setTimeout(() => {
          ensureSession({ ...want, __autoRestart: true })
            .then(() => { if (cur) cur.lastExit = lastExit; })
            .catch((e) => cfgRef.log(`[session] 自动重启失败：${e.message}`));
        }, 400).unref?.();
      } else {
        cfgRef.log('[session] 连续退出 3 次，不再自动重启（请看 PROGRESS.md 坑 8 的排查记录）');
      }
    });
    emit('start', sessionInfo());
    scheduleIdleCheck();
    return video;
  })().finally(() => { starting = null; });
  return await starting;
}

export async function stopSession(reason = '') {
  if (stopping) return await stopping;
  const c = cur;
  if (!c) return { ok: true };
  cur = null;
  stopping = (async () => {
    for (const s of [...c.subscribers]) { try { s.end?.(); } catch { /* ignore */ } }
    c.subscribers.clear();
    try { c.ctl?.close?.(); } catch { /* ignore */ }
    try { await c.video.stop(); } catch (e) { cfgRef.log(`[session] 停会话出错：${e.message}`); }
    if (reason) cfgRef.log(`[session] 会话已停（${reason}）`);
    emit('stop', { reason, info: sessionInfo() });
  })().finally(() => { stopping = null; });
  return await stopping;
}

export function addSubscriber(client) {
  if (!cur) return () => {};
  cur.subscribers.add(client);
  touchActivity();
  return () => {
    if (cur) cur.subscribers.delete(client);
    if (cur && cur.subscribers.size === 0) scheduleIdleCheck();
  };
}

function scheduleIdleCheck() {
  if (idleTimer) return;
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    if (!cur) return;
    if (cur.subscribers.size > 0) { scheduleIdleCheck(); return; }
    // 人正在接管（可能就从侧栏点），别在人家手里把会话掐了；租约到期会自动交还，之后下一次检查就会停
    if (owner === 'human') { scheduleIdleCheck(); return; }
    if (idleForMs() < cfgRef.idleStopMs) { scheduleIdleCheck(); return; }
    cfgRef.log(`[session] 空闲 ${Math.round(idleForMs() / 1000)}s（无侧栏订阅者），停会话省电`);
    await stopSession('空闲');
  }, 10_000);
  idleTimer.unref?.();
}

/** 给测试/收尾用 */
export async function shutdown() { return await stopSession('进程退出'); }

export { sleep };
