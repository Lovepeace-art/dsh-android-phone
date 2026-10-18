/**
 * 声明式动作表（借 QtScrcpy keymap 的思路：归一化坐标 + 命名动作）。
 *
 * 为什么不用像素：真机分辨率会变（本机 1080x2400，但换成 1440x3200 或横屏就不一样），
 * QtScrcpy 的 keymap/*.json 就是这么写的 —— `KMT_CLICK` / `KMT_DRAG` + 0~1 的归一化坐标，
 * 例如 tiktok.json 的"上滑"是 start(0.5,0.7) → end(0.5,0.3)。我们照抄这个口径，
 * 每个 App 一份 actions/<app>.json，skill 里直接用动作名，不写坐标。
 *
 * 支持的动作类型：
 *   tap       { at: [rx, ry] }
 *   long_press{ at: [rx, ry], ms?: 700 }
 *   drag      { from: [rx, ry], to: [rx, ry], ms?: 320 }       手势（触发内嵌滚动容器/列表惯性）
 *   scroll    { pages?: 0.75, dir?: 'up'|'down' }              整屏手势滚动（合成滑动）
 *   wheel     { at: [rx, ry], notches }                        真滚轮（INJECT_SCROLL_EVENT，可带小数）
 *   touch     { phase: 'down'|'move'|'up', at: [rx, ry] }      逐事件触摸回放（鼠标拖拽用这条）
 *   key       { key: 'BACK'|'HOME'|'ENTER'|'APP_SWITCH' }
 *   text      { text }                                          有控制通道时中文也能直接送（INJECT_TEXT）
 *   wait      { ms }
 *   launch    { package }                                       启动 App 并等前台
 *
 * 执行后端：**优先 scrcpy 控制通道**（亚毫秒、支持中文/真拖拽），没有控制通道才回落 `adb shell input`。
 * 每步返回值里的 `via: 'control' | 'adb'` 说明了实际走的是哪条路。
 */
import { keyevent, launchApp, longPress, screenMetrics, swipe, tap, typeText, currentFocus } from './adb.js';
import { KEYCODES } from './control.js';
import { getControl, assertAiAllowed, touchActivity } from './session.js';

export const ACTION_TYPES = ['tap', 'long_press', 'drag', 'scroll', 'wheel', 'touch', 'key', 'text', 'wait', 'launch'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 组合键修饰符 → Android `metaState` 位。
 * 接受 `'ctrl'` / `'ctrl+shift'` / `['ctrl']` / 直接的数字，对应控制通道
 * `INJECT_KEYCODE.metaState`（服务端 `KeyEvent` 同一套常量）。
 */
function metaStateOf(meta) {
  if (typeof meta === 'number' && Number.isFinite(meta)) return meta;
  const list = Array.isArray(meta) ? meta : String(meta == null ? '' : meta).split(/[+,\s]+/);
  let s = 0;
  for (const m of list) {
    const k = String(m).toLowerCase();
    if (k === 'ctrl' || k === 'control') s |= 0x1000;
    else if (k === 'shift') s |= 0x1;
    else if (k === 'alt') s |= 0x2;
    else if (k === 'meta' || k === 'cmd' || k === 'win' || k === 'super') s |= 0x10000;
  }
  return s;
}

/**
 * 没有控制通道时，把 `touch` 事件流攒成一次 `adb input`（人用鼠标拖拽的回落路径）。
 * 键 = `${serial}|${by}`，因为同一个插件进程可能同时在给人（侧栏）和模型用。
 */
const pendingTouch = new Map();
/** 一格滚轮在 adb 回落里折成几屏（控制通道下根本不用它，只为了别让人滚了没反应） */
const WHEEL_FALLBACK_PAGES_PER_NOTCH = 0.06;

export function resolvePoint(metrics, at) {
  if (!Array.isArray(at) || at.length < 2) throw new Error(`动作坐标必须是 [rx, ry]（0~1），收到 ${JSON.stringify(at)}`);
  const [rx, ry] = at.map(Number);
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) throw new Error(`动作坐标不是数字：${JSON.stringify(at)}`);
  return { x: Math.round(rx * metrics.width), y: Math.round(ry * metrics.height) };
}

