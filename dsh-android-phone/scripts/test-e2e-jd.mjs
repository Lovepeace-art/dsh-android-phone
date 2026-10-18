/**
 * P1 真机端到端：用**插件自己的工具层**跑用户那条真实工作流。
 *
 *   控制权 → 起会话（reverse 视频 + 1024 控制）→ 打开京东 → 关开屏广告落到首页
 *   → 点搜索框 → 中文输入「牛奶」→ 提交 → 结果页 → 切「店铺」tab → 进第一家店 → 长截图
 *
 * 断言口径：每个写操作都要 `via === 'control'`（走 scrcpy 控制通道，不是 adb shell input），
 * 并记录宿主侧耗时、会话状态（tunnel/control/帧统计）。失败不中断，全跑完再汇总。
 *
 * 跑法：node scripts/test-e2e-jd.mjs
 * 输出：PROBE-P1-e2e-jd.json + 截图落在 ~/.dsh/android-phone/shots/
 */
import { Readable } from 'node:stream';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const out = { ranAt: new Date().toISOString(), steps: [], shots: [], timeline: [] };
const step = (name, ok, detail) => {
  out.steps.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
const info = (name, detail) => {
  out.steps.push({ name, ok: true, info: true, detail });
  console.log(`INFO  ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 假 ctx（与 test-plugin-tools.mjs 同款） */

function makeCtx() {
  const registered = { tools: [], routes: [] };
  const webServer = { register(opts) { registered.routes.push(opts); return () => {}; } };
  const tools = { register(def) { registered.tools.push(def); return () => {}; } };
  const services = { tools, webServer, attachments: undefined };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (n) => { if (n in services) return services[n]; throw new Error(`没有服务 ${n}`); },
    inject: (deps, fn) => { const scoped = { get: (n) => ctx.get(n), effect: ctx.effect }; fn(scoped); },
    effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {}; },
  };
  return { ctx, registered };
}

const { ctx, registered } = makeCtx();
const plugin = (await import('../index.js')).default;
await plugin.apply(ctx, { adbPath: '', defaultSerial: '', shotsDir: '' });

const tool = (name) => {
  const t = registered.tools.find((x) => x.name === name);
  if (!t) throw new Error(`没有工具 ${name}`);
  return t;
};
async function call(name, args) {
  try {
    const v = await tool(name).execute(args || {});
    return v && typeof v === 'object' ? v : { value: v };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 拉 UI 树里的文字（uiautomator） */
async function uiTexts(max = 240) {
  const r = await call('phone_inspect', { max });
  const nodes = r.nodes || [];
  return { nodes, texts: nodes.map((n) => n.text || n.desc || '').filter(Boolean) };
}
async function shot(name) {
  const s = await call('phone_screenshot', { name });
  if (s.path) out.shots.push(s.path);
  return s;
}
async function tapNode(node, note) {
  const x = node?.x, y = node?.y;
  if (typeof x !== 'number' || typeof y !== 'number') return { ok: false, error: `节点没有中心坐标: ${JSON.stringify(node)}` };
  const m = await call('phone_status', {});
  const w = m.screen?.width || 1080, h = m.screen?.height || 2400;
  const r = await call('phone_action', { action: 'tap', nx: x / w, ny: y / h });
  info(`点击 ${note || node.text}`, `${x},${y} → ${JSON.stringify(r.step || r)}`);
  return r;
}

const sessionOf = (v) => (v?.session || {});
const summarize = (v) => {
  const s = sessionOf(v);
  return {
    running: s.running, control: s.control, tunnel: s.tunnel,
    size: s.width ? `${s.width}x${s.height}` : null, device: s.deviceName, version: s.version,
    maxSize: s.maxSize, restarts: s.restarts,
    packets: s.stats?.packets ?? null, lastFrameAgoMs: s.stats?.lastFrameAgoMs ?? null,
    owner: s.owner ?? v?.owner,
  };
};

/* ------------------------------------------------------------------ 1. 控制权 + 单会话 */

console.log('\n=== 1. 控制权 + 单会话（reverse 视频 + control）===');
const to = await call('phone_takeover', { owner: 'ai', reason: 'e2e 真机测试' });
step('phone_takeover {owner:ai}', to.ok === true && to.owner === 'ai', JSON.stringify(to).slice(0, 140));

const st = await call('phone_stream', { op: 'start' });
info('phone_stream start', JSON.stringify(st).slice(0, 200));
let sess = {};
for (let i = 0; i < 40; i++) {
  sess = summarize(await call('phone_status', {}));
  if (sess.running && sess.control && (sess.packets || 0) > 3) break;
  await sleep(500);
}
out.session = sess;
step('会话起来了', sess.running === true, JSON.stringify(sess));
step('视频走 reverse 隧道（旧 forward 会 2~4s 静默死）', sess.tunnel === 'reverse', `tunnel=${sess.tunnel}`);
step('控制通道已连上', sess.control === true, `control=${sess.control}`);
step('视频流有帧在流', (sess.packets || 0) > 3, `packets=${sess.packets} lastFrameAgoMs=${sess.lastFrameAgoMs}`);
step('  会话尺寸不再是 460x1024 那种低清', /^(\d+)x(\d+)$/.test(sess.size || '') && Number((sess.size || '0x0').split('x')[0]) >= 720,
  `size=${sess.size} maxSize=${sess.maxSize}`);

/* ------------------------------------------------------------------ 2. 打开京东并落到首页 */

console.log('\n=== 2. 打开京东 → 关开屏广告 → 首页 ===');
await call('phone_action', { action: 'home' });
await sleep(800);

const t0 = Date.now();
const open = await call('phone_open', {});
step('phone_open 京东', open.ok === true, JSON.stringify(open).slice(0, 200));
step('  打开走控制通道 START_APP（不是 monkey + 死等 8s）', open.via === 'control', `via=${open.via} ms=${open.ms}`);

/** JD 首页的判据：底部 tab 同时有「首页」和「我的」（开屏广告页两个都没有） */
const isJdHome = (texts) => texts.some((t) => t.includes('首页')) && texts.some((t) => t.includes('我的'));
let home = { ok: false, backs: 0 };
for (let i = 0; i <= 5; i++) {
  await sleep(i === 0 ? 2500 : 1200);
  const { texts } = await uiTexts();
  if (isJdHome(texts)) { home = { ok: true, backs: i, texts: texts.slice(0, 14) }; break; }
  if (i === 5) { home = { ok: false, backs: i, texts: texts.slice(0, 20) }; break; }
  const back = await call('phone_action', { action: 'key', key: 'BACK' });
  out.timeline.push({ at: new Date().toISOString(), event: 'back-to-dismiss-splash', i, via: back.step?.via, fg: back.foreground?.activity });
  info(`开屏广告/弹层：按 BACK（第 ${i + 1} 次）`, `via=${back.step?.via} 前台=${back.foreground?.activity}`);
}
step('落到京东首页（开屏广告已关）', home.ok === true, `按了 ${home.backs} 次 BACK · ${JSON.stringify((home.texts || []).slice(0, 10))}`);
const homeShot = await shot('e2e-1-jd-home');
step('  首页截图落盘', !!homeShot.path && homeShot.bytes > 10000, `${homeShot.bytes} 字节`);

/* ------------------------------------------------------------------ 3. 点搜索框 + 中文输入 */

console.log('\n=== 3. 搜索：点搜索框 → 中文「牛奶」→ 提交 ===');
const homeNodes = await uiTexts();
const searchCands = homeNodes.nodes.filter((n) => /搜索/.test(`${n.text || ''} ${n.desc || ''}`));
info('首页候选搜索节点', JSON.stringify(searchCands.map((n) => ({ text: n.text, desc: n.desc, id: n.id, clickable: n.clickable, x: n.x, y: n.y }))));
const searchNode = searchCands.find((n) => n.clickable) || searchCands[0];
const tTab = Date.now();
const tapSearch = searchNode ? await tapNode(searchNode, `顶部搜索框(${searchNode.desc || searchNode.text})`) : { ok: false, step: {}, error: '首页没找到搜索节点' };
step('点顶部搜索框', tapSearch.ok === true && tapSearch.via === 'control',
  `via=${tapSearch.via} 宿主侧 ${Date.now() - tTab}ms ${JSON.stringify(tapSearch.step || tapSearch.error || {})}`);
await sleep(1800);

const searchPage = await uiTexts();
step('进入搜索页（有输入框/取消/搜索）', /搜索|取消|历史搜索|猜你/.test(searchPage.texts.join(' ')),
  JSON.stringify(searchPage.texts.slice(0, 12)));

const tType = Date.now();
const kb = await call('phone_keyboard', { text: '牛奶' });
step('中文输入「牛奶」', kb.ok === true && kb.via === 'control',
  `via=${kb.via} 宿主侧 ${Date.now() - tType}ms ${JSON.stringify(kb.sent || kb)}`);
await sleep(1500);

const typed = await uiTexts();
const hit = typed.texts.filter((t) => t.includes('牛奶'));
step('输入框/联想词里出现了「牛奶」', hit.length > 0, JSON.stringify(hit.slice(0, 3)));
await shot('e2e-2-typed');

const sub = await call('phone_action', { action: 'key', key: 'ENTER' });
step('提交搜索（ENTER 走控制通道）', sub.ok === true && sub.via === 'control', `via=${sub.via} ${JSON.stringify(sub.step || {})}`);
await sleep(4500);

const results = await uiTexts();
const hasMilk = results.texts.some((t) => t.includes('牛奶'));
step('结果页包含关键词「牛奶」', hasMilk, JSON.stringify(results.texts.slice(0, 16)));
const resShot = await shot('e2e-3-results');
step('  结果页截图落盘', !!resShot.path && resShot.bytes > 10000, `${resShot.bytes} 字节`);
out.results = { count: results.nodes.length, texts: results.texts.slice(0, 60) };

/* ------------------------------------------------------------------ 4. 切「店铺」→ 进店 → 长截图 */

console.log('\n=== 4. 店铺 tab → 进店 → 长截图 ===');
const hay = (n) => `${n.text || ''} ${n.desc || ''}`;
const tabCands = results.nodes.filter((n) => /^(全部|新品|秒送|店铺|口碑|品牌)/.test(hay(n)));
info('结果页 tab 候选', JSON.stringify(tabCands.map((n) => ({ text: n.text, desc: n.desc, x: n.x, y: n.y, clickable: n.clickable }))));
const shopTab = tabCands.find((n) => /^店铺/.test(hay(n))) || results.nodes.find((n) => /店铺[,，]/.test(hay(n)) && typeof n.y === 'number' && n.y < 1400);
if (shopTab) {
  await tapNode(shopTab, '结果页顶部「店铺」tab');
  await sleep(3500);
  const shops = await uiTexts();
  const storeNodes = shops.nodes.filter((n) => /旗舰店|专卖店|专营店|官方旗舰/.test(n.text || ''));
  out.shopList = { count: shops.nodes.length, stores: storeNodes.slice(0, 8).map((n) => ({ text: n.text, x: n.x, y: n.y })) };
  step('切到店铺列表（看到带「店」的店铺名）', storeNodes.length > 0, JSON.stringify(storeNodes.slice(0, 5).map((n) => n.text)));
  await shot('e2e-4-shop-list');

  const first = storeNodes[0];
  if (first) {
    await tapNode(first, `进店：${first.text}`);
    await sleep(4000);
    const inShop = await uiTexts();
    step('进入店铺首页', isJdHome(inShop.texts) === false && inShop.nodes.length > 10,
      JSON.stringify(inShop.texts.slice(0, 14)));
    await shot('e2e-5-shop-home');
    const tLong = Date.now();
    const long = await call('phone_longshot', { name: 'e2e-shop-home', maxSteps: 6 });
    step('店铺首页长截图', long.ok === true || !!long.path,
      `${JSON.stringify({ path: long.path, width: long.width, height: long.height, bytes: long.bytes, steps: long.steps, offsets: long.offsets }).slice(0, 300)} 用时 ${Date.now() - tLong}ms`);
    if (long.path) out.shots.push(long.path);
    out.longshot = { path: long.path, width: long.width, height: long.height, steps: long.steps, ms: Date.now() - tLong };
  }
} else {
  info('店铺 tab', '结果页没找到顶部「店铺」文字节点；先把这一屏的文字存进报告，下一轮再定落点');
  info('结果页文字候选', JSON.stringify(results.texts.filter((t) => t.length > 1).slice(0, 30)));
}

/* ------------------------------------------------------------------ 5. 收尾 */

console.log('\n=== 5. 收尾 ===');
const stop = await call('phone_stream', { op: 'stop' });
info('停会话', JSON.stringify(stop).slice(0, 120));

const fails = out.steps.filter((s) => !s.ok);
out.summary = { pass: out.steps.filter((s) => s.ok && !s.info).length, fail: fails.length };
mkdirSync(join(root, '..', 'recon', 'reports'), { recursive: true });
writeFileSync(join(root, '..', 'recon', 'reports', 'probe-e2e-jd.json'), JSON.stringify(out, null, 1));
console.log(`\n${fails.length ? `失败 ${fails.length} 项` : '全绿'} · 报告 PROBE-P1-e2e-jd.json`);
console.log('痕迹：\n' + out.shots.join('\n'));
process.exit(fails.length ? 1 : 0);
