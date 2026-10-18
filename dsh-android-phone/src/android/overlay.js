/**
 * 从 Android 控件树（uiautomator dump）量出「固定顶栏 / 底栏」的高度。
 *
 * 为什么真机要单独量、而不是沿用像素法（`src/core/stitch.js` 里的 autoMask）：
 *   像素法只在画面边缘往上数"连续两帧逐行相同"的行。真机 App 的底栏常有角标
 *   （5+ / 5）、动效、半透明毛玻璃，个别行两帧对不上就把它打断了 —— 实测京东 App
 *   首页：底栏真高约 150~190px，像素法一次量到 21px（长截图里底栏被拼了十几次），
 *   另一次量到 150px，不稳定。控件树的 bounds 是确定性的。
 *
 * 底栏怎么认（试过两版，第一版被"浮层活动""商品卡片"这类大节点带偏到 435/510px）：
 *   找"标签行"—— 同一 y 上有一排 ≥3 个窄节点（宽 ≤0.5W、高 ≤0.08H、贴着屏幕下部），
 *   总覆盖宽度 ≥0.5W。京东底栏就是 首页/逛/消息/购物车/我的 五个 216px 宽的 View
 *   并排在同一 y=2250 上；而"浮层活动"按钮只有 1 个、"不感兴趣"只有 1 个、
 *   商品卡片一行只有 2 个且高 285px，都会被排除。
 *   量到标签行顶端后再往上留 40px 图标余量，避免只剩标签、图标还留在长图里。
 * 顶栏：顶边贴着屏幕顶、有文字/可点击、高度合理的节点里取最靠下的 bottom
 *   （像素法通常还能量得更大，最终取 max）。
 * 最终遮罩 = max(用户显式给的值, 控件树量到的值)，像素法 autoMask 之后再取大者；
 * 多遮一点是安全的（被遮住的内容会由下一帧补上），少遮才会在长图里反复出现固定栏。
 */

const MIN_ROWS = 8;
const MIN_WIDTH_RATIO = 0.06;
const MAX_TAB_WIDTH_RATIO = 0.5;
const MAX_TAB_HEIGHT_RATIO = 0.08;
const TAB_ROW_BOTTOM_SCAN = 500; // 标签行的 y2 落在这个高度以内才算"贴着底部"
const ICON_ALLOWANCE = 40;       // 标签行之上留给图标的像素
const MAX_MASK_RATIO = 0.33;

function texty(n) {
  return (n?.text && n.text.trim()) || (n?.desc && n.desc.trim()) || n?.clickable;
}

/**
 * @param {Array} nodes uiDump() 返回的节点数组（含 bounds）
 * @param {{width:number,height:number}} metrics
 * @returns {{top:number,bottom:number,from:string,tabRow?:object}}
 */
export function overlayMaskFromUi(nodes, metrics) {
  const W = Number(metrics?.width) || 0;
  const H = Number(metrics?.height) || 0;
  if (!Array.isArray(nodes) || !W || !H) return { top: 0, bottom: 0, from: 'none' };

  // ---- 顶栏 ----
  let top = 0;
  for (const n of nodes) {
    if (!texty(n)) continue;
    const b = n.bounds;
    if (!b || !b.height || !b.width) continue;
    if (b.height < MIN_ROWS || b.width < W * MIN_WIDTH_RATIO) continue;
    if (b.height <= H * 0.25 && b.y1 <= H * 0.05) top = Math.max(top, b.y2);
  }

  // ---- 底栏：找标签行 ----
  const rows = new Map();
  for (const n of nodes) {
    if (!texty(n)) continue;
    const b = n.bounds;
    if (!b || !b.height || !b.width) continue;
    if (b.height < MIN_ROWS || b.height > H * MAX_TAB_HEIGHT_RATIO) continue;
    if (b.width < W * MIN_WIDTH_RATIO || b.width > W * MAX_TAB_WIDTH_RATIO) continue;
    if (b.y2 < H - TAB_ROW_BOTTOM_SCAN || b.y2 > H + 8) continue;
    const key = Math.round(b.y1 / 6) * 6; // 同一行的节点 y1 可能差几个像素
    if (!rows.has(key)) rows.set(key, { y1: key, count: 0, coverage: 0, labels: [] });
    const r = rows.get(key);
    r.count += 1;
    r.coverage = Math.min(W, r.coverage + b.width);
    r.labels.push((n.text || n.desc || '').trim().slice(0, 8));
  }
  let tabRow = null;
  for (const r of rows.values()) {
    if (r.count < 3 || r.coverage < W * 0.5) continue;
    if (!tabRow || r.y1 > tabRow.y1) tabRow = r;
  }
  let bottom = tabRow ? H - Math.max(0, tabRow.y1 - ICON_ALLOWANCE) : 0;

  // 兜底：量出来的栏不能太离谱
  if (bottom > H * MAX_MASK_RATIO) bottom = 0;
  if (top > H * MAX_MASK_RATIO) top = 0;
  return {
    top: Math.round(top),
    bottom: Math.round(bottom),
    from: 'ui',
    tabRow: tabRow ? { y1: tabRow.y1, count: tabRow.count, coverage: tabRow.coverage, labels: tabRow.labels } : null,
  };
}
