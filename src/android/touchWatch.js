/**
 * 真机触摸监听：判断「人是不是在用手机本体」，用于自动把控制权交给真人。
 *
 * 为什么必须用 getevent 而不是 dumpsys：
 * - 侧栏里的点击/拖拽走 scrcpy 控制通道，最终是 InputManager.injectInputEvent，**不经过 /dev/input**
 * - `adb shell input tap` 同样走注入通道，也不经过 /dev/input
 * - 只有真人用手指/笔碰玻璃，内核才会在 /dev/input/eventX 上产生 EV_ABS / EV_KEY
 * 所以 getevent 是唯一能干净区分「真机操作」和「注入操作」的信号源，不会把模型自己的点击误判成人。
 *
 * 设备枚举不能用 /proc/bus/input/devices（shell 下是 Permission denied），改用 `getevent -p`。
 * 挑选规则：必须有 ABS_MT_POSITION_X(0x35)/Y(0x36)，再按 ABS_X/Y 上限与屏幕像素的接近程度加分
 * （华为上是 input_mt_wrapper，同一时刻还连着蓝牙手表，靠 MT 轴能区分开）。
 */

import { spawn } from 'node:child_process';
import { resolveAdb } from './adb.js';

const DETECT_TIMEOUT_MS = 8000;
const DEBOUNCE_MS = 700;
const RESPAWN_MS = 1500;

/** 解析 `getevent -p` 输出，返回按「像触摸屏」程度降序排好的设备列表（纯函数，便于离线测试） */
export function parseGeteventDevices(text, { screen } = {}) {
  const devices = [];
  const blocks = String(text || '').split(/^(?=add device )/m);
  for (const block of blocks) {
    const head = block.match(/^add device\s+\d+:\s*(\/dev\/input\/event\d+)/m);
    if (!head) continue;
    const dev = { device: head[1], name: '', direct: false, abs: [], keys: [], score: 0 };
    const nm = block.match(/name:\s*"([^"]*)"/);
    if (nm) dev.name = nm[1];
    if (/INPUT_PROP_DIRECT/.test(block)) dev.direct = true;
    const keyLine = block.match(/KEY \(0001\):([\s\S]*?)(?:\n\s*(?:ABS|MSC|SW|LED|REP|INPUT)|$)/);
    if (keyLine) dev.keys = keyLine[1].trim().split(/\s+/).filter(Boolean);
    for (const m of block.matchAll(/^\s*([0-9a-f]{4})\s*:\s*value[^\n]*?min\s*(-?\d+),\s*max\s*(-?\d+)/gm)) {
      dev.abs.push({ code: m[1].toLowerCase(), min: Number(m[2]), max: Number(m[3]) });
    }
    devices.push(dev);
  }
  const w = Number(screen?.width) || 0;
  const h = Number(screen?.height) || 0;
  for (const d of devices) {
    const ax = d.abs.find((a) => a.code === '0000');
    const ay = d.abs.find((a) => a.code === '0001');
    if (d.abs.some((a) => a.code === '0035')) d.score += 60;
    if (d.abs.some((a) => a.code === '0036')) d.score += 60;
    if (ax && w && Math.abs(ax.max + 1 - w) <= Math.max(8, w * 0.05)) d.score += 30;
    if (ay && h && Math.abs(ay.max + 1 - h) <= Math.max(8, h * 0.05)) d.score += 30;
    if (d.keys.includes('014a')) d.score += 10;
    d.score += Math.min(20, d.abs.length);      // 平手时取轴更全的那个（触摸屏有 MT 全套）
  }
  return devices.sort((a, b) => b.score - a.score);
}

/** 一条 getevent 输出行是否代表「一次新的真实触摸开始」 */
export function isTouchStartLine(line) {
  const s = String(line || '');
  if (/EV_KEY\s+BTN_TOUCH\s+DOWN/.test(s)) return true;
  const m = s.match(/EV_ABS\s+ABS_MT_TRACKING_ID\s+([0-9a-fA-F]+)/);
  return !!(m && m[1].toLowerCase() !== 'ffffffff');
}

function runOnce(adb, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let p = null;
    const finish = () => { if (done) return; done = true; clearTimeout(t); resolve(out); };
    try { p = spawn(adb, args, { windowsHide: true }); } catch { resolve(''); return; }
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } finish(); }, timeoutMs);
    p.stdout.on('data', (b) => { out += b.toString('utf8'); });
    p.stderr.on('data', (b) => { out += b.toString('utf8'); });
    p.on('close', finish);
    p.on('error', finish);
  });
}

/** 找到触摸屏设备；找不到返回 null（此时真机操作不会自动接管，但插件其它功能不受影响） */
export async function detectTouchDevice(serial, { adbPath, screen } = {}) {
  const adb = resolveAdb(adbPath);
  const text = await runOnce(adb, ['-s', String(serial), 'shell', 'getevent -p'], DETECT_TIMEOUT_MS);
  const best = parseGeteventDevices(text, { screen })[0];
  if (!best || best.score < 60) return null;
  return best;
}

/**
 * 常驻监听真机触摸。返回 { device, running, spawns, stop() }。
 * adb 进程意外退出会自动重起（退避 1.5s），stop() 后不再重起。
 */
export function startTouchWatch({ serial, adbPath, device, onTouch, log = () => {}, debounceMs = DEBOUNCE_MS }) {
  const adb = resolveAdb(adbPath);
  let child = null;
  let stopped = false;
  let buf = '';
  let lastFire = 0;
  let spawns = 0;

  function handle(line) {
    if (!isTouchStartLine(line)) return;
    const now = Date.now();
    if (now - lastFire < debounceMs) return;
    lastFire = now;
    try { onTouch({ at: now, line: String(line).trim() }); } catch (e) { log(`[touch] 回调异常：${e.message}`); }
  }

  function arm() {
    if (stopped) return;
    spawns += 1;
    try {
      child = spawn(adb, ['-s', String(serial), 'shell', `getevent -lt ${device}`], { windowsHide: true });
    } catch (e) {
      log(`[touch] 起 getevent 失败：${e.message}`);
      return;
    }
    child.stdout.on('data', (b) => {
      buf += b.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > 8192) buf = '';
    });
    child.stderr.on('data', () => { /* getevent 的告警忽略 */ });
    child.on('error', () => { /* 由 close 触发重起 */ });
    child.on('close', () => {
      child = null;
      if (stopped) return;
      const t = setTimeout(arm, RESPAWN_MS);
      t.unref?.();
    });
  }

  arm();
  return {
    device,
    get running() { return !!child; },
    get spawns() { return spawns; },
    stop() {
      stopped = true;
      try { child?.kill(); } catch { /* ignore */ }
      child = null;
    },
  };
}