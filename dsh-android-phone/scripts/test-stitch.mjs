/**
 * 逐帧拼接器（src/mobile/stitch.js）确定性回归 —— 不需要浏览器、不需要外网。
 *
 * 思路：在 Node 里合成一张"很长的网页"，按滚动计划裁成若干"视口帧"
 * （可以加固定头部/底部、加噪声、做成周期图案），喂给拼接器，
 * 再拿结果和原图逐像素比。这样"拼接是否正确"是被证明的，不是瞄一眼截图觉得对。
 *
 * 跑法：node scripts/test-stitch.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const mod = (f) => import(pathToFileURL(path.join(pluginDir, 'src', 'core', f)).href);
const { encodePng, decodePng, isPng, cropRows, blankImage } = await mod('png.js');
const { createStitcher, stitchFrames, estimateOffset, buildProfile, writeStitched } = await mod('stitch.js');

const OUT = path.join(pluginDir, '..', 'recon', 'android-shots', 'stitch');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const info = (s) => console.log(`  ${s}`);

const W = 390;
const FRAME_H = 664;

/** 造"网页内容"：行渐变 + 确定性伪随机纹理（保证不含纯红/纯蓝，后面要用颜色判固定条） */
function content(w, h, seed = 1) {
  const img = blankImage(w, h);
  for (let y = 0; y < h; y++) {
    const base = 40 + ((y * 7 + seed * 13) % 120);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = (Math.imul(x + 1, 2654435761) ^ Math.imul(y + 1, 40503) ^ Math.imul(seed, 2246822519)) >>> 0;
      img.data[i] = (base + (n & 63)) & 0xff;
      img.data[i + 1] = (base + ((n >> 7) & 63)) & 0xff;
      img.data[i + 2] = (base + ((n >> 13) & 63)) & 0xff;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** 周期图案：每 period 行完全重复（模拟"整齐的商品格子"这种天然歧义内容） */
function periodic(w, h, period = 100, seed = 3) {
  const img = blankImage(w, h);
  const tile = content(w, period, seed);
  for (let y = 0; y < h; y++) tile.data.copy(img.data, y * w * 4, (y % period) * w * 4, ((y % period) + 1) * w * 4);
  return img;
}

function paintRows(img, y0, count, [r, g, b]) {
  for (let y = y0; y < y0 + count && y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  return img;
}

/** 给所有帧加上固定头部/底部（模拟浮在内容上的 titlebar / 手机底栏） */
function withBars(frame, { top = 0, bottom = 0 } = {}) {
  const f = { width: frame.width, height: frame.height, channels: 4, data: Buffer.from(frame.data) };
  if (top) paintRows(f, 0, top, [255, 0, 0]);
  if (bottom) paintRows(f, f.height - bottom, bottom, [0, 0, 255]);
  return f;
}

function addNoise(frame, amp, seed) {
  const f = { width: frame.width, height: frame.height, channels: 4, data: Buffer.from(frame.data) };
  let s = seed >>> 0;
  for (let i = 0; i < f.data.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const d = ((s >>> 16) % (2 * amp + 1)) - amp;
      f.data[i + k] = Math.max(0, Math.min(255, f.data[i + k] + d));
    }
  }
  return f;
}

/** 逐像素比 a 的 [y0, y0+rows) 与 b 的 [y1, y1+rows)：返回首个不同点 / null */
function diffRegion(a, y0, b, y1, rows) {
  for (let y = 0; y < rows; y++) {
    const oa = (y0 + y) * a.width * 4;
    const ob = (y1 + y) * b.width * 4;
    for (let i = 0; i < a.width * 4; i++) {
      if (a.data[oa + i] !== b.data[ob + i]) {
        return { row: y, col: Math.floor(i / 4), a: a.data[oa + i], b: b.data[ob + i] };
      }
    }
  }
  return null;
}

function countColor(img, [r, g, b], rows = img.height) {
  let n = 0;
  for (let i = 0; i < rows * img.width * 4; i += 4) {
    if (img.data[i] === r && img.data[i + 1] === g && img.data[i + 2] === b) n++;
  }
  return n;
}

// cropRows 的第二个参数是"结束行号"（不是高度），别写成 y+FRAME_H 之外的东西
const framesFrom = (src, plan, bar) => plan.map((y) => withBars(cropRows(src, y, Math.min(src.height, y + FRAME_H)), bar));

// ── 1) PNG 编解码往返（拼接的地基） ──────────────────────────────────────────
{
  const img = content(120, 90);
  const buf = encodePng(img);
  const back = decodePng(buf);
  check('png: 编码结果带 PNG 签名', isPng(buf), buf.subarray(0, 4).toString('hex'));
  check('png: 往返尺寸一致', back.width === 120 && back.height === 90, `${back.width}x${back.height}`);
  check('png: 往返像素完全一致', Buffer.compare(back.data, img.data) === 0, `${buf.length}B`);
}

// ── 2) 无固定条、无损内容 → 拼出来必须和原图一模一样 ─────────────────────────
{
  const src = content(W, 2000);
  const plan = [0, 300, 600, 900, 1200, 1336]; // 最后一步只有 136px（撞到底了）
  const res = stitchFrames(framesFrom(src, plan, {}), { maskTop: 0, maskBottom: 0 });
  info(`offsets=${JSON.stringify(res.offsets)} height=${res.height} accepted=${res.accepted} rejected=${res.rejected}`);
  check('精确拼接: offsets 等于滚动计划差', JSON.stringify(res.offsets) === JSON.stringify([300, 300, 300, 300, 136]), JSON.stringify(res.offsets));
  check('精确拼接: 高度等于原页高 2000', res.height === 2000, String(res.height));
  const d = diffRegion(res, 0, src, 0, 2000);
  check('精确拼接: 逐像素等于原图', !d, d ? JSON.stringify(d) : '0 diffs');
}

// ── 3) 固定头部 + 固定底部（maskTop/maskBottom）→ 固定条不许出现在结果里 ────────
{
  const src = content(W, 2100);
  const plan = [0, 320, 640, 960, 1280, 1436];
  const res = stitchFrames(framesFrom(src, plan, { top: 50, bottom: 60 }), { maskTop: 50, maskBottom: 60 });
  const expectH = 1436 + FRAME_H - 60 - 50;
  info(`height=${res.height} expect=${expectH} red=${countColor(res, [255, 0, 0])} blue=${countColor(res, [0, 0, 255])}`);
  check('固定条: 高度 = 末帧位置 + 视口 - 下固定条 - 上固定条', res.height === expectH, `${res.height} vs ${expectH}`);
  const d = diffRegion(res, 0, src, 50, expectH);
  check('固定条: 像素等于原图 [50, 50+h)（内容未被固定条污染）', !d, d ? JSON.stringify(d) : '0 diffs');
  check('固定条: 结果里没有红色头部的残留', countColor(res, [255, 0, 0]) === 0, String(countColor(res, [255, 0, 0])));
  check('固定条: 结果里没有蓝色底栏的残留', countColor(res, [0, 0, 255]) === 0, String(countColor(res, [0, 0, 255])));
}

// ── 4) 每帧带独立噪声（模拟抗锯齿/动画/抖动）→ 仍然拼对 ───────────────────────
{
  const src = content(W, 2000);
  const plan = [0, 300, 600, 900, 1200, 1336];
  const frames = framesFrom(src, plan, {}).map((f, i) => addNoise(f, 4, i + 1));
  const res = stitchFrames(frames, { maskTop: 0, maskBottom: 0 });
  info(`offsets=${JSON.stringify(res.offsets)} height=${res.height}`);
  check('带噪声: offsets 仍然正确', JSON.stringify(res.offsets) === JSON.stringify([300, 300, 300, 300, 136]), JSON.stringify(res.offsets));
  check('带噪声: 高度正确', res.height === 2000, String(res.height));
}

// ── 5) 页面没动（同一帧连喂两次）→ 拒帧，不重复贴 ─────────────────────────────
{
  const src = content(W, 1500);
  const f0 = cropRows(src, 0, FRAME_H);
  const st = createStitcher({});
  const r1 = st.push(f0);
  const r2 = st.push(f0);
  info(`1st=${r1.accepted}/${r1.reason} 2nd=${r2.accepted}/${r2.reason} height=${st.height}`);
  check('静止帧: 第一帧接受', r1.accepted === true, r1.reason);
  check('静止帧: 第二帧被拒（no-motion）', r2.accepted === false && r2.reason === 'no-motion', r2.reason);
  check('静止帧: 画布高度没变', st.height === FRAME_H, String(st.height));
  st.push(f0);
  check('静止帧: 连续被拒计数 = 2（调用方据此停手）', st.consecutiveRejects === 2, String(st.consecutiveRejects));
}

// ── 6) 周期图案（天然歧义）→ 宁可拒帧也不拼错 ────────────────────────────────
{
  // 周期 100 的内容、步长 250 → dy ≡ 250 (mod 100)，即 50/150/250 都是候选，代价几乎一样
  const src = periodic(W, 2000, 100);
  const res = stitchFrames(framesFrom(src, [0, 250, 500], {}), { maskTop: 0, maskBottom: 0 });
  const reasons = res.log.filter((l) => !l.accepted).map((l) => l.reason);
  info(`offsets=${JSON.stringify(res.offsets)} reasons=${JSON.stringify(reasons)}`);
  check('周期图案: 没有接受任何一次假位移', res.offsets.length === 0, JSON.stringify(res.offsets));
  check('周期图案: 拒帧理由是歧义类', reasons.includes('ambiguous-motion') || reasons.includes('low-confidence'), JSON.stringify(reasons));
}

// ── 7) 纯色/极低纹理 → 也不许凭空拼 ─────────────────────────────────────────
{
  const flat = blankImage(W, 2000);
  paintRows(flat, 0, 2000, [128, 128, 128]);
  const res = stitchFrames(framesFrom(flat, [0, 300, 600], {}), { maskTop: 0, maskBottom: 0 });
  check('纯色页: 拒帧（不凭空加高）', res.height === FRAME_H && res.offsets.length === 0, `height=${res.height}`);
}

// ── 8) 单元级：已知位移 137px 要估出来 ────────────────────────────────────────
{
  const src = content(W, 1200);
  const a = cropRows(src, 0, FRAME_H);
  const b = cropRows(src, 137, FRAME_H);
  const est = estimateOffset(buildProfile(a, {}), buildProfile(b, {}), {});
  info(`dy=${est.dy} gain=${est.gain.toFixed(3)} matched=${est.matchedRatio.toFixed(3)} second=${est.secondDy}`);
  check('估计器: 137px 位移估对', est.accepted && est.dy === 137, `dy=${est.dy} ${est.reason}`);
}

// ── 8b) 真机实况回归：固定底栏 + autoMask 自动量高度（手机上人人都有底栏） ────
{
  const truth = 443;
  const barH = 48;
  const src = content(W, 1600);
  const withBar = (y) => withBars(cropRows(src, y, Math.min(src.height, y + FRAME_H)), { bottom: barH });
  const a = withBar(0);
  const b = withBar(truth);
  const est = estimateOffset(buildProfile(a, {}), buildProfile(b, {}), {});
  info(`固定底栏(用户没给 mask) dy=${est.dy} overlayBottom=${est.overlayBottom} gain=${est.gain.toFixed(3)} matched=${est.matchedRatio.toFixed(3)}`);
  check('固定底栏: 位移仍估对，且量出底栏高度', est.accepted && est.dy === truth && est.overlayBottom === barH,
    `dy=${est.dy} overlayBottom=${est.overlayBottom} ${est.reason}`);

  const res = stitchFrames([a, b, withBar(truth * 2)], {});
  const wantH = truth * 2 + FRAME_H - barH; // 末帧位置 + 视口 - 底栏
  const auto = (res.log ?? []).find((e) => e.reason === 'auto-mask');
  info(`autoMask 拼接 height=${res.height} (期望 ${wantH}) offsets=${JSON.stringify(res.offsets)} auto=${JSON.stringify(auto ?? null)}`);
  check('autoMask: 决策日志记录了量到的底栏高度', !!auto && auto.to && auto.to.bottom === barH, JSON.stringify(auto ?? null));
  check('autoMask: 长图高度 = 末帧位置 + 视口 - 底栏', res.height === wantH, `${res.height} vs ${wantH}`);
  check('autoMask: 长图里没有残留的固定底栏像素', countColor(res, [0, 0, 255]) === 0, `blue=${countColor(res, [0, 0, 255])}`);
  const dBar = diffRegion(res, 0, src, 0, wantH);
  check('autoMask: 拼接内容逐像素等于原图', !dBar, dBar ? JSON.stringify(dBar) : '0 diffs');

  // 顶栏 + 底栏同时存在（真实手机页就是这个样子：状态栏/搜索框 + tab 栏）
  const topH = 56;
  const withBoth = (y) => withBars(cropRows(src, y, Math.min(src.height, y + FRAME_H)), { top: topH, bottom: barH });
  const estT = estimateOffset(buildProfile(withBoth(0), {}), buildProfile(withBoth(truth), {}), {});
  check('固定顶栏+底栏: 两个高度都量对', estT.overlayTop === topH && estT.overlayBottom === barH,
    `top=${estT.overlayTop} bottom=${estT.overlayBottom}`);
  const resT = stitchFrames([withBoth(0), withBoth(truth)], {});
  const wantT = truth + FRAME_H - topH - barH;
  const dT = diffRegion(resT, 0, src, topH, wantT);
  info(`autoMask(顶+底) height=${resT.height} (期望 ${wantT}) red=${countColor(resT, [255, 0, 0])} blue=${countColor(resT, [0, 0, 255])}`);
  check('autoMask(顶+底): 高度正确、无残留固定条、内容等于原图（从顶栏下面开始比）',
    resT.height === wantT && countColor(resT, [255, 0, 0]) === 0 && countColor(resT, [0, 0, 255]) === 0 && !dT,
    `h=${resT.height} vs ${wantT} red=${countColor(resT, [255, 0, 0])} blue=${countColor(resT, [0, 0, 255])} diff=${dT ? JSON.stringify(dT) : '0'}`);
}

// ── 9) 画布上限：到顶就停（SnowShot 的 chunk_size 语义） ─────────────────────
{
  const src = content(W, 2000);
  const res = stitchFrames(framesFrom(src, [0, 300, 600, 900], {}), { maskTop: 0, maskBottom: 0, maxHeight: 1200 });
  info(`height=${res.height} stopped=${res.stopped} log=${JSON.stringify(res.log.map((l) => `${l.reason}:${l.height}`))}`);
  check('画布上限: 高度不超过上限', res.height <= 1200, String(res.height));
  check('画布上限: 记录了 height-cap 停止原因', res.stopped === 'height-cap', String(res.stopped));
}

// ── 10) 超长结果分块写出，拼回去等于原图 ─────────────────────────────────────
{
  const src = content(W, 6000);
  const path1 = path.join(OUT, 'chunked.png');
  const written = await writeStitched(src, path1, { maxHeight: 2000, chunkHeight: 2000 });
  info(`mode=${written.mode} chunks=${written.chunks.length} heights=${written.chunks.map((c) => c.height).join(',')}`);
  check('分块: 6000px 结果按 2000 切成 3 块', written.mode === 'stitched-chunks' && written.chunks.length === 3, written.mode);
  check('分块: 每块尺寸正确', written.chunks.every((c) => c.width === W && c.height === 2000), JSON.stringify(written.chunks.map((c) => c.height)));
  let ok = true;
  for (let i = 0; i < written.chunks.length; i++) {
    const img = decodePng(fs.readFileSync(written.chunks[i].path));
    if (diffRegion(img, 0, src, i * 2000, img.height)) { ok = false; break; }
  }
  check('分块: 每块逐像素等于原图对应段（拼回来就是原图）', ok);
  const single = await writeStitched(cropRows(src, 0, 1500), path.join(OUT, 'single.png'), { maxHeight: 2000 });
  check('不分块: 高度不超上限就只写一张', single.mode === 'stitched' && single.chunks.length === 0, single.mode);
}

// ── 11) 性能：38 帧、390x664，拼接耗时 ───────────────────────────────────────
{
  const src = content(W, 12000);
  const plan = Array.from({ length: 38 }, (_, i) => i * 300); // 最后一帧 11100+664 = 11764 <= 12000
  const frames = framesFrom(src, plan, {});
  const t0 = Date.now();
  const res = stitchFrames(frames, { maskTop: 0, maskBottom: 0 });
  const ms = Date.now() - t0;
  const expectH = 37 * 300 + FRAME_H;
  info(`38 帧拼接 ${ms}ms，结果 ${res.width}x${res.height}（期望高 ${expectH}）`);
  check('性能: 38 帧拼接 < 15s', ms < 15000, `${ms}ms`);
  check('性能: offsets 全为 300 且高度正确', res.offsets.length === 37 && res.offsets.every((d) => d === 300) && res.height === expectH, `offsets=${res.offsets.length} h=${res.height}`);
}

const passed = results.filter((r) => r.ok).length;
const report = {
  ok: passed === results.length,
  total: results.length,
  passed,
  failed: results.length - passed,
  checks: results,
  ranAt: new Date().toISOString(),
};
const reportPath = path.join(pluginDir, '..', 'recon', 'reports', 'android-stitch-report.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });   // 目录可能不存在（换机器/首次跑）
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\n${report.ok ? 'ALL PASS' : 'FAILED'}  (${passed}/${results.length}) -> recon/reports/stitch-report.json`);
process.exit(report.ok ? 0 : 1);
