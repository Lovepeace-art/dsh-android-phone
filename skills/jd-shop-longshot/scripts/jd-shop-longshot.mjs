#!/usr/bin/env node
/**
 * jd-shop-longshot.mjs —— 「京东搜店铺 → 进店 → 长截图店铺首页」一键执行器
 *
 * 它**不自带 adb**，而是驱动 DSH 里的 `dsh-android-phone` 插件 HTTP 接口
 * （默认 http://127.0.0.1:19387/dsh-android-phone/api，可用 --base 或 DSH_ANDROID_PHONE_API 覆盖）。
 * 插件负责能力（scrcpy 控制通道 + 长截图拼接），本脚本只提供**路径**。
 *
 * 用法：
 *   node jd-shop-longshot.mjs --keyword 牛奶 --shop 每日鲜语
 *   node jd-shop-longshot.mjs --keyword 光明 --shop 光明随心订 --out-dir D:\shots --json
 *
 * 退出码：0 成功 · 1 拿到长截图但自检/落点有问题 · 2 参数错 · 3 运行失败
 *
 * 落点依据（真机实测，见 PROGRESS.md「京东落点小抄」）：
 *   首页搜索框 = uiautomator 里 desc 含「搜索」且 clickable 的节点（1080x2400 上是 979,317）
 *   结果页店铺 tab 的节点文字形如「店铺,,未选中」→ 用 /^店铺/ 匹配，不要用 === '店铺'
 */

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (name) => argv.includes('--' + name);

if (has('help') || has('h')) {
  console.log(`用法: node jd-shop-longshot.mjs [选项]

  --keyword <词>    搜索关键字（必填，中文可以直接用）
  --shop <名字片段> 要进的店铺名片段，默认选店铺列表里第一个「旗舰店」
  --out-dir <目录>  把长截图和报告复制到这个目录（默认只放插件截图目录）
  --base <URL>      插件 API 根地址（默认 http://127.0.0.1:19387/dsh-android-phone/api）
  --max-steps <n>   长截图最多拼接步数，默认 8
  --force           人在操作（owner=human）时也强行拿控制权
  --json            只输出一行 JSON 结果（给程序吃）
  --keep-open       跑完不停会话（默认跑完停流省电）
`);
  process.exit(0);
}

const keyword = typeof arg('keyword', null) === 'string' ? arg('keyword') : null;
if (!keyword) { console.error('缺 --keyword（搜索关键字）'); process.exit(2); }
const shopWanted = typeof arg('shop', null) === 'string' ? arg('shop') : null;
const base = String(arg('base', process.env.DSH_ANDROID_PHONE_API || 'http://127.0.0.1:19387/dsh-android-phone/api')).replace(/\/+$/, '');
const maxSteps = Number(arg('max-steps', 8)) || 8;
const outDir = typeof arg('out-dir', null) === 'string' ? arg('out-dir') : null;
const asJson = has('json');
const force = has('force');
const keepOpen = has('keep-open');

const JINGDONG = 'com.jingdong.app.mall';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { if (!asJson) console.log(...a); };
const report = { ranAt: new Date().toISOString(), base, keyword, shopWanted, steps: [], shots: [] };
const RESULT = { ok: false, code: 3 };

