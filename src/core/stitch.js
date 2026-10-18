/**
 * 长截图"逐帧拼接"（参考 SnowShot 的 snow-stitch-images 思路，纯 JS 重写）
 *
 * SnowShot（D:\Ruan\SnowShot）的长截图不是靠浏览器 API，而是：
 *   逐帧抓屏 → 每帧估计与上一帧的运动 → 只把"新露出来的那条"贴进一张不断长高的画布，
 *   并用置信度拒帧（<crate>snow-stitch-images</crate> 的 config：tile_size / max_features /
 *   max_motion_ratio / min_confidence / temporal_learning_rate；决策日志有
 *   accepted-motion / frame_rejected / tracker 分支，输出可走 chunk 分块画布）。
 *
 * 这里用同样的骨架，但把"ORB 特征点 + 估计器"换成**行剖面相关 + 唯一性校验**：
 *   - 把每行在水平方向分 16 箱取平均亮度，得到 rows×16 的"行剖面"；
 *   - 在候选位移 dy 上做归一化 SSD，取最小者为候选；
 *   - 用三个条件判可信：比"没动"基线好够多（min_confidence）、逐行匹配率够高、
 *     且最优 dy 明显优于第二好的 dy（躲开周期性图案的假匹配）。
 * 这样只需要 zlib，没有原生依赖，且能在 Node 里用合成图做确定性回归。
 *
 * 为什么不用浏览器 fullPage：transform 滚动 / 内嵌滚动容器 / canvas 渲染的页面，
 * 浏览器自己说不出"整页"有多大；但像素是诚实的——只要内容在动，就能拼。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { decodePng, encodePng, cropRows, blankImage } from './png.js';

export const DEFAULT_STITCH = {
  cols: 16,              // 每行横向分几箱取平均亮度
  marginRatio: 0.08,     // 左右各留 8% 不参与匹配（躲开固定侧栏 / 滚动条 / 圆角）
  maskTop: 0,            // 顶部固定像素（贴纸栏之类），不参与匹配也不贴进结果
  maskBottom: 0,         // 底部固定像素（手机底栏），不参与匹配；每步少拼这么多行，由下一帧补上
  autoMask: true,        // 顶部/底部固定浮层高度自动量出来（手机页几乎都有底栏；用户显式给的值优先取大者）
  minBarRows: 8,         // 量到的浮层至少这么高才算数
  maxBarRatio: 0.3,      // 顶/底浮层最多占视口的这个比例，再多就认为不是浮层
  autoMaskSteps: 1,      // 浮层测量的步数上限：现在只量一次（见 createStitcher 里的说明）
  minDy: 24,             // 小于它就当"没动"
  maxMotionRatio: 0.9,   // 一帧最多移动视口的百分之多少（SnowShot: [0, 0.9]）
  minOverlapRatio: 0.15, // 两帧之间至少要留多少重叠行
  minConfidence: 0.25,   // 比"没动"基线多认出的行占比下限，才算一次真位移（SnowShot 的 min_confidence 同义）
  minMatchedRatio: 0.55, // 重叠区里逐行匹配率的下限
  sepFloor: 0.5,         // 最优 dy 与次优 dy 的代价差下限（绝对值，挡"纯色/周期图案"的假匹配）
  sepRatio: 0.25,        // 最优 dy 与次优 dy 的代价差下限（相对值）
  rowMatchTol: 12,       // 单行平均亮度平方误差 <= 这个值算"这一行对上了"
  trimRatio: 0.6,        // 截尾平均：只统计代价最小的这一比例的行（抗固定头/底条与局部重绘污染）
  sigCols: 48,           // 复核用"抽样行原始像素"：每行抽 48 列（行剖面只有 16 个数，遇到大片纯色会退化）
  verifyTol: 16,         // 抽样行单行平均亮度平方误差 <= 这个值算"这行对上了"
  maxVerify: 64,         // 行剖面平局时最多复核多少个同价候选（纯色页的平局可能有一二十个）
  minVerifiedRatio: 0.6, // 抽样行匹配率下限（真位移要能解释掉多数抽样行）
  // ↓ 真机 App 页专用放宽档（"压倒性代价增益"通道）。
  //   实测京东 App 首页：真位移 dy=1412 的代价 27.96 vs "不动"基线 1927.9（增益 98.5%），
  //   但 matchedRatio 只有 0.42、verified 只有 0.40 —— 因为无限流 + 图片懒加载 + 倒计时/动画
  //   让大量行像素本来就对不上。这类页面的判据应该是"增益压倒性 + 不歧义"，
  //   而不是"逐行相同比例高"。走这条通道必须同时满足 gain>=minConfidenceStrong、
  //   verified>=minVerifiedRatioStrong，并且照样过 ambiguity 检查（纯色/周期图案仍会被拒）。
  minConfidenceStrong: 0.9,
  minVerifiedRatioStrong: 0.3,
  verifySep: 8,          // 位移差小于这么多像素的候选视为"视觉等价"，不算竞争对手
  verifyTieTol: 0.05,    // 复核之后第一名与最强对手的差距下限（低于它仍算歧义，宁可拒帧）
  stepRatio: 0.75,       // 每步手势滚动 = 视口高度的比例
  settleMs: 320,
  maxSteps: 60,
  maxHeight: 22000,      // 画布上限（SnowShot 的 chunk_size 语义），到头就分块写出
};

const EPS = 1e-6;

/** 行剖面：rows × cols 的平均亮度（只取 mask 之外、margin 之内的列） */
export function buildProfile(img, cfg = {}) {
  const { width, height, data } = img;
  const cols = cfg.cols ?? DEFAULT_STITCH.cols;
  const marginE = Math.round(width * (cfg.marginRatio ?? DEFAULT_STITCH.marginRatio));
  const x0 = marginE;
  const x1 = Math.max(x0 + cols, width - marginE);
  const binW = (x1 - x0) / cols;
  const rows = height;
  const prof = new Float32Array(rows * cols);
  for (let y = 0; y < rows; y++) {
    const base = y * width * 4;
    for (let j = 0; j < cols; j++) {
      const xs = x0 + Math.floor(j * binW);
      const xe = Math.max(xs + 1, x0 + Math.floor((j + 1) * binW));
      let sum = 0;
      let n = 0;
      for (let x = xs; x < xe && x < width; x++) {
        const i = base + x * 4;
        // 整数权重的亮度近似（比 0.299/0.587/0.114 浮点快，排序不变）
        sum += (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
        n++;
      }
      prof[y * cols + j] = n ? sum / n : 0;
    }
  }

  // 抽样行原始像素：每行抽 sigCols 列亮度（同一套列位置，与帧无关）。
  // 行剖面是 16 箱平均，遇到大片纯色（横幅、卡片留白）时很多候选位移代价都 ≈ 0，
  // 这时只有原始像素能分辨"边界错了几像素"。48 列 x 全部行 ≈ 3 万个采样，比行剖面还便宜。
  const sigCols = Math.max(8, cfg.sigCols ?? DEFAULT_STITCH.sigCols);
  const sig = new Float32Array(rows * sigCols);
  const mE = Math.round(width * (cfg.marginRatio ?? DEFAULT_STITCH.marginRatio));
  const sx0 = mE;
  const sx1 = Math.max(sx0 + sigCols, width - mE);
  for (let y = 0; y < rows; y++) {
    const base = y * width * 4;
    for (let j = 0; j < sigCols; j++) {
      const x = Math.min(width - 1, sx0 + Math.floor((j * (sx1 - sx0)) / sigCols));
      const i = base + x * 4;
      sig[y * sigCols + j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
  }
  return { rows, cols, data: prof, sig, sigCols };
}

/**
 * 估计 cur 相对 prev 向下移动了多少像素。
 * 位移判据 = 截尾平均行代价（只算最像的那 trimRatio 比例的行），抗固定头/底条、
 * 局部重绘与动画污染；再要求"比没动省下明显更多误差"（gain）且最优解相对次优解不歧义。
 * 返回 { dy, accepted, reason, cost, noMotionCost, gain, matchedRatio, inliers,
 *        noMotionInliers, noMotionRatio, secondDy, secondCost, separation, overlapRows }
 */
export function estimateOffset(prev, cur, cfg = {}, older = null) {
  const c = { ...DEFAULT_STITCH, ...cfg };
  const h = Math.min(prev.rows, cur.rows);
  const cols = prev.cols;

  // 固定浮层（手机底栏 / 顶部标题栏）：同一视口行上的像素几乎不动，而内容在动
  // → 直接从边缘往里量它有多高（对应 SnowShot 的 region.rs：把这类区域从运动估计和
  // 拼接里摘出去）。手机页几乎都有底栏，用户没显式给 mask 时靠它兜住。
  // 这一步必须发生在"定匹配窗口"之前：浮层行既不该参与代价，也不该算进匹配率
  // ——实测 56px 顶栏 + 48px 底栏会把 matchedRatio 从 0.78 压到 0.53，真位移被误拒。
  // 只在"这一步真的发生了位移"时才有意义，所以采用方（push）只在 accepted 时用它。
  const rowDelta = (a, b, y) => {
    const pa = y * cols;
    let acc = 0;
    for (let j = 0; j < cols; j++) {
      const d = a.data[pa + j] - b.data[pa + j];
      acc += d * d;
    }
    return acc / cols;
  };
  // 三帧确认（older 也在手里时）：固定浮层在任何两帧之间都停在同一个屏幕行上，而"一片纯色的
  // 内容"只可能连续两帧巧合重合 —— 滚动几十上百像素后就错开了。实测夹具页底栏只有 48px，
  // 却因为上面压着一条纯色带被量成 64px，白白吃掉 16 行真内容。
  const tripleConfirm = !!(older && older.rows === prev.rows && prev.rows === cur.rows && older.cols === cols);
  const sameRow = (y) => {
    if (rowDelta(prev, cur, y) > c.rowMatchTol) return false;
    if (tripleConfirm && rowDelta(older, prev, y) > c.rowMatchTol) return false;
    return true;
  };
  const maxBarRows = Math.max(c.minBarRows, Math.floor(h * c.maxBarRatio));
  // 注意：这里**故意不做"容忍坏行"**。试过让偶尔对不上的行不计入（想解决真机底栏带角标
  // 导致只量到 21px 的问题），结果合成回归 35 项里挂 8 项 —— 底栏旁边紧邻的纯色内容行
  // 会被算进浮层，48px 的栏量成 50~64px，逐像素比对立刻不等。真机的固定栏高度改由
  // Android 侧用控件树 bounds 量（见 src/android/overlay.js），那边是确定性的。
  const measureBar = (edge) => {
    let n = 0;
    while (n < maxBarRows) {
      const y = edge === 'bottom' ? h - 1 - n : n;
      if (y < 0 || y >= h || !sameRow(y)) break;
      n++;
    }
    // 太薄不算浮层；一路顶到底（整屏纯色 / 两帧完全一样）也不算
    if (n < c.minBarRows || n >= maxBarRows || n >= h - 1) return 0;
    return n;
  };
  const overlayBottom = c.autoMask ? measureBar('bottom') : 0;
  const overlayTop = c.autoMask ? measureBar('top') : 0;

  const yStart = Math.max(0, c.maskTop, overlayTop);
  const yEnd = Math.max(yStart + 1, h - Math.max(c.maskBottom, overlayBottom));
  const span = yEnd - yStart;
  const overlapFloor = Math.max(24, Math.round(span * c.minOverlapRatio));
  const dyMin = Math.max(1, c.minDy | 0);
  const dyMax = Math.min(Math.floor(h * c.maxMotionRatio), span - overlapFloor);

  // 逐行代价 + "截尾平均"（只统计代价最小的那 trimRatio 比例的行）。判据不是整图平均残差：
  // 固定头/底条、局部重绘、动画都会污染一部分行，平均残差会被这几十行拖垮
  // ——实测一个 48px 固定底栏就能让真值 443 的代价(均值 1449) 超过错误值 243，
  // 于是拼错或拒帧。截尾平均把被污染的行剔掉，只留"能对上"的行当证据
  // （SnowShot 用 ORB 内点/置信度也是这个思路：看有多少证据支持这个位移）。
  const scratch = new Float64Array(span);
  const scoreAt = (dy) => {
    // dy 是"页面内容向上移动的像素数"：cur 的第 y 行 = prev 的第 y+dy 行
    const overlap = span - dy;
    if (overlap <= 0) return { cost: Infinity, inliers: 0, overlap: 0, matchedRatio: 0 };
    let inliers = 0;
    for (let y = yStart; y < yEnd - dy; y++) {
      const pa = (y + dy) * cols;
      const pb = y * cols;
      let rowAcc = 0;
      for (let j = 0; j < cols; j++) {
        const d = prev.data[pa + j] - cur.data[pb + j];
        rowAcc += d * d;
      }
      const rowCost = rowAcc / cols;
      scratch[y - yStart] = rowCost;
      if (rowCost <= c.rowMatchTol) inliers++;
    }
    const keep = Math.max(1, Math.round(overlap * c.trimRatio));
    const sorted = scratch.subarray(0, overlap);
    sorted.sort(); // TypedArray.sort 默认数值升序：前 keep 行就是"最像"的那些行
    let sum = 0;
    for (let i = 0; i < keep; i++) sum += sorted[i];
    return { cost: sum / keep, inliers, overlap, matchedRatio: inliers / overlap };
  };

  const noMotion = scoreAt(0);
  const cands = [];
  for (let dy = dyMin; dy <= dyMax; dy++) cands.push({ dy, ...scoreAt(dy) });
  const costOf = (r) => (Number.isFinite(r.cost) ? r.cost : Infinity);
  cands.sort((a, b) => costOf(a) - costOf(b));
  let best = cands[0] ?? { dy: 0, cost: Infinity, inliers: 0, overlap: 0, matchedRatio: 0 };

  // 抽样行复核：行剖面只有 16 个箱，遇到大片纯色（横幅、卡片留白）时好几个候选代价都是 0
  // ——实测夹具页 cost=0 vs cost=0.03，光看剖面必然判"歧义"。抽样行是原始像素，
  // 边界错几像素就会露馅，正好用来在平局里挑出真正对上的那个。
  const sigCols = prev.sigCols ?? cur.sigCols ?? 0;
  const canVerify = sigCols > 0 && !!prev.sig && !!cur.sig;
  const verifyAt = (dy) => {
    if (!canVerify) return 1; // 没签名（只给了剖面）就不拦，保持向后兼容
    let hits = 0;
    let n = 0;
    for (let y = yStart; y < yEnd - dy; y++) {
      const sa = (y + dy) * sigCols;
      const sb = y * sigCols;
      let acc = 0;
      for (let j = 0; j < sigCols; j++) {
        const d = prev.sig[sa + j] - cur.sig[sb + j];
        acc += d * d;
      }
      n++;
      if (acc / sigCols <= c.verifyTol) hits++;
    }
    return n ? hits / n : 0;
  };
  const tieWindow = Math.max(c.sepFloor, best.cost * c.sepRatio);
  const verifiedOf = new Map();
  const vOf = (dy) => {
    if (!verifiedOf.has(dy)) verifiedOf.set(dy, verifyAt(dy));
    return verifiedOf.get(dy);
  };
  let bestVerified = vOf(best.dy);
  // 平局集必须整体复核：实测纯色横幅页的代价 0 平局里排着 19 个 dy，真值就藏在中间，
  // 只验"代价最小的前几个"永远挑不到它。
  const tied = cands
    .filter((r) => Number.isFinite(r.cost) && r.cost <= best.cost + tieWindow)
    .slice(0, c.maxVerify);
  for (const r of tied) {
    const v = vOf(r.dy);
    if (v > bestVerified + EPS || (Math.abs(v - bestVerified) <= EPS && costOf(r) < costOf(best))) {
      bestVerified = v;
      best = r;
    }
  }
  best = { ...best, verified: bestVerified };

  // 最强对手：位移差超过 verifySep 像素的候选里代价最小的那个
  // （差 1~2 像素的候选视觉上等价，不该算竞争对手，否则正常页面会被判"歧义"而拒绝）
  let second = null;
  for (const r of cands) {
    if (Math.abs(r.dy - best.dy) <= c.verifySep) continue;
    if (!second || costOf(r) < costOf(second)) second = r;
  }
  const secondVerified = second && canVerify ? vOf(second.dy) : null;

  // gain = 比"没动"基线省下的相对误差：真位移必须解释掉明显更多的行
  const gain = 1 - best.cost / Math.max(noMotion.cost, EPS);
  const matchedRatio = best.matchedRatio;
  // 唯一性：真位移的代价该"明显"低于次优候选。纯色 / 周期图案会让两者都接近 0，
  // 这时 sepFloor 兜住，宁可拒帧也不拼错（SnowShot 的 start_rejected / frame_rejected 同义）；
  // 代价平局时改看抽样行复核的差距——只有复核能拉开，才算真的唯一。
  const separation = second ? second.cost - best.cost : Infinity;
  const verifiedGap = secondVerified == null ? Infinity : bestVerified - secondVerified;
  const ambiguityOk = !second || !Number.isFinite(second.cost)
    || separation >= Math.max(c.sepFloor, best.cost * c.sepRatio)
    || verifiedGap >= c.verifyTieTol;

  const base = {
    dy: best.dy,
    cost: best.cost,
    noMotionCost: noMotion.cost,
    gain,
    matchedRatio,
    verified: bestVerified,
    secondVerified,
    verifiedGap,
    inliers: best.inliers,
    noMotionInliers: noMotion.inliers,
    noMotionRatio: noMotion.overlap ? noMotion.inliers / noMotion.overlap : 0,
    overlapRows: best.overlap,
    secondDy: second ? second.dy : -1,
    secondCost: second ? second.cost : Infinity,
    separation,
    overlayTop,
    overlayBottom,
  };
  if (dyMax < dyMin) return { ...base, dy: 0, accepted: false, reason: 'viewport-too-small' };
  if (!Number.isFinite(best.cost)) return { ...base, dy: 0, accepted: false, reason: 'no-overlap' };
  // 最优 dy 连"没动"都省不下误差（含两帧逐字节相同的情况）→ 就是没动
  if (best.dy < dyMin || best.cost >= noMotion.cost) return { ...base, dy: 0, accepted: false, reason: 'no-motion' };
  if (gain < c.minConfidence) return { ...base, dy: best.dy, accepted: false, reason: 'low-confidence' };
  // 比例门限没过时，还有一条"压倒性增益"通道：真机 App 页常见（见 DEFAULT_STITCH 里的说明）。
  const ratioGateFailed = matchedRatio < c.minMatchedRatio || bestVerified < c.minVerifiedRatio;
  if (ratioGateFailed) {
    const strong = gain >= (c.minConfidenceStrong ?? 0.9) && bestVerified >= (c.minVerifiedRatioStrong ?? 0.3);
    if (!strong) {
      return matchedRatio < c.minMatchedRatio
        ? { ...base, dy: best.dy, accepted: false, reason: 'too-few-matched-rows' }
        : { ...base, dy: best.dy, accepted: false, reason: 'low-verified-rows' };
    }
    if (!ambiguityOk) return { ...base, dy: best.dy, accepted: false, reason: 'ambiguous-motion' };
    return { ...base, accepted: true, reason: 'accepted-strong-gain' };
  }
  if (!ambiguityOk) return { ...base, dy: best.dy, accepted: false, reason: 'ambiguous-motion' };
  return { ...base, accepted: true, reason: 'accepted' };
}

/**
 * 增量拼接器：一帧一帧喂进去，内部维护不断长高的画布 + 决策日志。
 * 用法：
 *   const st = createStitcher(cfg);
 *   for (const frame of frames) st.push(frame);   // {accepted, dy, height, reason}
 *   st.result();                                  // {width, height, data, offsets, log, ...}
 */
export function createStitcher(cfg = {}) {
  const c = { ...DEFAULT_STITCH, ...cfg };
  const cap = Math.max(c.maxHeight, 1024);
  let canvas = null;
  let height = 0;
  let width = 0;
  let refProfile = null;   // 参照帧的行剖面（只在"接受"时前移，被拒的帧不污染基准）
  let olderProfile = null; // 上上个被接受的帧，用来做固定浮层的"三帧确认"
  let refPageTop = 0;      // 参照帧在页面坐标里的顶边
  let frames = 0;
  let accepted = 0;
  let rejected = 0;
  let consecutiveRejects = 0;
  const offsets = [];
  const log = [];
  let stopped = null;
  let firstFrame = null;    // 第一帧留在手里：等第二帧来了才能量出固定浮层高度并重铺画布
  let autoMasked = false;   // 浮层只量一次（量完把第一帧放掉）
  const userTop = Math.max(0, c.maskTop | 0);      // 用户显式给的遮罩是下限
  const userBottom = Math.max(0, c.maskBottom | 0);

  const grow = (need) => {
    if (width * need * 4 <= canvas.data.length) return true;
    const nextH = Math.min(cap, Math.max(need, Math.round(need * 1.4)));
    if (width * nextH * 4 <= canvas.data.length) return true;
    const bigger = blankImage(width, nextH);
    canvas.data.copy(bigger.data, 0, 0, width * height * 4);
    canvas = bigger;
    return true;
  };

  // 用当前的 maskTop/maskBottom 把第一帧铺回画布（量出浮层高度后要用新 mask 重铺一次）
  const layFirstFrame = () => {
    const top = Math.max(0, Math.min(c.maskTop, firstFrame.height));
    const keep = Math.max(top, firstFrame.height - c.maskBottom);
    cropRows(firstFrame, top, keep).data.copy(canvas.data, 0);
    height = keep - top;
    refProfile = buildProfile(firstFrame, c);
    refPageTop = 0;
  };

  const push = (frame) => {
    const img = Buffer.isBuffer(frame) ? decodePng(frame) : frame;
    frames++;
    if (!canvas) {
      width = img.width;
      canvas = blankImage(width, Math.min(cap, Math.max(img.height, 1024)));
      // 顶部固定条（maskTop）和底部固定条（maskBottom）都不贴进结果：
      // 它们只是浮在内容上的 UI，而顶部那几十行内容本来就永远看不到（后面的帧只往下走）。
      firstFrame = img;
      const top = Math.max(0, Math.min(c.maskTop, img.height));
      const keep = Math.max(top, img.height - c.maskBottom);
      if (keep - top <= 0) {
        stopped = 'first-frame-fully-masked';
        return { accepted: false, dy: 0, height, reason: stopped };
      }
      layFirstFrame();
      accepted++;
      log.push({ frame: frames, accepted: true, reason: 'first-frame', dy: 0, height });
      return { accepted: true, dy: 0, height, reason: 'first-frame' };
    }
    if (img.width !== width) {
      rejected++;
      consecutiveRejects++;
      log.push({ frame: frames, accepted: false, reason: 'width-changed', width: img.width, expected: width });
      return { accepted: false, dy: 0, height, reason: 'width-changed' };
    }

    const prof = buildProfile(img, c);
    // 永远和"上一次被接受的帧"比：中间被拒的帧不改变基准，避免误差累积
    let est = estimateOffset(refProfile, prof, c, olderProfile);
    if (!est.accepted) {
      rejected++;
      consecutiveRejects++;
      log.push({
        frame: frames, accepted: false, reason: est.reason, dy: est.dy,
        cost: Math.round(est.cost * 100) / 100,
        noMotionCost: Math.round(est.noMotionCost * 100) / 100,
        gain: Math.round(est.gain * 1000) / 1000,
        matchedRatio: Math.round(est.matchedRatio * 1000) / 1000,
        secondDy: est.secondDy,
      });
      return { accepted: false, dy: 0, height, reason: est.reason, estimate: est };
    }

    // 量固定浮层（手机底栏 / 顶部标题栏）：底栏像素在每一帧里都停在同一个屏幕位置，如果把它
    // 当内容贴进长图，画布上会反复出现同一条栏，被它挡住的真实内容也会永久丢失。
    // 只在"第一次拿到真的动了"的时候量一次 —— 此刻画布上只有第一帧，可以直接重铺，画布坐标
    // 不变量没被破坏。往后不能再改：遮罩一变，已拼进去的行与 maskTop 的坐标映射就对不上了。
    // 注意这一步只有两帧证据：紧挨底栏的一片纯色内容带也满足"同一屏幕行像素相同"，
    // 所以量出来的底栏可能偏高（实测夹具页真值 48px 量成 64px）—— 代价只是长图底部少十几行。
    if (!autoMasked) {
      autoMasked = true;
      const detTop = Math.max(userTop, est.overlayTop ?? 0);
      const detBottom = Math.max(userBottom, est.overlayBottom ?? 0);
      if (firstFrame && (detTop !== c.maskTop || detBottom !== c.maskBottom)) {
        const prevMask = { top: c.maskTop, bottom: c.maskBottom };
        c.maskTop = detTop;
        c.maskBottom = detBottom;
        const top = Math.max(0, Math.min(c.maskTop, firstFrame.height));
        if (firstFrame.height - c.maskBottom - top > 0) {
          layFirstFrame();
          const est2 = estimateOffset(refProfile, prof, c, olderProfile);
          if (est2.accepted) est = est2;
          log.push({
            frame: frames, accepted: true, reason: 'auto-mask',
            from: prevMask, to: { top: c.maskTop, bottom: c.maskBottom }, dy: est.dy,
          });
        } else {
          c.maskTop = prevMask.top;
          c.maskBottom = prevMask.bottom;
        }
      }
      firstFrame = null; // 已经用完了，别一直占着这一帧的内存
    }

    // 只贴"新露出来的那条"：贴完的页面位置连续，所以每步正好补齐 dy 行。
    // 起点要退到"上一帧被底部固定条挡住的位置"再往前 dy 行，这样被固定条遮住的那几十行
    // 会在下一帧里补回来（这就是 maskBottom 不该直接从行数里扣掉的原因）。
    const dy = est.dy;
    // 当前帧在页面坐标里的顶边；画布坐标 = 页面坐标 - maskTop
    const curPageTop = refPageTop + dy;
    const srcRow = c.maskTop + height - curPageTop;
    if (srcRow < 0) {
      rejected++;
      consecutiveRejects++;
      log.push({ frame: frames, accepted: false, reason: 'step-exceeds-visible-area', dy, srcRow });
      return { accepted: false, dy: 0, height, reason: 'step-exceeds-visible-area' };
    }
    const count = img.height - c.maskBottom - srcRow; // 本帧能补上多少"还没拍到"的内容
    if (count <= 0) {
      rejected++;
      consecutiveRejects++;
      log.push({ frame: frames, accepted: false, reason: 'no-new-content', dy, srcRow, count });
      return { accepted: false, dy: 0, height, reason: 'no-new-content' };
    }
    if (height + count > cap) {
      stopped = 'height-cap';
      rejected++;
      log.push({ frame: frames, accepted: false, reason: 'height-cap', dy, height });
      return { accepted: false, dy: 0, height, reason: 'height-cap' };
    }
    grow(height + count);
    const src = srcRow * width * 4;
    img.data.copy(canvas.data, height * width * 4, src, src + count * width * 4);
    height += count;
    olderProfile = refProfile; // 参照帧前移，上上个留给浮层"三帧确认"
    refProfile = prof;
    refPageTop = curPageTop;
    accepted++;
    consecutiveRejects = 0;
    offsets.push(dy);
    log.push({
      frame: frames, accepted: true, reason: 'accepted-motion', dy, appended: count,
      gain: Math.round(est.gain * 1000) / 1000,
      cost: Math.round(est.cost * 100) / 100, matchedRatio: Math.round(est.matchedRatio * 1000) / 1000, height,
    });
    return { accepted: true, dy, height, reason: 'accepted-motion', estimate: est };
  };

  const result = () => ({
    width,
    height,
    channels: 4,
    data: canvas ? canvas.data.subarray(0, width * height * 4) : Buffer.alloc(0),
    mode: 'stitched',
    frames,
    accepted,
    rejected,
    offsets,
    log,
    stopped,
  });

  return {
    push,
    result,
    get height() { return height; },
    get consecutiveRejects() { return consecutiveRejects; },
    // 实际生效的浮层遮罩（autoMask 量出来的会覆盖用户给的 0），便于日志与排错
    get masks() { return { top: c.maskTop, bottom: c.maskBottom, auto: !!c.autoMask }; },
  };
}

/** 一批帧 → 拼接结果（等价于 createStitcher 逐个 push） */
export function stitchFrames(frames, cfg = {}) {
  const st = createStitcher(cfg);
  const steps = [];
  for (const f of frames) steps.push(st.push(f));
  return { ...st.result(), steps };
}

/**
 * 写出拼接结果：不超过 maxHeight 就一张，超过就分块（SnowShot 的 tile/chunk 语义）。
 */
export async function writeStitched(result, outPath, opts = {}) {
  const maxHeight = opts.maxHeight ?? DEFAULT_STITCH.maxHeight;
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const base = outPath.replace(/\.png$/i, '');
  if (result.height <= 0) throw new Error('writeStitched: empty result');

  if (result.height <= maxHeight) {
    const buf = encodePng(result);
    await fsp.writeFile(outPath, buf);
    return { path: outPath, bytes: buf.length, width: result.width, height: result.height, mode: 'stitched', chunks: [] };
  }
  const chunkH = Math.max(256, opts.chunkHeight ?? maxHeight);
  const chunks = [];
  for (let y = 0, i = 1; y < result.height; y += chunkH, i++) {
    const part = cropRows(result, y, Math.min(result.height, y + chunkH));
    part.channels = 4;
    const file = `${base}-p${String(i).padStart(2, '0')}.png`;
    const buf = encodePng(part);
    await fsp.writeFile(file, buf);
    chunks.push({ path: file, bytes: buf.length, y, width: part.width, height: part.height });
  }
  return {
    path: chunks[0].path, bytes: chunks[0].bytes, width: result.width, height: result.height,
    mode: 'stitched-chunks', chunks,
  };
}
