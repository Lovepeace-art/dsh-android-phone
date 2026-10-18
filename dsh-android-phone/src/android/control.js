/**
 * scrcpy 控制通道客户端（宿主侧 / Node，零依赖）。
 *
 * ## 为什么值得单独做一条通道
 *
 * 原来所有输入都走 `adb shell input tap/swipe/keyevent/text`。设备上那条命令是
 * `/system/bin/input` 这个 shell wrapper，它 `exec app_process /system/bin com.android.commands.input.Input`
 * —— **每敲一次就从零冷启一个 ART 虚拟机**（本机 nova 6 5G 实测约 150~250ms），
 * 加上宿主起 adb 进程 ~30ms、adb 协议往返 ~20ms，`验证报告/android-host-report.json` 里
 * `phone_action tap` = 306ms、`scroll` = 674ms、连 `wait 1000ms` 都实测 1206ms（固定开销 ~200ms）。
 *
 * scrcpy 控制通道是另一回事：输入交给**已经常驻**的 scrcpy-server 进程，由它直接
 * `InputManager.injectInputEvent(..., ASYNC)`，亚毫秒级。而且它顺手带来一批 adb 做不到的能力：
 * 带中间 MOVE 的真拖拽、精确滚轮、**中文文本注入**（`adb input text` 只吃 ASCII）、
 * START_APP 而不是 monkey+等 8 秒、剪贴板、UHID 手柄、旋屏/息屏、动态改分辨率。
 *
 * ## 线格式的出处
 *
 * 全部逐字节对照 scrcpy v5.0.1 的
 * `server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java`
 * （以及类型枚举 `app/src/control_msg.h`）。要点：
 *  - **一律大端**（服务端用 `DataInputStream`）。
 *  - 每条消息第一个字节是 `type`（`readUnsignedByte()`），后面跟负载。
 *  - `parsePosition()` = `i32 x + i32 y + u16 screenWidth + u16 screenHeight`，**共 12 字节**。
 *    坐标自带屏幕尺寸，服务端的 `PositionMapper` 自己换算 —— 所以侧栏里归一化坐标
 *    乘设备真实尺寸直接送就行，不用管编码分辨率（`max_size` 缩过的那个）是多少。
 *  - 定点数换算：压力 `u16FixedPointToFloat` = raw/65536；滚动 `i16FixedPointToFloat(short)*16` = raw/2048。
 *  - 控制通道是**只写**的：这些消息服务端不回 ACK，所以 `send()` 返回时就是"已交给内核"，
 *    不必等往返 —— 这正是延迟能从 300ms 掉到亚毫秒的原因。
 */

/** 消息类型（`enum sc_control_msg_type` 的顺序即 type 值，v5.0.1 共 23 项） */
export const MSG = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
  SCAN_FILE: 22,
};

/** Android MotionEvent 的 action 值（和服务端 `MotionEvent` 常量一致） */
export const ACTION = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3, OUTSIDE: 4, POINTER_DOWN: 5, POINTER_UP: 6 };

/**
 * 指针 id。服务端 `PointersState` 要求同一个 id 必须 DOWN 开头、UP 结尾；
 * 特殊值来自 `control_msg.h`：MOUSE = -1、普通手指 = -2、虚拟手指 = -3（捏合缩放用）。
 */
export const POINTER = { MOUSE: -1n, FINGER: -2n, VIRTUAL: -3n };

/** AKEYCODE_* 常用键（名字口径沿用 adb.js 的 KEYCODES，方便动作表零改动） */
export const KEYCODES = {
  home: 3, back: 4, call: 5, endcall: 6, power: 26, menu: 82, notification: 83, search: 84,
  enter: 66, del: 67, tab: 61, escape: 111, appswitch: 187, wakeup: 224, sleep: 223, screenshot: 120,
  volumeup: 24, volumedown: 25, mute: 164, dpadup: 19, dpaddown: 20, dpadleft: 21, dpadright: 22,
  center: 23, movehome: 122, moveend: 123, pagedown: 93, pageup: 92,
};

/** 定点数换算常量（见文件头注释） */
const PRESSURE_SCALE = 65536;
const SCROLL_SCALE = 2048;
const SCROLL_RAW_MIN = -32768;
const SCROLL_RAW_MAX = 32767;
// scrcpy 的 INJECT_SCROLL_EVENT 语义：客户端把值当 [-1,1] 解码，服务端再 ×16 → 实际量程 [-16,16]
//（ControlMessageReader 的注释原话：decodes values assuming the full range is [-1, 1], but the actual range is [-16, 16]）。
// 所以一格滚轮 = 1.0 个"单位"，一格可以带小数（更顺），单次最多 ±16 格。
const SCROLL_MAX_UNITS = 16;

