/**
 * Android 长截图：逐帧 screencap + 运动估计增量拼接。
 *
 * 与网页版的唯一区别是「抓帧/滚动」来自 adb 而不是 Playwright；
 * 拼接器（`src/core/stitch.js`）原样复用 —— 它已经过 35 项合成回归，
 * 并在 4 种真实页面结构（文档滚动 / 内嵌容器 / transform 手势 / 一屏）上验过，
 * 包含「自动识别固定顶栏/底栏并遮掉」的能力（手机 App 普遍有固定底栏，这条很关键）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { createStitcher, writeStitched, DEFAULT_STITCH } from '../core/stitch.js';
import { screencap, screenMetrics, scrollByScreen, uiDump } from './adb.js';
import { overlayMaskFromUi } from './overlay.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 截一张整屏图（写盘）。 */
export async function androidShot(serial, outPath, opts = {}) {
  const shot = await screencap(serial, opts);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, shot.buffer);
  return { path: outPath, bytes: shot.buffer.length, width: shot.size.width, height: shot.size.height, via: shot.via, mode: 'viewport' };
}

/**
 * 边滚边抓边拼。
 * @returns {Promise<{path,bytes,width,height,mode,chunks,offsets,masks,log,steps,metrics}>}
 */
export async function androidLongshot(serial, outPath, opts = {}) {
  const metrics = opts.metrics || (await screenMetrics(serial));
  // 固定栏高度先问控件树要（真机底栏像素法量不准：实测 150px 只量到 21px，见 overlay.js）
  let uiMask = { top: 0, bottom: 0, from: 'skipped' };
  if (opts.uiMask !== false) {
    try {
      const ui = await uiDump(serial, { max: 400 });
      uiMask = overlayMaskFromUi(ui.nodes, metrics);
    } catch (e) {
      uiMask = { top: 0, bottom: 0, from: `error: ${e.message}` };
    }
  }
  const cfg = {
    ...DEFAULT_STITCH,
    maskTop: Math.max(opts.maskTop ?? 0, uiMask.top),
    maskBottom: Math.max(opts.maskBottom ?? 0, uiMask.bottom),
    stepRatio: opts.stepRatio ?? DEFAULT_STITCH.stepRatio,
    settleMs: opts.settleMs ?? 500, // 手机滑动后有惯性/图片懒加载，比网页更需要等
    maxSteps: opts.maxSteps ?? 30,
    maxHeight: opts.maxHeight ?? DEFAULT_STITCH.maxHeight,
  };
  const st = createStitcher(cfg);
  const steps = [];

  for (let i = 0; i < cfg.maxSteps; i += 1) {
    // 用户在侧栏点「停止」：不丢已经拼好的部分，直接收尾（侧栏截图机就是这么停的）
    if (typeof opts.shouldStop === 'function' && opts.shouldStop()) break;
    const shot = await screencap(serial, { timeoutMs: opts.timeoutMs ?? 60000 });
    const r = st.push(shot.buffer);
    const step = {
      i,
      accepted: r.accepted,
      reason: r.reason,
      dy: r.dy ?? 0,
      height: r.height,
      via: shot.via,
      bytes: shot.size?.bytes ?? 0,
    };
    steps.push(step);
    if (typeof opts.onStep === 'function') { try { opts.onStep(step); } catch { /* 回调出错不能影响拼接 */ } }
    if (!r.accepted && st.consecutiveRejects >= 2) break; // 连续两帧没动 = 到底/卡住，和 SnowShot 的 frame_rejected 收工语义一致
    // 显式传 swipeMs 才覆盖默认时长；默认让 adb.scrollByScreen 按距离算（避免 fling 飞出重叠区）
    await scrollByScreen(serial, metrics, cfg.stepRatio, opts.swipeMs ? { durationMs: opts.swipeMs } : {});
    await sleep(cfg.settleMs);
  }

  const result = st.result();
  const written = await writeStitched(result, outPath, { maxHeight: cfg.maxHeight, chunkHeight: opts.chunkHeight });
  return { ...written, offsets: result.offsets, masks: st.masks, uiMask, log: result.log, steps, metrics };
}

/** 滚回顶部（长截图结束后把手机复位，少留副作用）。 */
export async function scrollToTop(serial, opts = {}) {
  const metrics = opts.metrics || (await screenMetrics(serial));
  const times = opts.times ?? 12;
  for (let i = 0; i < times; i += 1) {
    // 向上的长距离滑动，比 keyevent HOME 温和（不会把 App 切走）
    await scrollByScreen(serial, metrics, -0.85, { durationMs: 120 }).catch(() => '');
  }
}