export function validateAction(name, action) {
  const problems = [];
  if (!action || typeof action !== 'object') return [`把动作 ${name} 写成了 ${JSON.stringify(action)}`];
  if (!ACTION_TYPES.includes(action.type)) problems.push(`动作 ${name} 的 type=${action.type} 不认识（可用：${ACTION_TYPES.join('/')}）`);
  if (['tap', 'long_press', 'wheel', 'touch'].includes(action.type)) {
    if (!Array.isArray(action.at) || action.at.length < 2) problems.push(`动作 ${name} 缺 at: [rx, ry]`);
    else if (!action.at.every((v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1)) problems.push(`动作 ${name} 的 at 必须在 0~1`);
  }
  if (action.type === 'touch' && !['down', 'move', 'up'].includes(action.phase)) problems.push(`动作 ${name} 的 phase 必须是 down/move/up`);
  if (action.type === 'wheel' && !Number.isFinite(Number(action.notches))) problems.push(`动作 ${name} 缺 notches（滚轮格数，可为小数）`);
  if (action.type === 'drag') {
    for (const k of ['from', 'to']) {
      if (!Array.isArray(action[k]) || action[k].length < 2) problems.push(`动作 ${name} 缺 ${k}: [rx, ry]`);
      else if (!action[k].every((v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1)) problems.push(`动作 ${name} 的 ${k} 必须在 0~1`);
    }
  }
  if (action.type === 'key' && !action.key) problems.push(`动作 ${name} 缺 key`);
  if (action.type === 'text' && typeof action.text !== 'string') problems.push(`动作 ${name} 的 text 必须是字符串`);
  if (action.type === 'launch' && !(action.package || action.pkg)) problems.push(`动作 ${name} 缺 package`);
  if (action.type === 'wait' && !Number.isFinite(Number(action.ms))) problems.push(`动作 ${name} 缺 ms`);
  return problems;
}

export function listActions(map) {
  return Object.keys(map?.actions || {}).map((name) => ({
    name,
    type: map.actions[name].type,
    comment: map.actions[name].comment || '',
  }));
}

/**
 * 执行一个动作。
 * @param {string} serial
 * @param {{width:number,height:number}} metrics 屏幕尺寸（resolvePoint 用；不传则现场量）
 * @param {object} action
 * @param {{adbPath?:string,appPackage?:string,settleMs?:number,onStep?:Function}} opts
 */
export async function runAction(serial, metrics, action, opts = {}) {
  // 人的操作（by='human'）不做所有权检查；模型的操作要先过守门人（人已接管就拒绝）
  touchActivity();
  if (opts.by !== 'human') assertAiAllowed();
  const ctl = opts.control === false ? null : (opts.control || getControl());
  const useCtl = !!(ctl && ctl.available);
  const via = useCtl ? 'control' : 'adb';
  // ⚠️ 两套坐标系：控制通道走 **视频尺寸**（如 808x1800），adb 走 **设备像素**（1080x2400）。
  // scrcpy v5.0.1 的 PositionMapper.map() 发现 Position.screenSize != videoSize 会**静默丢弃**整个事件
  //（control/PositionMapper.java:34-40，只打 VERBOSE 日志），所以控制路径必须用 ctl.screen。
  const vp = useCtl && ctl.screen && ctl.screen.width ? { width: ctl.screen.width, height: ctl.screen.height } : null;
  // 坑 18：有控制通道时**不要**再去量屏幕 —— 一次 screenMetrics = 3 个 adb 往返（~250ms），
  // 而控制路径的坐标只用 ctl.screen。只有真的要回落到 adb 注入时才需要设备像素。
  const m = vp || metrics || (await screenMetrics(serial, opts));
  const adbOpts = { adbPath: opts.adbPath, timeout: opts.timeout };
  const P = (at) => resolvePoint(vp || m, at);
  const fail = (what, r) => { throw new Error(`控制通道${what}失败：${r?.reason || '未知原因'}`); };
  const started = Date.now();
  let detail = '';
  // 有些动作需要把「真正发到协议上的值」回给调用方（滚轮方向/幅度调参时全靠它）
  let sendEcho = null;
  switch (action.type) {
    case 'tap': {
      const p = P(action.at);
      if (useCtl) { const r = ctl.tap(p.x, p.y); if (!r.ok) fail('tap', r); }
      else await tap(serial, p.x, p.y, adbOpts);
      detail = `${p.x},${p.y}`;
      break;
    }
    case 'long_press': {
      const p = P(action.at);
      const ms = Number(action.ms) || 700;
      if (useCtl) { const r = await ctl.longPress(p.x, p.y, ms); if (!r.ok) fail('longPress', r); }
      else await longPress(serial, p.x, p.y, ms, adbOpts);
      detail = `${p.x},${p.y} ${ms}ms`;
      break;
    }
    case 'drag': {
      const a = P(action.from);
      const b = P(action.to);
      const ms = Number(action.ms) || 320;
      // 控制通道的 swipe 是 DOWN + 每 12ms 一个 MOVE + UP（真拖拽）；adb 只能给系统起点终点让它自己插值
      if (useCtl) { const r = await ctl.swipe(a.x, a.y, b.x, b.y, { durationMs: ms }); if (!r.ok) fail('swipe', r); }
      else await swipe(serial, a.x, a.y, b.x, b.y, ms, adbOpts);
      detail = `${a.x},${a.y} → ${b.x},${b.y}`;
      break;
    }
    case 'scroll': {
      const pages = Number(action.pages) || 0.75;
      const dir = action.dir === 'down' ? 1 : -1; // 默认 up = 手指上滑 = 内容往前走
      const span = Math.round(vp.height * pages);
      const mid = Math.round(vp.width * 0.5);
      const y1 = dir < 0 ? vp.height - Math.round(vp.height * 0.2) : Math.round(vp.height * 0.2);
      const y2 = y1 + dir * span;
      const ms = Number(action.ms) || 320;
      if (useCtl) { const r = await ctl.swipe(mid, y1, mid, y2, { durationMs: ms }); if (!r.ok) fail('scroll', r); }
      else await swipe(serial, mid, y1, mid, y2, ms, adbOpts);
      detail = `${y1} → ${y2}（${pages} 屏）`;
      break;
    }
    case 'wheel': {
      const p = P(action.at);
      const notches = Number(action.notches) || 0;
      if (!notches) { detail = '0 格（忽略）'; break; }
      if (useCtl) {
        // 真滚轮：一次事件带小数格，Android 自己滚 —— 这是「跟手」的关键
        const r = ctl.scroll(p.x, p.y, { notchesV: notches, notchesH: Number(action.notchesH) || 0 });
        if (!r.ok) fail('scroll', r);
        sendEcho = r.sent || null;   // 协议上的真实值（方向调参全靠它）
      } else {
        // 没有控制通道：INJECT_SCROLL_EVENT 用不了，只能折成一次滑动手势（手感差，但别让人滚了没反应）
        const pages = Math.max(-1.2, Math.min(1.2, notches * WHEEL_FALLBACK_PAGES_PER_NOTCH));
        const span = Math.round(vp.height * pages);
        const y1 = pages > 0 ? Math.round(vp.height * 0.72) : Math.round(vp.height * 0.28);
        const y2 = y1 - span;
        const ms = Math.max(160, Math.min(420, Math.abs(span) * 0.5));
        await swipe(serial, p.x, y1, p.x, y2, ms, adbOpts);
        sendEcho = { fallbackPages: Number(pages.toFixed(3)) };
      }
      detail = `${notches > 0 ? '↓' : '↑'} ${Math.abs(notches).toFixed(2)} 格`;
      break;
    }
    case 'touch': {
      const p = P(action.at);
      if (useCtl) {
        // 逐事件回放：DOWN / MOVE / UP 各发各的，手机里的手指与鼠标位置一一对应。
        // raw = 原始 action 码（0 DOWN / 1 UP / 2 MOVE / 5 POINTER_DOWN / 6 POINTER_UP）：
        // 双指缩放必须用 5/6，否则服务端会把第二根手指当成新手势。
        if (Number.isInteger(action.raw)) {
          const r = ctl.touchRaw(action.raw, p.x, p.y, { pointerId: action.pointerId });
          if (!r.ok) fail(`touch-raw-${action.raw}`, r);
          detail = `raw${action.raw} ${p.x},${p.y}${action.pointerId != null ? ` p${action.pointerId}` : ''}`;
          break;
        }
        const r = ctl.touchEvent(action.phase, p.x, p.y, { pointerId: action.pointerId });
        if (!r.ok) fail(`touch-${action.phase}`, r);
        detail = `${action.phase} ${p.x},${p.y}`;
        break;
      }
      // 没有控制通道：把事件流攒成一次 adb input（下点 + 顶点 = tap 或 swipe）
      const key = `${serial}|${opts.by || 'ai'}`;
      if (action.phase === 'down') {
        pendingTouch.set(key, { t0: Date.now(), from: { x: p.x, y: p.y }, last: { x: p.x, y: p.y } });
        detail = `down ${p.x},${p.y}`;
        break;
      }
      if (action.phase === 'move') {
        const t = pendingTouch.get(key);
        if (t) t.last = { x: p.x, y: p.y };
        detail = `move ${p.x},${p.y}`;
        break;
      }
      const t = pendingTouch.get(key);
      pendingTouch.delete(key);
      const from = t?.from || { x: p.x, y: p.y };
      const dt = t ? Date.now() - t.t0 : 0;
      const far = Math.abs(p.x - from.x) > vp.width * 0.012 || Math.abs(p.y - from.y) > vp.height * 0.012;
      if (far) await swipe(serial, from.x, from.y, p.x, p.y, Math.max(120, Math.min(1200, dt || 260)), adbOpts);
      else await tap(serial, from.x, from.y, adbOpts);
      detail = `${far ? 'swipe' : 'tap'} ${from.x},${from.y} → ${p.x},${p.y}`;
      break;
    }
    case 'key': {
      const keyName = String(action.key);
      // 归一化：`APP_SWITCH` / `DPAD_UP` 这些 Android 常量名要能对上小写键表（见 adb.js 的 normKey 注释）
      const norm = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
      // 组合键（Ctrl+A 全选 / Ctrl+C 复制）必须带 metaState 才会被 EditText 认；
      // 2026-10-18 用户反馈「Ctrl+A 在手机里全选失效」，就是以前这里把 meta 丢了。
      const metaState = metaStateOf(action.metaState != null ? action.metaState : action.meta);
      const code = useCtl ? (KEYCODES[norm] ?? KEYCODES[keyName]) : null;
      if (useCtl && code) {
        const r = ctl.keycode(code, { metaState });
        if (!r.ok) fail('keycode', r);
      } else if (metaState) {
        // adb 的 `input keyevent` 表达不了修饰键：静默退化成裸键会让「全选」变成「输入 a」，
        // 宁可明确报错，让调用方知道必须走控制通道。
        throw new Error(`组合键 ${action.key} 需要控制通道（adb input keyevent 不支持修饰键）`);
      } else await keyevent(serial, action.key, adbOpts);
      detail = metaState ? `${String(action.meta || `0x${metaState.toString(16)}`)}+${action.key}` : action.key;
      break;
    }
    case 'text':
      // 控制通道的 INJECT_TEXT 是 UTF-8，**中文可以直接送**（adb input text 只能 ASCII）
      if (useCtl) { const r = await ctl.text(action.text); if (!r.ok) fail('text', r); }
      else await typeText(serial, action.text, adbOpts);
      detail = action.text;
      break;
    case 'wait':
      await sleep(Number(action.ms));
      detail = `${action.ms}ms`;
      break;
    case 'launch': {
      const pkg = action.package || action.pkg;
      if (useCtl) {
        const r = ctl.startApp(pkg);
        if (!r.ok) fail('startApp', r);
      } else await launchApp(serial, pkg, adbOpts);
      detail = pkg;
      break;
    }
    default:
      throw new Error(`不认识的动作类型：${action.type}`);
  }
  const settle = action.settleMs ?? opts.settleMs ?? 0;
  if (settle > 0) await sleep(settle);
  const step = { type: action.type, detail, ms: Date.now() - started, via, comment: action.comment || '' };
  if (sendEcho) step.sent = sendEcho;
  if (opts.onStep) opts.onStep(step);
  return step;
}

/** 按名字依次执行动作表里的动作（名字不存在直接报错，避免静默跳过） */
export async function runActions(serial, metrics, map, names, opts = {}) {
  const steps = [];
  const m = metrics || (await screenMetrics(serial, opts));
  for (const name of names) {
    const action = map?.actions?.[name];
    if (!action) throw new Error(`动作表 ${map?.name || '?'} 里没有动作「${name}」（有：${Object.keys(map?.actions || {}).join(', ')}）`);
    const problems = validateAction(name, action);
    if (problems.length) throw new Error(problems.join('；'));
    steps.push(await runAction(serial, m, action, { ...opts, onStep: opts.onStep }));
  }
  return steps;
}

/** 确保目标 App 在前台；不在就启动并等一会儿 */
export async function ensureForeground(serial, pkg, opts = {}) {
  const focus = await currentFocus(serial, opts);
  if (focus?.package === pkg) return { launched: false, focus };
  await launchApp(serial, pkg, opts);
  await sleep(opts.waitMs ?? 6000);
  const after = await currentFocus(serial, opts);
  return { launched: true, focus: focus?.package || null, after };
}