/** 服务端 `SC_CONTROL_MSG_INJECT_TEXT_MAX_LENGTH` = 300 字节 */
export const TEXT_CHUNK_MAX_BYTES = 300;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ *
 * 编码器：每个函数返回一条完整的控制消息 Buffer
 * ------------------------------------------------------------------ */

/** INJECT_KEYCODE = type(1) + action(1) + keycode(4) + repeat(4) + metaState(4) = 14 字节 */
export function encInjectKeycode({ action = ACTION.DOWN, keycode, repeat = 0, metaState = 0 }) {
  const b = Buffer.alloc(14);
  b.writeUInt8(MSG.INJECT_KEYCODE, 0);
  b.writeUInt8(action, 1);
  b.writeInt32BE(keycode, 2);
  b.writeInt32BE(repeat, 6);
  b.writeInt32BE(metaState, 10);
  return b;
}

/** INJECT_TEXT = type(1) + u32 len + UTF-8 负载 */
export function encInjectText(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt8(MSG.INJECT_TEXT, 0);
  b.writeUInt32BE(payload.length, 1);
  payload.copy(b, 5);
  return b;
}

/** Position = i32 x + i32 y + u16 screenWidth + u16 screenHeight = 12 字节 */
function writePosition(b, off, x, y, screenWidth, screenHeight) {
  b.writeInt32BE(clamp(Math.round(x), -2147483648, 2147483647), off);
  b.writeInt32BE(clamp(Math.round(y), -2147483648, 2147483647), off + 4);
  b.writeUInt16BE(clamp(Math.round(screenWidth), 1, 65535), off + 8);
  b.writeUInt16BE(clamp(Math.round(screenHeight), 1, 65535), off + 10);
}

/**
 * INJECT_TOUCH_EVENT = type(1) + action(1) + pointerId(i64,8) + Position(12)
 *                     + pressure(u16,2) + actionButton(i32,4) + buttons(i32,4) = 32 字节
 */
export function encInjectTouch({
  action, pointerId = POINTER.FINGER, x, y, screenWidth, screenHeight,
  pressure = 1, actionButton = 0, buttons = 0,
}) {
  const b = Buffer.alloc(32);
  b.writeUInt8(MSG.INJECT_TOUCH_EVENT, 0);
  b.writeUInt8(action, 1);
  b.writeBigInt64BE(BigInt.asIntN(64, BigInt(pointerId)), 2);
  writePosition(b, 10, x, y, screenWidth, screenHeight);
  // 压力是 u16 定点（16 位小数），1.0 会溢成 65536，所以夹到 65535
  b.writeUInt16BE(clamp(Math.round(pressure * PRESSURE_SCALE), 0, 65535), 22);
  b.writeInt32BE(actionButton, 24);
  b.writeInt32BE(buttons, 28);
  return b;
}

/**
 * INJECT_SCROLL_EVENT = type(1) + Position(12) + hScroll(i16,2) + vScroll(i16,2) + buttons(i32,4) = 21 字节
 * `vScreens` 是"多少屏"：服务端那边 vScroll 就是 AXIS_VSCROLL 的量，1.0 ≈ 一个鼠标滚轮格，
 * 所以按屏滚动要拆成多次事件（见 `wheel()` 的 notchesPerScreen）。
 */
export function encInjectScroll({
  x, y, screenWidth, screenHeight, hScroll = 0, vScroll = 0, buttons = 0,
}) {
  const b = Buffer.alloc(21);
  b.writeUInt8(MSG.INJECT_SCROLL_EVENT, 0);
  writePosition(b, 1, x, y, screenWidth, screenHeight);
  b.writeInt16BE(clamp(Math.round(hScroll * SCROLL_SCALE), SCROLL_RAW_MIN, SCROLL_RAW_MAX), 13);
  b.writeInt16BE(clamp(Math.round(vScroll * SCROLL_SCALE), SCROLL_RAW_MIN, SCROLL_RAW_MAX), 15);
  b.writeInt32BE(buttons, 17);
  return b;
}

/** BACK_OR_SCREEN_ON = type(1) + action(1) = 2 字节（息屏状态下按下会点亮屏幕而不是返回） */
export function encBackOrScreenOn(action = ACTION.DOWN) {
  const b = Buffer.alloc(2);
  b.writeUInt8(MSG.BACK_OR_SCREEN_ON, 0);
  b.writeUInt8(action, 1);
  return b;
}