async function api(path, { method = 'GET', body = null, timeoutMs = 180000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${data.error || text.slice(0, 200)}`);
    return data;
  } finally { clearTimeout(t); }
}
const post = (path, body) => api(path, { method: 'POST', body: body || {} });

const inspect = async (max = 240) => (await post('/inspect', { max })).nodes || [];
const fgActivity = async () => {
  const st = await api('/status');
  return st.session?.running ? (st.foreground?.activity || st.foreground?.package || null) : (st.foreground?.activity || null);
};
const textsOf = (nodes) => nodes.map((n) => `${n.text || ''} ${n.desc || ''}`.trim()).filter(Boolean);
const tapNode = async (node, screen, note) => {
  const w = screen?.width || 1080;
  const h = screen?.height || 2400;
  const r = await post('/action', { action: 'tap', nx: node.x / w, ny: node.y / h });
  report.steps.push({ step: 'tap', note, px: [node.x, node.y], via: r.via, ms: r.ms });
  log(`  · 点「${note}」(${node.x},${node.y}) → via=${r.via} ${r.ms}ms 前台=${r.foreground?.activity || '?'}`);
  return r;
};
const shot = async (name) => {
  const r = await post('/shot', { name });
  if (r.path) report.shots.push(r.path);
  return r;
};
const step = (name, ok, detail) => {
  report.steps.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  return !!ok;
};

async function main() {
  log(`== 京东搜店铺 → 进店 → 长截图 ==  关键字「${keyword}」${shopWanted ? ` 店铺「${shopWanted}」` : ''}`);
  log(`插件 API: ${base}`);

  // ---- 0. 前置检查：设备在线 + 会话 + 控制权 ----
  const st0 = await api('/status');
  if (!st0.ready || !st0.serial) throw new Error(`没有可用设备（status.ready=${st0.ready}）`);
  report.device = { serial: st0.serial, adbPath: st0.adbPath };
  log(`设备 ${st0.serial}`);

  const owner = await api('/owner').catch(() => ({ owner: 'ai' }));
  if (owner.owner === 'human' && !force) {
    throw new Error('控制权现在在人手上（owner=human）：请在 DSH 侧栏点「交还模型」，或加 --force 强行接管');
  }
  if (owner.owner === 'human' && force) await post('/owner', { owner: 'ai', reason: 'jd-shop-longshot --force' });

  if (!st0.session?.running) {
    const s = await post('/stream', { op: 'start' });
    report.session = { width: s.width, height: s.height, version: s.version };
    log(`起会话 ${s.width}x${s.height} scrcpy ${s.version}`);
  } else {
    report.session = { width: st0.session.width, height: st0.session.height, version: st0.session.version, reused: true };
  }
  const st1 = await api('/status');
  const screen = st1.screen || { width: 1080, height: 2400 };
  report.screen = screen;
  if (!st1.session?.control) log('⚠️ 控制通道没连上：中文输入和亚毫秒点击会回落 adb，结果可能不准');
  const controlOk = step('会话就绪（control 通道）', !!st1.session?.control, `${st1.session?.width}x${st1.session?.height} tunnel=${st1.session?.tunnel}`);

  // ---- 1. 打开京东：退掉开屏广告/详情页，直到真的在 MainFrameActivity 且能看见搜索框 ----
  const open = await post('/open', { package: JINGDONG });
  step('打开京东', open.ok === true, `via=${open.via} ${open.ms}ms → ${open.after}`);
  await sleep(6000);
  const searchCandsIn = (nodes) => nodes.filter((n) => /搜索/.test(`${n.text || ''} ${n.desc || ''}`) && typeof n.y === 'number' && n.y < screen.height * 0.4);
  let backs = 0;
  let searchNode = null;
  let fgAct = '';
  let lastCands = [];
  for (let i = 0; i < 6; i++) {
    const st = await api('/status');
    fgAct = st.foreground?.activity || '';
    const nodes = await inspect(240);
    lastCands = searchCandsIn(nodes);
    if (/MainFrameActivity/.test(fgAct) && lastCands.length) { searchNode = lastCands.find((n) => n.clickable) || lastCands[0]; break; }
    if (i === 5) break;
    await post('/action', { action: 'key', key: 'BACK' });
    backs += 1;
    log(`  · 当前 ${fgAct || '?'}，不是首页 → BACK（第 ${backs} 次）`);
    await sleep(1600);
  }
  report.searchCandidates = lastCands.map((n) => ({ text: n.text, desc: n.desc, clickable: n.clickable, x: n.x, y: n.y }));
  step('落到京东首页', /MainFrameActivity/.test(fgAct), `${fgAct || '?'}（按了 ${backs} 次 BACK）`);
  await shot(`jd-${Date.now()}-home`);

  // ---- 2. 点搜索框（首页 uiautomator 不给节点时用落点小抄坐标兜底） ----
  if (!searchNode && /MainFrameActivity/.test(fgAct)) {
    searchNode = { x: Math.round(screen.width * 0.906), y: Math.round(screen.height * 0.132), text: '', desc: '(落点小抄兜底)' };
    log('  · 首页这一屏 uiautomator 没给搜索节点 → 用落点小抄坐标 nx=0.906 ny=0.132');
  }
  if (!searchNode) throw new Error(`没进到京东首页（当前 ${fgAct || '?'}）：手机上肉眼看一下，或先手工退到首页再 --keep-open 重跑`);
  await tapNode(searchNode, screen, `首页搜索框(${searchNode.desc || searchNode.text})`);
  await sleep(2200);
  const sfg = (await api('/status')).foreground?.activity || '';
  step('进入搜索页', /ProductListActivity|search/i.test(sfg), sfg);

  // ---- 3. 输关键字 + 提交 ----
  const kb = await post('/keyboard', { text: keyword });
  step('输入关键字（控制通道中文）', kb.via === 'control' || kb.via === 'adb', `via=${kb.via} ${JSON.stringify(kb.sent || {})}`);
  await sleep(1500);
  const sub = await post('/action', { action: 'key', key: 'ENTER' });
  step('提交搜索', sub.via === 'control', `via=${sub.via} fg=${sub.foreground?.activity}`);
  await sleep(4500);

  const resNodes = await inspect(240);
  const resTexts = textsOf(resNodes);
  step(`结果页包含「${keyword}」`, resTexts.some((t) => t.includes(keyword)), JSON.stringify(resTexts.slice(0, 12)));
  await shot(`jd-${Date.now()}-results`);

  // ---- 4. 店铺 tab ----
  const shopTab = resNodes.find((n) => /^店铺/.test(`${n.text || ''} ${n.desc || ''}`.trim()))
    || resNodes.find((n) => /店铺[,，]/.test(`${n.text || ''} ${n.desc || ''}`) && typeof n.y === 'number' && n.y < screen.height * 0.6);
  if (!shopTab) throw new Error('结果页没找到「店铺」tab（京东版本差异）：用 phone_inspect 看这一屏的第一个 tab 再改脚本');
  await tapNode(shopTab, screen, `「店铺」tab(${shopTab.text || shopTab.desc})`);
  await sleep(3800);

  // ---- 5. 选店铺进店 ----
  const listNodes = await inspect(240);
  const storeNodes = listNodes.filter((n) => /旗舰店|专卖店|专营店|官方店/.test(`${n.text || ''}`));
  report.shops = storeNodes.slice(0, 10).map((n) => ({ text: n.text, x: n.x, y: n.y }));
  step('切到店铺列表', storeNodes.length > 0, JSON.stringify(storeNodes.slice(0, 6).map((n) => n.text)));
  if (!storeNodes.length) throw new Error('店铺列表里没有识别到店铺名（旗舰店/专卖店/专营店）');
  const store = (shopWanted && storeNodes.find((n) => n.text.includes(shopWanted))) || storeNodes[0];
  if (shopWanted && !store.text.includes(shopWanted)) log(`⚠️ 没找到「${shopWanted}」，退而进列表第一个「${store.text}」`);
  await tapNode(store, screen, `进店：${store.text}`);
  await sleep(4500);

  const inShop = await inspect(240);
  const inShopTexts = textsOf(inShop);
  const wentIn = !/关注,,推荐|秒杀|领券中心/.test(inShopTexts.join(' ')) || inShopTexts.some((t) => t.includes(store.text));
  step(`进入店铺首页（${store.text}）`, wentIn, JSON.stringify(inShopTexts.slice(0, 12)));
  await shot(`jd-${Date.now()}-shop-home`);
  report.shop = store.text;

  // ---- 6. 长截图 ----
  const name = `jd-shop-${Date.now()}`;
  const t0 = Date.now();
  const long = await post('/shot', { mode: 'long', name, maxSteps });
  const longMs = Date.now() - t0;
  const accepted = (long.steps || []).filter((s) => s.accepted).length;
  step('店铺首页长截图', !!long.path && long.height > 0,
    `${long.width}x${long.height} 接受 ${accepted} 帧 / 共 ${(long.steps || []).length} 帧 · ${longMs}ms · ${long.path}`);
  report.longshot = { path: long.path, width: long.width, height: long.height, bytes: long.bytes, acceptedFrames: accepted, totalFrames: (long.steps || []).length, ms: longMs };

  // ---- 7. 可选：复制到 out-dir ----
  if (outDir && long.path) {
    const { mkdir, copyFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(outDir, { recursive: true });
    const dest = join(outDir, `${name}.png`);
    await copyFile(long.path, dest);
    report.copiedTo = dest;
    report.reportPath = join(outDir, `${name}.json`);
    log(`长截图已复制：${dest}`);
    await writeFile(report.reportPath, JSON.stringify(report, null, 1));
  }

  // ---- 8. 收尾 ----
  if (!keepOpen) await post('/stream', { op: 'stop' }).catch(() => {});
  const passed = report.steps.filter((s) => s.ok).length;
  const failed = report.steps.filter((s) => s.ok === false).length;
  RESULT.ok = failed === 0;
  RESULT.code = failed === 0 ? 0 : 1;
  RESULT.longshot = report.longshot;
  RESULT.shop = report.shop;
  RESULT.pass = passed;
  RESULT.fail = failed;
  RESULT.control = controlOk;
  RESULT.report = report;
}

main()
  .catch((e) => {
    report.error = String((e && e.stack) || e);
    RESULT.ok = false;
    RESULT.code = 3;
    RESULT.error = String((e && e.message) || e);
    if (!asJson) console.error('FAIL', e);
  })
  .finally(() => {
    RESULT.report = report;
    if (asJson) console.log(JSON.stringify(RESULT));
    else if (RESULT.ok) console.log(`\n✅ 完成：${report.shop} 长截图 ${report.longshot?.width}x${report.longshot?.height} → ${report.longshot?.path}`);
    else console.log(`\n❌ 未能完成（exit ${RESULT.code}）：${RESULT.error || '见上面的 FAIL 行'}`);
    process.exit(RESULT.code);
  });
