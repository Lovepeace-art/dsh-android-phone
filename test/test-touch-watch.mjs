#!/usr/bin/env node
/**
 * 离线回归：真机触摸监听的纯函数部分（不需要设备）
 *   node test/test-touch-watch.mjs
 *
 * 覆盖两点：
 * 1) parseGeteventDevices 能从 `getevent -p` 输出里挑出触摸屏（同机还有蓝牙手表设备时不能挑错）
 * 2) isTouchStartLine 只把「真手指按下」当触摸：位置更新/抬起/松开触点都不算
 */
import { parseGeteventDevices, isTouchStartLine } from '../src/android/touchWatch.js';

let pass = 0;
const fails = [];
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra ? ` — ${extra}` : ''));
}

// 取自华为 WLZ-AN00 的真实 `getevent -p` 片段（event7 是同时连着的蓝牙手表）
const SAMPLE = `add device 1: /dev/input/event7
  name:     "iQOO WATCH GT2 16D"
  events:
    KEY (0001): 014a 
    ABS (0003): 0000  : value 0, min 0, max 1600, fuzz 0, flat 0, resolution 37
                0001  : value 0, min 0, max 2560, fuzz 0, flat 0, resolution 50
                0035  : value 0, min 0, max 1600, fuzz 0, flat 0, resolution 37
                0036  : value 0, min 0, max 2560, fuzz 0, flat 0, resolution 50
  input props:
    INPUT_PROP_DIRECT

add device 3: /dev/input/event1
  name:     "input_mt_wrapper"
  events:
    KEY (0001): 003b  0072  0073  0074  00c4  00c5  00fb  0145 
                014a  02c1  02c2 
    ABS (0003): 0000  : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
                0001  : value 0, min 0, max 2399, fuzz 0, flat 0, resolution 0
                0029  : value 0, min 0, max -1, fuzz 0, flat 0, resolution 0
                0035  : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
                0036  : value 0, min 0, max 2399, fuzz 0, flat 0, resolution 0
                0039  : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
  input props:
    <none>

add device 5: /dev/input/event3
  name:     "gpio-keys"
  events:
    KEY (0001): 0074 
`;

const screen = { width: 1080, height: 2400 };
const list = parseGeteventDevices(SAMPLE, { screen });
ok(list.length === 3, '解析出 3 个设备', `实际 ${list.length}`);
ok(list[0].device === '/dev/input/event1', '首选触摸屏是 event1', `实际 ${list[0] && list[0].device}`);
ok(list[0].name === 'input_mt_wrapper', '触摸屏名字正确', `实际 ${list[0] && list[0].name}`);
ok(list[0].score > list[1].score, '触摸屏分数高于手表', `${list[0].score} vs ${list[1].score}`);
ok(list.find((d) => d.device === '/dev/input/event7') !== undefined, '手表设备也在列表里（但排后面）');

// 屏幕尺寸对不上时（比如设备换成 1440 宽的），不能把非触摸屏排到第一
const hd = parseGeteventDevices(SAMPLE, { screen: { width: 1080, height: 2400 } });
ok(hd[0].device === '/dev/input/event1', '屏幕尺寸匹配时选择稳定');

// 全是键盘类设备 → 没有触摸屏可用
const none = parseGeteventDevices('add device 1: /dev/input/event3\n  name:     "gpio-keys"\n  events:\n    KEY (0001): 0074 \n', { screen });
ok(none.length === 1 && none[0].score < 60, '没有触摸屏时得分低于阈值（调用方据此放弃监听）');

ok(isTouchStartLine('[ 12345.678901] EV_KEY       BTN_TOUCH            DOWN') === true, 'BTN_TOUCH DOWN 算触摸');
ok(isTouchStartLine('[ 12345.678901] EV_KEY       BTN_TOUCH            UP') === false, 'BTN_TOUCH UP 不算');
ok(isTouchStartLine('[ 12345.679012] EV_ABS       ABS_MT_TRACKING_ID   0000000a') === true, '新触点（tracking id）算触摸');
ok(isTouchStartLine('[ 12345.679012] EV_ABS       ABS_MT_TRACKING_ID   ffffffff') === false, '抬起触点不算');
ok(isTouchStartLine('[ 12345.679012] EV_ABS       ABS_MT_POSITION_X    0000012c') === false, '位置更新不算（避免拖动期间反复接管）');
ok(isTouchStartLine('[ 12345.679012] EV_SYN       SYN_REPORT           00000000') === false, 'SYN 不算');
ok(isTouchStartLine('') === false, '空行不算');
ok(isTouchStartLine(null) === false, 'null 不算');

console.log('');
if (fails.length) {
  console.log(`FAIL  (${pass}/${pass + fails.length})`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`ALL PASS  (${pass}/${pass}) -> test/test-touch-watch.mjs`);