/** GET_CLIPBOARD = type(1) + copyKey(1)：0=NONE 1=COPY 2=CUT */
export function encGetClipboard(copyKey = 0) {
  const b = Buffer.alloc(2);
  b.writeUInt8(MSG.GET_CLIPBOARD, 0);
  b.writeUInt8(copyKey, 1);
  return b;
}

/** SET_CLIPBOARD = type(1) + sequence(i64,8) + paste(1) + u32 len + UTF-8 */
export function encSetClipboard({ sequence = 0n, paste = true, text = '' }) {
  const payload = Buffer.from(String(text), 'utf8');
  const b = Buffer.alloc(14 + payload.length);
  b.writeUInt8(MSG.SET_CLIPBOARD, 0);
  b.writeBigInt64BE(BigInt.asIntN(64, BigInt(sequence)), 1);
  b.writeUInt8(paste ? 1 : 0, 9);
  b.writeUInt32BE(payload.length, 10);
  payload.copy(b, 14);
  return b;
}

/** SET_DISPLAY_POWER = type(1) + u8 on = 2 字节 */
export function encSetDisplayPower(on) {
  const b = Buffer.alloc(2);
  b.writeUInt8(MSG.SET_DISPLAY_POWER, 0);
  b.writeUInt8(on ? 1 : 0, 1);
  return b;
}

/** UHID_CREATE = type(1) + u16 id + u16 vendorId + u16 productId + u8 nameLen + name + u16 dataLen + data */
export function encUhidCreate({ id = 0, vendorId = 0, productId = 0, name = 'dsh', data = Buffer.alloc(0) }) {
  const nameBuf = Buffer.from(String(name), 'utf8').subarray(0, 127);
  const dataBuf = Buffer.from(data || []).subarray(0, 65535);
  const b = Buffer.alloc(8 + nameBuf.length + 2 + dataBuf.length);
  b.writeUInt8(MSG.UHID_CREATE, 0);
  b.writeUInt16BE(id, 1);
  b.writeUInt16BE(vendorId, 3);
  b.writeUInt16BE(productId, 5);
  b.writeUInt8(nameBuf.length, 7);
  nameBuf.copy(b, 8);
  let off = 8 + nameBuf.length;
  b.writeUInt16BE(dataBuf.length, off);
  dataBuf.copy(b, off + 2);
  return b;
}

/** UHID_INPUT = type(1) + u16 id + u16 len + data */
export function encUhidInput({ id = 0, data = Buffer.alloc(0) }) {
  const dataBuf = Buffer.from(data || []).subarray(0, 65535);
  const b = Buffer.alloc(5 + dataBuf.length);
  b.writeUInt8(MSG.UHID_INPUT, 0);
  b.writeUInt16BE(id, 1);
  b.writeUInt16BE(dataBuf.length, 3);
  dataBuf.copy(b, 5);
  return b;
}

/** UHID_DESTROY = type(1) + u16 id */
export function encUhidDestroy({ id = 0 }) {
  const b = Buffer.alloc(3);
  b.writeUInt8(MSG.UHID_DESTROY, 0);
  b.writeUInt16BE(id, 1);
  return b;
}

/** START_APP = type(1) + u8 nameLen + UTF-8 包名（比 adb 的 monkey 快得多，也不用等前台轮询） */
export function encStartApp(name) {
  const pkg = Buffer.from(String(name), 'utf8').subarray(0, 255);
  const b = Buffer.alloc(2 + pkg.length);
  b.writeUInt8(MSG.START_APP, 0);
  b.writeUInt8(pkg.length, 1);
  pkg.copy(b, 2);
  return b;
}

/** RESIZE_DISPLAY = type(1) + u16 width + u16 height = 5 字节（配合 RESET_VIDEO 动态改编码分辨率） */
export function encResizeDisplay(width, height) {
  const b = Buffer.alloc(5);
  b.writeUInt8(MSG.RESIZE_DISPLAY, 0);
  b.writeUInt16BE(clamp(Math.round(width), 1, 65535), 1);
  b.writeUInt16BE(clamp(Math.round(height), 1, 65535), 3);
  return b;
}

/** SCAN_FILE = type(1) + u32 len + UTF-8 路径 */
export function encScanFile(path) {
  const payload = Buffer.from(String(path), 'utf8');
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt8(MSG.SCAN_FILE, 0);
  b.writeUInt32BE(payload.length, 1);
  payload.copy(b, 5);
  return b;
}

