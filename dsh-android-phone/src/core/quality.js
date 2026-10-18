/**
 * 长截图质量自检（可复用模块）：判断拼接结果有没有「重复贴同一段」或「固定栏没被遮掉」。
 *
 * 为什么需要它：拼错时（估计错位移、遮罩没生效）画面往往"看起来还行"，
 * 但会有一段内容被贴两遍、或者固定栏在长图里反复出现。早前京东 App 首页的
 * 长截图就是这样：底栏只遮了 21px，结果底栏每隔一步被贴一次，肉眼要滚很久才发现。
 * 实测判别力（同一台真机、同一页面）：
 *   - 旧图（底栏遮 21px，1080x8862）：精确重复块 300 处（如 row 3238 == row 8733，相隔 4 步）
 *   - 新图（控件树遮 235/190，1080x8939）：精确重复块 0 处
 * 块高用 100 而不是 240：被贴的固定栏只有 ~129 行，240 行窗口碰不上。
 *
 * 三个指标：
 *   1) duplicates：每 block 行压成一个签名哈希，找相隔 ≥minGap 行的完全相同块。
 *   2) coarse：block 行块的 8x16 均值描述子，滑窗 20 行采样，找平均亮度差 ≤6 的远处块
 *      （真实商品卡撞脸会有少量，默认容忍 3 处）。
 *   3) runs：连续 >150 行逐行签名相同 —— 典型是没遮掉的白色固定栏。
 */
import { createHash } from 'node:crypto';

const SIG_COLS = 48;
const COARSE_ROWS = 8;
const COARSE_COLS = 16;

export function rowSignatures(img, cols = SIG_COLS) {
  const { width, height, channels, data } = img;
  const xs = [];
  for (let i = 0; i < cols; i += 1) xs.push(Math.round((width * (i + 0.5)) / cols));
  const sig = [];
  for (let y = 0; y < height; y += 1) {
    const base = y * width * channels;
    const row = Buffer.alloc(cols);
    for (let i = 0; i < cols; i += 1) {
      const p = base + xs[i] * channels;
      row[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    sig.push(row);
  }
  return sig;
}

function coarseAt(rowSig, y0, block) {
  const v = new Float64Array(COARSE_ROWS * COARSE_COLS);
  const seg = Math.max(1, Math.floor(block / COARSE_ROWS));
  for (let r = 0; r < COARSE_ROWS; r += 1) {
    for (let c = 0; c < COARSE_COLS; c += 1) {
      let sum = 0;
      let n = 0;
      for (let k = 0; k < seg; k += 1) {
        const row = rowSig[y0 + r * seg + k];
        if (!row) continue;
        const from = Math.floor((c * row.length) / COARSE_COLS);
        const to = Math.floor(((c + 1) * row.length) / COARSE_COLS);
        for (let i = from; i < to; i += 1) { sum += row[i]; n += 1; }
      }
      v[r * COARSE_COLS + c] = n ? sum / n : 0;
    }
  }
  return v;
}

/**
 * @param {{width:number,height:number,channels:number,data:Buffer}} img decodePng() 的结果
 * @param {{block?:number,minGap?:number,coarseTolerated?:number,coarseMax?:number}} opts
 * @returns {{ok:boolean,width:number,height:number,block:number,duplicates:Array,coarse:Array,runs:Array,reason:string}}
 */
export function checkStitchQuality(img, opts = {}) {
  const block = opts.block ?? 100;
  const minGap = opts.minGap ?? 400;
  const coarseTolerated = opts.coarseTolerated ?? 3;
  const coarseMax = opts.coarseMax ?? 6;
  const { width, height } = img;
  const rowSig = opts.rowSig || rowSignatures(img);

  // 1) 精确重复块
  const blocks = new Map();
  for (let y = 0; y + block <= height; y += 1) {
    const h = createHash('sha1');
    for (let k = 0; k < block; k += 1) h.update(rowSig[y + k]);
    const key = h.digest('hex');
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(y);
  }
  const duplicates = [];
  for (const [, ys] of blocks) {
    for (let i = 0; i < ys.length; i += 1) {
      for (let j = i + 1; j < ys.length; j += 1) {
        if (Math.abs(ys[j] - ys[i]) >= minGap) duplicates.push({ a: ys[i], b: ys[j], gap: Math.abs(ys[j] - ys[i]) });
      }
    }
  }
  duplicates.sort((x, y) => y.gap - x.gap);

  // 2) 粗粒度重复块（滑窗：固定栏每次出现的相位不同）
  const step = Math.max(20, Math.floor(block / 6));
  const coarse = [];
  for (let y = 0; y + block <= height; y += step) coarse.push({ y, v: coarseAt(rowSig, y, block) });
  const coarseHits = [];
  for (let i = 0; i < coarse.length; i += 1) {
    for (let j = i + 1; j < coarse.length; j += 1) {
      if (coarse[j].y - coarse[i].y < minGap) continue;
      let sum = 0;
      for (let k = 0; k < coarse[i].v.length; k += 1) sum += Math.abs(coarse[i].v[k] - coarse[j].v[k]);
      const mad = sum / coarse[i].v.length;
      if (mad <= coarseMax) coarseHits.push({ a: coarse[i].y, b: coarse[j].y, mad: Number(mad.toFixed(2)) });
    }
  }
  coarseHits.sort((x, y) => x.mad - y.mad);

  // 3) 连续同签名行
  const runs = [];
  let start = 0;
  for (let y = 1; y <= height; y += 1) {
    const same = y < height && rowSig[y].equals(rowSig[start]);
    if (!same) {
      if (y - start >= 60) runs.push({ from: start, to: y - 1, rows: y - start });
      start = y;
    }
  }
  const longRuns = runs.filter((r) => r.rows > 150).sort((a, b) => b.rows - a.rows);

  const ok = duplicates.length === 0 && longRuns.length === 0 && coarseHits.length <= coarseTolerated;
  const reason = ok
    ? 'OK'
    : [
      duplicates.length ? `重复贴段 ${duplicates.length} 处` : '',
      longRuns.length ? `疑似未遮的固定栏 ${longRuns.length} 处` : '',
      coarseHits.length > coarseTolerated ? `粗粒度相似 ${coarseHits.length} 处` : '',
    ].filter(Boolean).join('；');
  return {
    ok,
    width,
    height,
    block,
    duplicates: duplicates.slice(0, 10),
    duplicateCount: duplicates.length,
    coarse: coarseHits.slice(0, 10),
    coarseCount: coarseHits.length,
    runs: longRuns.slice(0, 10),
    runCount: longRuns.length,
    reason,
  };
}