/** 无负载消息（只用 1 个 type 字节的那些） */
export function encEmpty(type) {
  const b = Buffer.alloc(1);
  b.writeUInt8(type, 0);
  return b;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/**
 * 按 UTF-8 边界把文本切成每段 ≤ maxBytes 的块。
 * 服务端 `SC_CONTROL_MSG_INJECT_TEXT_MAX_LENGTH` = 300，超了直接报错。
 * 不能按 `slice()` 切 —— 会把一个中文字符劈成半个，注入出来是乱码。
 */
export function splitUtf8(text, maxBytes = TEXT_CHUNK_MAX_BYTES) {
  const s = String(text ?? '');
  const chunks = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (curBytes + n > maxBytes && cur) { chunks.push(cur); cur = ''; curBytes = 0; }
    if (n > maxBytes) throw new Error(`单个字符就超过 ${maxBytes} 字节，无法注入：${JSON.stringify(ch)}`);
    cur += ch; curBytes += n;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 设备 → 宿主的消息（控制 socket 的反方向）。
 * 类型值取自 scrcpy v5.0.1 `app/src/device_msg.h` 的 `enum sc_device_msg_type`：
 *   CLIPBOARD = 0 / ACK_CLIPBOARD = 1 / UHID_OUTPUT = 2 —— **CLIPBOARD 是 0，不是 1**。
 * 报文格式（同文件注释：type 1 字节 + length 4 字节）：
 *   CLIPBOARD      = type(1) + u32 len + UTF-8
 *   ACK_CLIPBOARD  = type(1) + u64 sequence
 *   UHID_OUTPUT    = type(1) + u16 id + u16 size + data
 * 别的类型一律记原始字节不猜 —— 猜错了会把后面的流读乱。
 */
export const DEVICE_MSG = { CLIPBOARD: 0, ACK_CLIPBOARD: 1, UHID_OUTPUT: 2 };

/**
 * 把控制通道包装成"手"。
 *
 * @param {import('node:net').Socket} socket 已经连上的控制 socket
 * @param {{log?:Function, screen?:{width:number,height:number}}} opts
 */
export function createControlChannel(socket, opts = {}) {
  const log = opts.log || (() => {});
  const stats = {
    sent: 0, bytes: 0, errors: 0, deviceMessages: 0, unknownDeviceMsg: 0, outOfRange: 0,
    lastSendUs: null, sendUsTotal: 0, sendCount: 0, lastSeq: 0n,
  };
  let screenWidth = opts.screen?.width || 1080;
  let screenHeight = opts.screen?.height || 2400;
  if (!opts.screen?.width || !opts.screen?.height) {
    log('[control] 没有拿到视频尺寸，先按 1080x2400 兜底 —— 必须尽快 setScreen(视频宽高)，'
      + '否则服务端 PositionMapper 会把所有带坐标的事件丢掉');
  }
  let closed = false;
  const hooks = { error: null, close: null, clipboard: null, ack: null };
  let inbox = Buffer.alloc(0);

  try { socket.setNoDelay(true); } catch { /* 浏览器/非 tcp 时忽略 */ }
  socket.on('error', (e) => {
    closed = true; stats.errors += 1;
    log(`[control] socket 出错：${e.message}`);
    if (hooks.error) hooks.error(e);
  });
  socket.on('close', () => {
    if (!closed) log('[control] socket 已关闭');
    closed = true;
    if (hooks.close) hooks.close();
  });
  socket.on('data', (b) => {
    inbox = Buffer.concat([inbox, b]);
    // 逐条解析；长度不够就留着等下一个 chunk
    for (;;) {
      if (!inbox.length) break;
      const type = inbox[0];
      if (type === DEVICE_MSG.CLIPBOARD) {
        if (inbox.length < 5) break;
        const len = inbox.readUInt32BE(1);
        if (inbox.length < 5 + len) break;
        const text = inbox.subarray(5, 5 + len).toString('utf8');
        inbox = inbox.subarray(5 + len);
        stats.deviceMessages += 1;
        if (hooks.clipboard) hooks.clipboard(text);
        continue;
      }
      if (type === DEVICE_MSG.ACK_CLIPBOARD) {
        if (inbox.length < 9) break;
        const sequence = inbox.readBigInt64BE(1);
        inbox = inbox.subarray(9);
        stats.deviceMessages += 1;
        stats.lastAckSeq = sequence;
        if (hooks.ack) hooks.ack({ type, sequence });
        continue;
      }
      if (type === DEVICE_MSG.UHID_OUTPUT) {
        if (inbox.length < 5) break;
        const size = inbox.readUInt16BE(3);
        if (inbox.length < 5 + size) break;
        inbox = inbox.subarray(5 + size);
        stats.deviceMessages += 1;
        continue;
      }
      // 不认识就别硬解：记下来，把缓冲清空，避免后面全乱套
      stats.unknownDeviceMsg += 1;
      log(`[control] 收到未知设备消息 type=${type}，丢弃 ${inbox.length} 字节缓冲（UNKNOWN_DEVICE_MSG）`);
      inbox = Buffer.alloc(0);
      break;
    }
  });

  function write(buf, label = '') {
    if (closed) return { ok: false, reason: 'closed', bytes: buf.length };
    const t0 = process.hrtime.bigint();
    try {
      socket.write(buf);
    } catch (e) {
      stats.errors += 1;
      log(`[control] 写入失败（${label}）：${e.message}`);
      return { ok: false, reason: e.message, bytes: buf.length };
    }
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    stats.sent += 1; stats.bytes += buf.length;
    stats.lastSendUs = us; stats.sendUsTotal += us; stats.sendCount += 1;
    return { ok: true, us, bytes: buf.length };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function touch(action, x, y, o = {}) {
    return encInjectTouch({
      action, x, y,
      pointerId: o.pointerId ?? POINTER.FINGER,
      screenWidth, screenHeight,
      pressure: o.pressure ?? 1,
      actionButton: o.actionButton ?? 0,
      buttons: o.buttons ?? 0,
    });
  }

  const api = {
    /**
     * 坐标空间 = **视频尺寸**（编码器输出的宽高，例如 808x1800），不是设备像素！
     * scrcpy v5.0.1 的 PositionMapper.map() 会比较 Position.screenSize 与 videoSize，
     * 不相等就直接 `return null` 丢掉整个事件（只有 VERBOSE 日志）——
     * 2026-10-16 卡了很久的「控制通道 tap 完全没反应」就是这个原因。
     */
    setScreen({ width, height }) {
      if (Number.isFinite(width) && width > 0) screenWidth = Math.round(width);
      if (Number.isFinite(height) && height > 0) screenHeight = Math.round(height);
      return { screenWidth, screenHeight };
    },
    get screen() { return { width: screenWidth, height: screenHeight }; },
    /** 坐标越界就吼一声：传了设备像素（1080x2400）却按视频尺寸（808x1800）发，正是最常见的错法 */
    checkPoint(x, y, what = 'point') {
      if (x < 0 || y < 0 || x > screenWidth || y > screenHeight) {
        stats.outOfRange += 1;
        if (stats.outOfRange <= 3) {
          log(`[control] ${what} 坐标 (${x},${y}) 超出视频尺寸 ${screenWidth}x${screenHeight} —— `
            + `注意控制通道要的是视频尺寸坐标，不是设备像素；越界的事件会被服务端静默丢弃`);
        }
        return false;
      }
      return true;
    },
    get available() { return !closed; },
    stats,
    on(event, cb) { if (event in hooks) hooks[event] = cb; return api; },

    sendRaw(buf, label) { return write(buf, label); },

    /**
     * 低层触摸事件 —— 鼠标拖拽/按下的真身（QtScrcpy 就是这个做法：按下 DOWN、移动 MOVE、松开 UP）。
     *
     * 为什么不能用 `swipe()` 代替：`swipe()` 是"我给你一条轨迹、你按 ~12ms 一帧播出来"，
     * 一次性、跟不了手；人用鼠标拖的时候，鼠标在哪里、手机里的手指就得在哪里 ——
     * 只有逐事件回放（DOWN + 每个 MOVE + UP）才跟得上，而且轻点/长按/拖拽全靠 Android 自己判定，
     * 我们不需要再猜 TAP_MAX_MS / TAP_MAX_MOVE 之类的阈值。
     *
     * @param {'down'|'move'|'up'} phase
     */
    touchEvent(phase, x, y, o = {}) {
      const a = phase === 'up' ? ACTION.UP : phase === 'move' ? ACTION.MOVE : ACTION.DOWN;
      api.checkPoint(x, y, `touch-${phase}`);
      const r = write(touch(a, x, y, {
        ...o,
        // 按住时 actionButton/buttons 是"主键按着"，抬起时全部松开 —— 与 scrcpy 客户端一致
        actionButton: o.actionButton ?? (a === ACTION.DOWN ? 1 : 0),
        buttons: o.buttons ?? (a === ACTION.UP ? 0 : 1),
      }), `touch-${phase}`);
      return { ok: r.ok, us: r.us, action: a };
    },

    /**
     * 原始 action 码的触摸事件 —— 多指（双指缩放）必须用它。
     *
     * **每根手指都发 DOWN(0) / UP(1)，中间发 MOVE(2)** —— 不要自己发 POINTER_DOWN(5)/POINTER_UP(6)。
     * 依据 scrcpy v5.0.1 `Controller.injectTouch`：
     * ```java
     * int pointerCount = pointersState.update(...);
     * if (pointerCount == 1) { ... }              // 只有一根手指
     * else {                                      // 备用指针必须自己带上 index
     *     if (action == ACTION_UP)        action = ACTION_POINTER_UP   | (pointerIndex << ACTION_POINTER_INDEX_SHIFT);
     *     else if (action == ACTION_DOWN) action = ACTION_POINTER_DOWN | (pointerIndex << ACTION_POINTER_INDEX_SHIFT);
     * }
     * ```
     * 也就是说 POINTER_* 由**服务端**改写并补 index；客户端直接发 5/6 会被原样透传，
     * Android 看到「pointerIndex 0 又 down 了一次」就整条丢弃（真机实测：相册双指不放大）。
     * 抬起顺序：先发第二根的 UP(1)，再发第一根的 UP(1)。
     */
    touchRaw(action, x, y, o = {}) {
      api.checkPoint(x, y, `touch-raw-${action}`);
      const r = write(touch(action, x, y, {
        ...o,
        actionButton: o.actionButton ?? 0,
        buttons: o.buttons ?? (action === ACTION.UP ? 0 : 1),
      }), `touch-raw-${action}`);
      return { ok: r.ok, us: r.us, action };
    },

    /**
     * 一次真正的滚轮事件（INJECT_SCROLL_EVENT），**不是手势**。
     * `notchesV` 单位 = 一格滚轮（可带小数），**正数 = 内容往前走**（= 鼠标滚轮往下滚 / 手指上滑方向）。
     * 和 `swipe()` 的区别：这是 AXIS_VSCROLL，交给 Android 自己决定滚多少/要不要 fling，
     * 手感与鼠标滚轮一致；合成 swipe 会变成"拽一把再松手"，又慢又飘。
     *
     * **方向约定与标定都是 2026-10-17 真机量的**（`PROBE-P4-drag-wheel.json`：京东搜索结果页，
     * 列表在顶部，滚轮打在 (0.5,0.55)）：
     *   直传时 `notches=-1 → 线上 vScroll=-1 → 内容前进 192 设备像素`（`-3 → 576px`，线性）；
     *   `notches=+1 → 线上 vScroll=+1 → 纹丝不动`（往回滚在列表顶部被夹住，`accepted=false/no-motion`）；
     *   另有独立对照（列表中部、栈差法）：`vScroll=+1 → 内容往回 -60px`。
     * ⇒ **协议里"负 = 前进"，与这里的对外约定（正 = 前进）相反，所以下面取负**。
     * 标定：**1 格 ≈ 192 设备像素 ≈ 0.08 屏**（1080x2400）—— 比"一档半屏"细得多，别再折成 swipe。
     * `SCROLL_MAX_UNITS = 16` 是单事件上限（服务端 `i16 * 16` 定点，实测量程 ±16）。
     * `hScroll` 同轴约定（横向没找到合适页面，**未单独实测**）。
     */
    scroll(x, y, { notchesV = 0, notchesH = 0 } = {}) {
      if (!notchesV && !notchesH) return { ok: true, us: 0, notchesV: 0, notchesH: 0, sent: { vScroll: 0, hScroll: 0 } };
      api.checkPoint(x, y, 'scroll');
      const h = -clamp(notchesH, -SCROLL_MAX_UNITS, SCROLL_MAX_UNITS);
      const v = -clamp(notchesV, -SCROLL_MAX_UNITS, SCROLL_MAX_UNITS);
      const r = write(encInjectScroll({ x, y, screenWidth, screenHeight, hScroll: h, vScroll: v }), 'scroll');
      // sent = 真正写进协议的值（调用方可据此调方向/幅度，`step.sent` 会带回去）
      return { ok: r.ok, us: r.us, notchesV, notchesH, sent: { vScroll: v, hScroll: h } };
    },

    /** 点一下：DOWN + UP。两次 write，中间不留时间 —— 服务端按事件到达顺序注入 */
    tap(x, y, o = {}) {
      api.checkPoint(x, y, 'tap');
      const r1 = write(touch(ACTION.DOWN, x, y, { ...o, actionButton: 1, buttons: 1 }), 'tap-down');
      const r2 = write(touch(ACTION.UP, x, y, { ...o, actionButton: 0, buttons: 0 }), 'tap-up');
      return { ok: r1.ok && r2.ok, us: (r1.us || 0) + (r2.us || 0) };
    },

    /** 长按：DOWN，等 ms，UP */
    async longPress(x, y, ms = 700, o = {}) {
      api.checkPoint(x, y, 'longPress');
      const t0 = Date.now();
      const r1 = write(touch(ACTION.DOWN, x, y, { ...o, actionButton: 1, buttons: 1 }), 'longpress-down');
      await sleep(Math.max(0, ms));
      const r2 = write(touch(ACTION.UP, x, y, { ...o, actionButton: 0, buttons: 0 }), 'longpress-up');
      return { ok: r1.ok && r2.ok, ms: Date.now() - t0 };
    },

    /**
     * 真拖拽：DOWN + 若干 MOVE + UP。
     * adb 的 `input swipe` 只给系统一个起点终点让系统自己插值；这里每一帧 MOVE 都是我们发的事件，
     * 时长由我们控制 —— 这也是"滚动会 fling/不跟手"能治好的地方。
     */
    async swipe(x1, y1, x2, y2, o = {}) {
      api.checkPoint(x1, y1, 'swipe-from');
      api.checkPoint(x2, y2, 'swipe-to');
      const durationMs = Number.isFinite(o.durationMs) ? o.durationMs : 300;
      const steps = Math.max(1, Math.min(o.steps ?? Math.round(durationMs / 12), 120));
      const t0 = Date.now();
      let ok = write(touch(ACTION.DOWN, x1, y1, { ...o, actionButton: 1, buttons: 1 }), 'swipe-down').ok;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        const x = x1 + (x2 - x1) * k;
        const y = y1 + (y2 - y1) * k;
        ok = write(touch(ACTION.MOVE, x, y, { ...o, actionButton: 0, buttons: 1 }), 'swipe-move').ok && ok;
        // 按真实时间铺开，否则设备侧会看成"瞬间瞬移"，列表不会跟手滚
        if (i < steps) await sleep(Math.max(1, Math.round(durationMs / steps)));
      }
      ok = write(touch(ACTION.UP, x2, y2, { ...o, actionButton: 0, buttons: 0 }), 'swipe-up').ok && ok;
      return { ok, ms: Date.now() - t0, steps };
    },

    /**
     * 鼠标滚轮（不是手势）。`vScreens` 正数 = 内容往前走（手指上滑方向）。
     * 一个滚轮格约等于一个 AXIS_VSCROLL=1，按屏滚动要拆成多格，
     * `notchesPerScreen` 是标定值（默认 20，真机实测后改这里）。
     */
    /**
     * 鼠标滚轮（按"屏"给量的旧接口，保留兼容）。
     * 新代码请直接用 `scroll()`：一格可以带小数、一次一个事件，跟鼠标走得更顺；
     * 这个接口会把"几屏"折成格数再逐格发（`notchesPerScreen` 是标定值）。
     */
    async wheel(x, y, { vScreens = 0, hScreens = 0, notchesPerScreen = 20, gapMs = 8 } = {}) {
      const vNotches = Math.round(vScreens * notchesPerScreen);
      const hNotches = Math.round(hScreens * notchesPerScreen);
      const n = Math.max(Math.abs(vNotches), Math.abs(hNotches));
      if (n === 0) return { ok: true, notches: 0 };
      const perV = vNotches / n;
      const perH = hNotches / n;
      const t0 = Date.now();
      let ok = true;
      for (let i = 0; i < n; i++) {
        const r = api.scroll(x, y, { notchesV: perV, notchesH: perH });
        ok = r.ok && ok;
        if (i < n - 1 && gapMs > 0) await sleep(gapMs);
      }
      return { ok, ms: Date.now() - t0, notches: n };
    },

    /**
     * 注入文本，自动按 UTF-8 边界分段（每段 ≤300 字节），段间留 100ms。
     * 这是 adb 路径做不到的能力：`adb input text` 只吃 ASCII，中文静默丢失。
     */
    async text(str, { gapMs = 100 } = {}) {
      const chunks = splitUtf8(String(str));
      if (!chunks.length) return { ok: true, chunks: 0 };
      const t0 = Date.now();
      let ok = true;
      for (let i = 0; i < chunks.length; i++) {
        ok = write(encInjectText(chunks[i]), 'text').ok && ok;
        if (i < chunks.length - 1 && gapMs > 0) await sleep(gapMs);
      }
      return { ok, chunks: chunks.length, ms: Date.now() - t0 };
    },

    /**
     * 清空当前聚焦的输入框：先 MOVE_END 把光标移到末尾，再连发 DEL。
     * 不用 Ctrl+A（metaState 是否被目标 App 认，因 App 而异），DEL 是最钝但最稳的。
     */
    async clearText({ count = 80, gapMs = 6 } = {}) {
      const t0 = Date.now();
      let ok = this.keycode('moveend').ok;
      for (let i = 0; i < count; i++) {
        ok = this.keycode('del').ok && ok;
        if (gapMs > 0) await sleep(gapMs);
      }
      return { ok, keys: count + 1, ms: Date.now() - t0 };
    },

    /** 按键：名字或数字。按下+抬起两条消息（长按由 repeat 表达） */
    keycode(key, { repeat = 0, metaState = 0, releaseAfterMs = 0 } = {}) {
      const code = typeof key === 'number' ? key : KEYCODES[String(key).toLowerCase()];
      if (!code) throw new Error(`未知按键 ${key}（可用: ${Object.keys(KEYCODES).join(', ')}）`);
      const down = write(encInjectKeycode({ action: ACTION.DOWN, keycode: code, repeat, metaState }), 'key-down');
      if (releaseAfterMs > 0) {
        return sleep(releaseAfterMs).then(() => write(encInjectKeycode({ action: ACTION.UP, keycode: code, repeat: 0, metaState }), 'key-up'));
      }
      const up = write(encInjectKeycode({ action: ACTION.UP, keycode: code, repeat: 0, metaState }), 'key-up');
      return { ok: down.ok && up.ok, code, us: (down.us || 0) + (up.us || 0) };
    },

    /** 返回键（走 BACK_OR_SCREEN_ON，不是 keyevent —— 息屏时它会亮屏而不是返回） */
    back(action = ACTION.DOWN) { return write(encBackOrScreenOn(action), 'back'); },
    /** 启动 App：服务端直接 START_APP，不用 monkey，也不用等前台轮询 */
    startApp(pkg) { return write(encStartApp(pkg), 'start-app'); },

    setDisplayPower(on) { return write(encSetDisplayPower(on), 'display-power'); },
    rotate() { return write(encEmpty(MSG.ROTATE_DEVICE), 'rotate'); },
    expandNotificationPanel() { return write(encEmpty(MSG.EXPAND_NOTIFICATION_PANEL), 'expand-panel'); },
    collapsePanels() { return write(encEmpty(MSG.COLLAPSE_PANELS), 'collapse-panels'); },
    resetVideo() { return write(encEmpty(MSG.RESET_VIDEO), 'reset-video'); },
    resizeDisplay(width, height) { return write(encResizeDisplay(width, height), 'resize-display'); },
    scanFile(path) { return write(encScanFile(path), 'scan-file'); },

    /** 写剪贴板；`paste=true` 让设备侧直接粘贴（中文/长文本的可靠路径） */
    setClipboard(text, { paste = true } = {}) {
      stats.lastSeq += 1n;
      return write(encSetClipboard({ sequence: stats.lastSeq, paste, text }), 'set-clipboard');
    },
    /**
     * 请求手机剪贴板。copyKey: 0=NONE（只问，不按键）/ 1=COPY / 2=CUT。
     * 注意服务端 `getClipboard()` 的语义：只有 `clipboard_autosync=false` 才会回包，
     * autosync 开着（默认）时手机剪贴板一变就主动推 —— 见 session.js readDeviceClipboard。
     */
    getClipboard({ copyKey = 0, cut = false } = {}) {
      const k = cut ? 2 : copyKey;
      return write(encGetClipboard(k), 'get-clipboard');
    },

    uhidCreate(o) { return write(encUhidCreate(o), 'uhid-create'); },
    uhidInput(o) { return write(encUhidInput(o), 'uhid-input'); },
    uhidDestroy(o) { return write(encUhidDestroy(o), 'uhid-destroy'); },

    /** 收尾：不主动 destroy（socket 归会话管），只把状态标出来 */
    close() { closed = true; },
  };

  return api;
}
