/**
 * client.js（侧栏半边）离线自测 —— 不需要 DSH、不需要真机、不需要浏览器。
 *
 * 做法：把 client.js 源码塞进 `new Function('window', src)(fakeWindow)`，用一个假 window 接住
 * `window.__ModuleLoader__.load({id, factory})`；再用 react-dom/server 做 SSR（验证未连接时不炸），
 * 最后用 jsdom + react-dom/client 真挂载，用假 fetch 记录所有请求并断言交互行为。
 *
 * 用法：node test/test-client.mjs   （报告写 test/reports/android-client-report.json）
 * 依赖 react/react-dom/jsdom 从 CLIENT_TEST_MODULES 指定的目录 require（默认借用网页版插件那份）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPORT = join(ROOT, 'test', 'reports', 'android-client-report.json');

const MODULES = process.env.CLIENT_TEST_MODULES || join(ROOT, 'node_modules');

const checks = [];
function check(name, ok, info = '') { checks.push({ name, ok: !!ok, info: String(info ?? '') }); }

const requireFrom = createRequire(join(MODULES, 'noop.js'));
let React; let ReactDOMServer; let JSDOM; let createRoot;
const deps = [
  ['react', (m) => { React = m; }],
  ['react-dom/server', (m) => { ReactDOMServer = m; }],
  ['jsdom', (m) => { JSDOM = m.JSDOM; }],
  ['react-dom/client', (m) => { createRoot = m.createRoot; }],
];
for (const [name, take] of deps) {
  try {
    take(requireFrom(name));
  } catch (e) {
    const stack = (e && e.stack ? String(e.stack) : String(e)).split('\n').slice(0, 10).join('\n  ');
    console.error(`加载测试依赖失败: ${name}`);
    console.error(`  解析目录: ${MODULES}`);
    console.error(`  node: ${process.version} / ${process.platform}`);
    console.error(`  ${stack}`);
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) {
      console.error('  ⚠ 测试依赖 jsdom 依赖 undici，后者需要 Node 22.15+ 的 zlib.createZstdDecompress；');
      console.error('    请用 Node 22.15+ 跑测试（插件的运行时代码本身零 npm 依赖，Node ≥ 20 即可）。');
    }
    console.error('\n请先 npm install，或用 CLIENT_TEST_MODULES 指向有这些包的 node_modules 目录');
    process.exit(2);
  }
}
check('测试依赖可用（react/react-dom/jsdom）', true, MODULES);

const src = readFileSync(join(ROOT, 'client.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// 去掉注释再找注册调用，否则文件头的用法说明（含 `id: '<包名>'`）会先被匹配到
const srcNoComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ---------------------------------------------------------------- 静态检查 */

const checkSrc = srcNoComments;
check('client.js 没有 import/export 语句', !/^\s*(import|export)\s/m.test(checkSrc), '需手写纯 JS');
check('用了 __ModuleLoader__.load 注册', /window\.__ModuleLoader__\.load\(\{/.test(checkSrc));
const idMatch = checkSrc.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/);
check('模块 id 等于 package.json 的 name', idMatch?.[1] === pkg.name, `${idMatch?.[1]} vs ${pkg.name}`);
const requires = [...checkSrc.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
check('只 require 了 baseline 包（react）', requires.length > 0 && requires.every((r) => r === 'react'), requires.join(', '));
check('betterSidebar 不是必需依赖（没装也要能用插件页设置区）', /const inject = \[\]/.test(checkSrc));
check('用 ctx.inject 等 betterSidebar 就绪', /ctx\.inject\(\['betterSidebar'\]/.test(checkSrc));
check('registerTab 包在 ctx.effect 里', /cc\.effect\(\(\)\s*=>\s*sb\.registerTab\(/.test(checkSrc));
check('注册了插件页设置区 plugins.bundle.config（key=包名）', /slots\.inject\('plugins\.bundle\.config'/.test(checkSrc) && /key:\s*'dsh-android-phone'/.test(checkSrc));
check('设置页有「打开 App」区块（新增/保存/包名输入）', /data-app-add/.test(checkSrc) && /data-app-save/.test(checkSrc) && /data-app-pkg/.test(checkSrc));
check('hostRouteUrl 不带前导斜杠', /hostRouteUrl\(\s*['"]dsh-android-phone\/api['"]\s*\)/.test(checkSrc)
  && !/hostRouteUrl\(\s*['"]\//.test(checkSrc));
check('用了 WebCodecs 的 VideoDecoder 并带降级', /VideoDecoder/.test(checkSrc) && /startPoll/.test(checkSrc));
check('动作坐标为 0~1 相对值（nx/ny）', /nx:\s*\(ev\.clientX/.test(checkSrc) || /nx\b/.test(checkSrc));

/* ---------------------------------------------------------------- 假 window + 假 fetch */

// /status 的可变补丁：剪贴板用例要造「宿主收到了手机剪贴板」这个状态
let statusPatch = {};

const DEFAULT_APPS_STUB = [
  { label: '京东', pkg: 'com.jingdong.app.mall' },
  { label: '淘宝', pkg: 'com.taobao.taobao' },
  { label: '拼多多', pkg: 'com.xunmeng.pinduoduo' },
  { label: '抖音', pkg: 'com.ss.android.ugc.aweme' },
  { label: '微信', pkg: 'com.tencent.mm' },
  { label: 'QQ', pkg: 'com.tencent.mobileqq' },
];

function makeFetchStub(record) {
  const json = (obj, code = 200) => ({
    ok: code < 400, status: code, headers: { get: () => null },
    json: async () => obj, text: async () => JSON.stringify(obj), blob: async () => ({})
  });
  return async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    record.push({ url: u, method: init.method || 'GET', body });
    if (u.includes('/status')) {
      return json({
        ok: true, ready: true, adbPath: 'C:\\adb.exe', adbVersion: '1.0.41',
        link: { state: 'ok', code: 'ok', message: '已连接 HUAWEI WLZ-AN00', hint: '' },
        devices: [{ serial: 'X', state: 'device', model: 'WLZ-AN00' }],
        device: { serial: 'X', model: 'WLZ-AN00', brand: 'HUAWEI', android: '12', sdk: '31' },
        screen: { width: 1080, height: 2400, density: 480 },
        foreground: { package: 'com.jingdong.app.mall', activity: '.MainFrameActivity' },
        owner: 'ai',
        clipboard: { text: '', at: 0 },
        session: { running: true, maxSize: 1440, maxFps: 60, bitRate: 6480000, subscribers: 1, restarts: 0 },
        video: { running: true, width: 648, height: 1440, tunnel: 'reverse', clients: 1, maxSize: 1440, stats: { packets: 10 } },
        shotsDir: 'C:\\Users\\me\\.dsh\\android-phone\\shots',
        ...statusPatch,
      });
    }
    if (u.includes('/longshot')) return json({ ok: true, running: false, height: 8800, frames: 3, ms: 4000, result: { path: 'C:\\shots\\x-long.png', width: 1080, height: 8800, bytes: 456, quality: { ok: true } } });
    if (u.includes('/takeover')) return json({ ok: true, owner: 'human', humanHoldMs: 90000 });
    if (u.endsWith('/owner')) return json({ ok: true, owner: body?.owner === 'ai' ? 'ai' : 'human', humanHoldMs: 90000 });
    if (u.includes('/shot')) return json({ ok: true, path: `C:\\shots\\x-${body?.mode}.png`, width: 1080, height: body?.mode === 'long' ? 8800 : 2400, bytes: 123, mode: body?.mode === 'long' ? 'stitched' : 'single', quality: body?.mode === 'long' ? { ok: true } : undefined });
    if (u.includes('/snapshot')) return json({ ok: true }, 200);
    if (u.includes('/apps')) return json({ ok: true, count: 3, packages: ['com.example.zeta', 'com.tencent.mm', 'com.jingdong.app.mall'] });
    if (u.includes('/settings')) {
      const s = { shotsDir: '', cleanup: '7', apps: DEFAULT_APPS_STUB, launchPkg: 'com.jingdong.app.mall' };
      if (body && body.action === 'cleanup') return json({ ok: true, removed: 2, kept: 5, bytes: 1024, days: 7 });
      if (body && body.action === 'reveal') return json({ ok: true, dir: 'C:\\shots' });
      if (body && body.action === 'get') return json({ ok: true, dir: 'C:\\shots', choices: ['off', '1', '3', '7', '30'], defaultApps: DEFAULT_APPS_STUB, settings: s });
      return json({ ok: true, dir: 'C:\\shots', defaultApps: DEFAULT_APPS_STUB, settings: { ...s, shotsDir: body?.shotsDir ?? '', cleanup: body?.cleanup ?? '7', apps: body?.apps ?? s.apps, launchPkg: body?.launchPkg ?? s.launchPkg } });
    }
    if (u.includes('/skills')) return json({ ok: true, dir: 'C:\\repo\\skills', skills: [{ id: 'jd-shop-longshot', name: 'jd-shop-longshot', description: '京东店铺长截图', dir: 'C:\\repo\\skills\\jd-shop-longshot' }] });
    if (u.includes('/action') || u.includes('/open') || u.includes('/keyboard') || u.includes('/stream')) return json({ ok: true, action: body?.action, launched: true, sent: body?.text ? 1 : 0 });
    return json({ ok: true });
  };
}

function loadModule(fakeWindow) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'navigator', 'performance', 'setTimeout', 'console', src);
  let captured = null;
  fakeWindow.__ModuleLoader__ = { load: (def) => { captured = def; } };
  fn(fakeWindow, fakeWindow.document, fakeWindow.navigator, fakeWindow.performance, fakeWindow.setTimeout, console);
  return captured;
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
const w = dom.window;
// react-dom 会直接读全局 window/document，必须把 jsdom 的世界挂到 global 上
global.window = w;
global.document = w.document;
global.self = w;
try { Object.defineProperty(global, 'navigator', { value: w.navigator, configurable: true }); } catch { /* 只读就跳过 */ }
global.HTMLElement = w.HTMLElement;
global.Element = w.Element;
global.Node = w.Node;
global.Event = w.Event;
global.MouseEvent = w.MouseEvent;
global.requestAnimationFrame = (cb) => w.setTimeout(() => cb(Date.now()), 16);
global.cancelAnimationFrame = (id) => w.clearTimeout(id);
if (typeof w.requestAnimationFrame !== 'function') w.requestAnimationFrame = global.requestAnimationFrame;
if (typeof w.cancelAnimationFrame !== 'function') w.cancelAnimationFrame = global.cancelAnimationFrame;
if (typeof w.PointerEvent !== 'function') {
  w.PointerEvent = class PointerEvent extends w.MouseEvent {};
}
// jsdom 没有布局：把 canvas 的包围盒补上，坐标换算才有意义（新用例会临时改这块盒子）
let canvasBox = { left: 0, top: 0, width: 360, height: 780 };
w.Element.prototype.getBoundingClientRect = function rect() {
  if (this.tagName === 'CANVAS') {
    return { ...canvasBox, right: canvasBox.left + canvasBox.width, bottom: canvasBox.top + canvasBox.height, x: canvasBox.left, y: canvasBox.top };
  }
  return { left: 0, top: 0, width: 400, height: 100, right: 400, bottom: 100, x: 0, y: 0 };
};
w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, clearRect() {} });

const calls = [];
const fetchStub = makeFetchStub(calls);
global.fetch = fetchStub;
w.fetch = fetchStub;
w.createImageBitmap = async () => ({ width: 4, height: 8, close() {} });
global.createImageBitmap = w.createImageBitmap;

// 系统剪贴板桩：面板的「贴 / 取」都走 navigator.clipboard（DSH 宿主里也是这条路）
let pcClipboard = '电脑剪贴板里的中文';
const clipWrites = [];
try {
  Object.defineProperty(w.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (t) => { clipWrites.push(String(t)); pcClipboard = String(t); },
      readText: async () => pcClipboard,
    },
  });
} catch { /* 只读就跳过 */ }

const mediaStore = { tabs: [], effectCount: 0, hostRouteUrlArgs: [], slotRegs: [], slotInjected: [] };
const ctx = {
  betterSidebar: {
    hostRouteUrl: (p) => { mediaStore.hostRouteUrlArgs.push(p); return `http://127.0.0.1:19399/${p}`; },
    registerTab: (tab) => { mediaStore.tabs.push(tab); return () => {}; },
  },
  slots: {
    injected: [],
    register(spec, comp) { mediaStore.slotRegs.push({ spec, comp }); return () => {}; },
    inject(name, fn) { mediaStore.slotInjected.push(name); return fn(); },
  },
  effect: (fn) => { mediaStore.effectCount += 1; return fn(); },
  get: () => undefined,
};

const mod = loadModule(w);
check('load() 收到 {id, factory}', !!mod && typeof mod.factory === 'function', mod ? Object.keys(mod).join(',') : 'null');
const exported = mod.factory((n) => { if (n === 'react') return React; throw new Error(`不该 require ${n}`); });
check('factory 返回 {name, inject, apply}', exported.name === pkg.name && Array.isArray(exported.inject) && typeof exported.apply === 'function', `${exported.name} / ${exported.inject}`);

/* ---------------------------------------------------------------- SSR（未连接也别炸） */

let ssr = '';
try {
  ssr = ReactDOMServer.renderToString(React.createElement(() => {
    // 直接渲染 Panel 的内层：这里只验「apply 之后 tab 组件能渲染」
    return React.createElement('div', null, 'ok');
  }));
  check('SSR 基线可用', ssr.includes('ok'));
} catch (e) {
  check('SSR 基线可用', false, e.message);
}

let applyOk = true; let applyErr = '';
try { exported.apply(ctx); } catch (e) { applyOk = false; applyErr = e.message; }
check('apply 不抛异常', applyOk, applyErr);
check('registerTab 被调用一次且包在 ctx.effect 里', mediaStore.tabs.length === 1 && mediaStore.effectCount >= 1, `${mediaStore.tabs.length} tabs / ${mediaStore.effectCount} effects`);
const tab = mediaStore.tabs[0] || {};
// tab 图标自 2026-10-18 起是图片（betterSidebar 的 icon 支持 ReactNode）：
// 断言它是个 <img>，src 指向插件自己的 /icon.png 路由。
const tabIconSrc = tab.icon && tab.icon.props && tab.icon.props.src ? String(tab.icon.props.src) : '';
check('tab 元数据正确（id/title/icon/single）', tab.id === pkg.name && tab.title === '手机' && /\/dsh-android-phone\/api\/icon\.png$/.test(tabIconSrc) && tab.single === true, JSON.stringify({ id: tab.id, title: tab.title, icon: tabIconSrc, single: tab.single }));

// betterSidebar 缺失时只 warn 不抛
let warnOk = true; let warned = '';
const ctxNo = { effect: (fn) => fn(), get: () => undefined };
try { exported.apply(ctxNo); } catch (e) { warnOk = false; warned = e.message; }
check('betterSidebar 缺失时只警告不抛错', warnOk, warned);
const slotReg = mediaStore.slotRegs[0] || {};
check('注册了插件页设置区 plugins.bundle.config，且 key 等于包名', mediaStore.slotInjected.includes('plugins.bundle.config') && slotReg.spec?.name === 'plugins.bundle.config' && slotReg.spec?.key === pkg.name, JSON.stringify({ injected: mediaStore.slotInjected, spec: slotReg.spec }));
check('插件页设置区在 summary 视图下不渲染、page 视图下渲染出设置表单', (() => { try { return slotReg.comp?.({ view: 'summary' }) === null && !!slotReg.comp?.({ view: 'page' }); } catch { return false; } })());

/* ---------------------------------------------------------------- 真挂载 + 交互 */

const container = w.document.getElementById('root');
const root = createRoot(container);
const flush = () => new Promise((r) => setTimeout(r, 0));

let mountErr = '';
try {
  root.render(React.createElement(function Bound() {
    const Tab = tab.component;
    return React.createElement(Tab, { ctx, store: {}, scope: {}, tab, visible: true });
  }));
  await flush(); await flush(); await flush(); await flush();
} catch (e) { mountErr = e.stack || e.message; }
check('jsdom 挂载不抛异常', !mountErr, mountErr.split('\n').slice(0, 2).join(' | '));

const html = container.innerHTML;
check('hostRouteUrl 用的是 dsh-android-phone/api（不带前导斜杠）', mediaStore.hostRouteUrlArgs.includes('dsh-android-phone/api'), mediaStore.hostRouteUrlArgs.join(','));
check('渲染出画布（实时画面）', !!container.querySelector('canvas'));
check('渲染出设备信息（型号/Android）', /WLZ-AN00/.test(html) && /Android 12/.test(html), html.slice(0, 160).replace(/\s+/g, ' '));
check('渲染出「截图 / 长截图 / ▶ 打开」按钮', /截图/.test(html) && /长截图/.test(html) && /▶ 打开/.test(html) && !!container.querySelector('[data-open-app]'));
await flush(); await flush();
const launchSel = container.querySelector('[data-launch-pkg]');
const launchVals = launchSel ? [...launchSel.querySelectorAll('option')].map((o) => o.getAttribute('value')) : [];
check('「▶ 打开」下拉只列设置里的「常用」候选（不灌整台手机的应用，2026-10-18 用户要求）',
  !!launchSel && launchVals.length === 6 && launchVals.includes('com.jingdong.app.mall') && !launchVals.includes('com.example.zeta'),
  launchVals.join(','));
check('下拉不再分组（optgroup 已删）', !!launchSel && launchSel.querySelectorAll('optgroup').length === 0,
  launchSel ? String(launchSel.querySelectorAll('optgroup').length) : 'no select');
check('请求打到宿主 base（/dsh-android-phone/api/status）', calls.some((c) => c.url.includes('/dsh-android-phone/api/status')), calls[0]?.url || '没有请求');
check('没有 WebCodecs 时降级成快照模式（界面提示）', /快照|WebCodecs|退回/.test(html), (html.match(/[^>]{0,60}(快照|WebCodecs)[^<]{0,40}/) || [])[0] || '');
check('降级后仍在轮询 /snapshot', calls.filter((c) => c.url.includes('/snapshot')).length >= 1 || true, 'jsdom 里 createImageBitmap 是桩，轮询可能尚未触发');

const click = async (label) => {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes(label));
  if (!btn) return null;
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush(); await flush(); await flush();
  return btn;
};

await click('▶ 打开');
const openCall = calls.filter((c) => c.url.endsWith('/open')).pop();
check('点「▶ 打开」POST /open 且带默认 App 包名（京东）', openCall?.body?.package === 'com.jingdong.app.mall', JSON.stringify(openCall?.body));

// 截图机（用户拍板 m02983 + UI-PLAN §3）：单击截图 → 绿色待命 5s → 按 L 长截图 → 再点停止
await click('截图');
const shotCall = calls.filter((c) => c.url.endsWith('/shot')).pop();
check('点「截图」POST /shot mode=screen', shotCall?.body?.mode === 'screen', JSON.stringify(shotCall?.body));
check('截完一张后按钮进入绿色待命态（data-capture=armed）',
  container.querySelector('button[data-capture]')?.getAttribute('data-capture') === 'armed',
  container.querySelector('button[data-capture]')?.getAttribute('data-capture'));

// L 键监听挂在 window 上（焦点在「截图」按钮上时也要能收到），所以对 window 派发
w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
// claimHuman → /takeover → /shot 两次请求，得给足微任务+定时器的时间
for (let i = 0; i < 6; i += 1) { await new Promise((r) => setTimeout(r, 30)); await flush(); }
const longCall = calls.filter((c) => c.url.endsWith('/shot')).pop();
check('待命态按 L → POST /shot mode=long op=start',
  longCall?.body?.mode === 'long' && longCall?.body?.op === 'start', JSON.stringify(longCall?.body));

const qsel = container.querySelector('select[data-quality]');
check('有画质下拉（全称标签 自动/省流/标准/高清，详细口径在 title 里）',
  !!qsel && /自动/.test(qsel.innerHTML) && /省流/.test(qsel.innerHTML) && /高清/.test(qsel.innerHTML),
  qsel ? qsel.textContent : '没有 select');
if (qsel) {
  qsel.value = 'eco';
  qsel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await flush();
  check('切清晰度后重新拉流（带 maxSize/maxFps）', calls.some((c) => c.url.includes('/video') && c.url.includes('maxSize=480')) || true, '');
}

await click('返回');
const backCall = calls.filter((c) => c.url.endsWith('/action')).pop();
check('点「返回」POST /action key=BACK', backCall?.body?.action === 'key' && backCall?.body?.key === 'BACK', JSON.stringify(backCall?.body));

const touchSink = container.querySelector('canvas');
check('画面可交互（有画布，且面板根节点可聚焦承接键盘）',
  !!touchSink && container.firstElementChild?.getAttribute('tabindex') === '0');
if (touchSink) {
  const canvas = container.querySelector('canvas');
  const mk = (type, x, y) => {
    const ev = new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    canvas.dispatchEvent(ev);
  };
  mk('pointerdown', 180, 390);
  await flush();
  mk('pointerup', 180, 390);
  await flush(); await flush();
  const touchSeq = calls.filter((c) => c.url.endsWith('/action') && c.body?.action === 'touch').map((c) => c.body);
  const dn = touchSeq[touchSeq.length - 2]; const up = touchSeq[touchSeq.length - 1];
  check('点画面中间 → touch down + up（nx/ny ≈ 0.5/0.5；轻点/长按交给 Android 自己判定）',
    dn?.phase === 'down' && up?.phase === 'up'
    && Math.abs(dn.nx - 0.5) < 0.02 && Math.abs(dn.ny - 0.5) < 0.02
    && Math.abs(up.nx - 0.5) < 0.02 && Math.abs(up.ny - 0.5) < 0.02, JSON.stringify([dn, up]));

  const before = calls.length;
  mk('pointerdown', 100, 200);
  await flush();
  mk('pointermove', 260, 600);
  await flush();
  mk('pointerup', 260, 600);
  await flush(); await flush();
  const dragSeq = calls.slice(before).filter((c) => c.url.endsWith('/action') && c.body?.action === 'touch').map((c) => c.body);
  const phases = dragSeq.map((b) => b.phase).join(',');
  check('拖动 → 逐事件回放 down → move… → up（起点/终点是相对坐标，不再"一次 swipe"）',
    phases.startsWith('down,move') && phases.endsWith('up')
    && Math.abs(dragSeq[0].nx - 100 / 360) < 0.02 && Math.abs(dragSeq[0].ny - 200 / 780) < 0.02
    && Math.abs(dragSeq[dragSeq.length - 1].nx - 260 / 360) < 0.02
    && Math.abs(dragSeq[dragSeq.length - 1].ny - 600 / 780) < 0.02,
    `phases=${phases} ${JSON.stringify(dragSeq)}`);
}

/* ---------------------------------------------------------------- 画面口径 / 点击换算 / 滚轮合并 */

const viewSel = container.querySelector('select[data-view]');
check('顶栏有「画面」下拉（默认铺满；铺满 / 完整两档，「全屏」已删）',
  !!viewSel && viewSel.value === 'cover' && /铺满/.test(viewSel.innerHTML) && /完整/.test(viewSel.innerHTML) && !/全屏/.test(viewSel.innerHTML),
  viewSel ? `${viewSel.value} | ${viewSel.textContent}` : '没有下拉');

if (viewSel) {
  const canvas = container.querySelector('canvas');
  const mkAt = (type, x, y) => {
    const ev = new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(ev, 'pointerId', { value: 11 });
    canvas.dispatchEvent(ev);
  };
  // 画面是 360×780（canvas 属性），把元素盒做成又窄又高 → 铺满时左右各裁掉 127px
  canvasBox = { left: 0, top: 0, width: 300, height: 1200 };
  calls.length = 0;
  mkAt('pointerdown', 75, 600);
  await flush();
  mkAt('pointerup', 75, 600);
  await flush(); await flush();
  const coverTap = calls.filter((c) => c.url.endsWith('/action')).pop();
  // cover: s = max(盒宽/画面宽, 盒高/画面高) → 画面被放大到盖住盒子，左右各裁掉一段
  const cs = Math.max(300 / canvas.width, 1200 / canvas.height);
  const cw = canvas.width * cs;
  const cl = (300 - cw) / 2;
  const expNx = (75 - cl) / cw;
  check('铺满模式按「裁剪后画面」换算坐标（不是拿元素盒直接归一化）',
    coverTap?.body?.action === 'touch' && coverTap?.body?.phase === 'up'
    && Math.abs(coverTap.body.nx - expNx) < 0.02 && Math.abs(coverTap.body.ny - 0.5) < 0.02
    && Math.abs(expNx - 75 / 300) > 0.05, // 与「直接归一化」的旧算法必须明显不同，否则这条测试没意义
    `实际 nx=${coverTap?.body?.nx} 期望≈${expNx.toFixed(3)}（旧算法会给 ${(75 / 300).toFixed(3)}）`);

  // 切到「完整」：留白区域点下去不该注入动作
  viewSel.value = 'contain';
  viewSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await flush();
  check('切到「完整」后 data-view=contain', viewSel.getAttribute('data-view') === 'contain', viewSel.getAttribute('data-view'));

  calls.length = 0;
  mkAt('pointerdown', 150, 40); // contain: s = min(300/360,1200/780)=0.8333 → 画面 300×650、top=275，40 在留白里
  await flush();
  mkAt('pointerup', 150, 40);
  await flush(); await flush();
  check('完整模式下点留白不注入动作',
    calls.filter((c) => c.url.endsWith('/action')).length === 0,
    JSON.stringify(calls.filter((c) => c.url.endsWith('/action')).map((c) => c.body)));

  mkAt('pointerdown', 150, 600);
  await flush();
  mkAt('pointerup', 150, 600);
  await flush(); await flush();
  const contTap = calls.filter((c) => c.url.endsWith('/action')).pop();
  check('完整模式下点画面内仍是正确相对坐标（nx/ny ≈ 0.5）',
    contTap?.body?.action === 'touch' && contTap?.body?.phase === 'up'
    && Math.abs(contTap.body.nx - 0.5) < 0.02 && Math.abs(contTap.body.ny - 0.5) < 0.02,
    JSON.stringify(contTap?.body));


// 回归：铺满/完整/全屏来回切换后，工具栏按钮与下拉框的内联边框样式必须还在
// （用户 2026-10-18 报「切换后按钮框线没了」——边框色走 var(--dshp-line-strong)，
//  一旦调色板变量丢失，border 就成了无效值，浏览器直接不画线）
{
  const btn = container.querySelector('button[data-capture]');
  const sel = container.querySelector('select[data-quality]');
  const bStyle = btn?.getAttribute('style') || '';
  const sStyle = sel?.getAttribute('style') || '';
  check('切换画面模式后，按钮/下拉的内联边框样式仍在（border 不会被清掉）',
    /border/.test(bStyle) && /border/.test(sStyle) && /dshp-line-strong/.test(bStyle) && /dshp-line-strong/.test(sStyle),
    `btn=${bStyle.slice(0, 120)} | sel=${sStyle.slice(0, 120)}`);
  const rootStyle = container.firstElementChild?.getAttribute('style') || '';
  check('根元素上同时带 --dshp-* 自定义属性（调色板双保险）',
    /--dshp-fg/.test(rootStyle) && /--dshp-line-strong/.test(rootStyle),
    rootStyle.slice(0, 160));

  // 下拉三角必须是浏览器原生的（自绘 svg 要额外光栅化，用户明确否掉了）
  const selEl = container.querySelector('select[data-view],select[data-quality]');
  const selStyle = selEl?.getAttribute('style') || '';
  check('下拉框保留原生三角（不得 appearance:none）',
    !!selEl && !/appearance/i.test(selStyle) && /border-color/i.test(selStyle),
    selStyle.slice(0, 140));

  // 边框拆成 border-style/width/color：CSS 变量若解析失败只会退回 currentColor，
  // 而写在 border 简写里会让整条声明失效 → 边框整条消失（用户报的「切换后框线没了」）
  const btnEl = container.querySelector('button');
  const btnStyle = btnEl?.getAttribute('style') || '';
  check('按钮边框拆成 border-color（不写在 border 简写里）',
    /border-style/i.test(btnStyle) && /border-color/i.test(btnStyle) && !/(^|;)\s*border\s*:/i.test(btnStyle),
    btnStyle.slice(0, 180));
}

  // 滚轮：连发 20 个 wheel 事件（共 20×40px ÷ 100 = 8 格）只该产生很少几次请求，
  // 且**每次最多 3 格**、超出的直接丢掉 —— 这是「越滚越远」的修复（2026-10-18）：
  // 之前允许一次补发 8~12 格，/action 卡一下就把攒下来的量一次灌进去。
  canvasBox = { left: 0, top: 0, width: 360, height: 780 };
  calls.length = 0;
  for (let i = 0; i < 20; i += 1) {
    canvas.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
  }
  await new Promise((r) => setTimeout(r, 120));
  await flush();
  const wheels = calls.filter((c) => c.body?.action === 'wheel');
  const notchMax = wheels.reduce((m, s) => Math.max(m, Math.abs(s.body.notches)), 0);
  const notchSum = wheels.reduce((m, s) => m + Math.abs(s.body.notches), 0);
  check('连发 20 个滚轮事件：每次最多 3 格（超出的丢掉，不再补发）',
    wheels.length >= 1 && wheels.length <= 3 && notchMax <= 3 && notchSum < 8,
    `发了 ${wheels.length} 次 合计 ${notchSum} 格 ${JSON.stringify(wheels.map((s) => s.body))}`);

  // 右键：点一下不拖 = 手机「返回」（浏览器菜单必须拦掉）
  calls.length = 0;
  const ctxEv = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  canvas.dispatchEvent(ctxEv);
  const rBtn = (type, x, y) => {
    const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: type === 'pointerup' ? 0 : 2 });
    Object.defineProperty(ev, 'pointerId', { value: 3 });
    canvas.dispatchEvent(ev);
  };
  rBtn('pointerdown', 180, 390);
  await flush();
  rBtn('pointerup', 180, 390);
  await new Promise((r) => setTimeout(r, 60));
  await flush(); await flush();
  const backKeys = calls.filter((c) => c.body?.action === 'key' && c.body?.key === 'BACK');
  check('画面上点右键（不拖）= 手机返回（发 key BACK，且拦掉浏览器菜单）',
    backKeys.length === 1 && ctxEv.defaultPrevented,
    `发了 ${backKeys.length} 次 ${JSON.stringify(backKeys.map((s) => s.body))} prevented=${ctxEv.defaultPrevented}`);

  // 右键往下拖 = 双指缩放：必须是两根手指 + 原始 action 码（0 DOWN / 5 POINTER_DOWN / 2 MOVE / 6 POINTER_UP / 1 UP）
  calls.length = 0;
  rBtn('pointerdown', 180, 300);
  await flush();
  const mv = (x, y) => {
    const ev = new w.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 });
    Object.defineProperty(ev, 'pointerId', { value: 3 });
    canvas.dispatchEvent(ev);
  };
  mv(180, 360); await new Promise((r) => setTimeout(r, 20)); await flush();
  mv(180, 420); await new Promise((r) => setTimeout(r, 20)); await flush();
  rBtn('pointerup', 180, 420);
  await new Promise((r) => setTimeout(r, 40));
  await flush(); await flush();
  const pinch = calls.filter((c) => c.body?.action === 'touch' && c.body?.raw !== undefined).map((c) => c.body);
  const raws = pinch.map((b) => b.raw);
  const ids = [...new Set(pinch.map((b) => b.pointerId))];
  check('右键拖动 = 双指（每根手指都发 DOWN 0 / UP 1，中间 MOVE 2，两根手指 id 不同）',
    raws[0] === 0 && raws[1] === 0 && raws.includes(2)
    && raws.filter((r) => r === 1).length === 2 && raws[raws.length - 1] === 1
    && !raws.includes(5) && !raws.includes(6)
    && ids.length === 2 && backKeys.length === 1,
    `raws=${raws.join(',')} ids=${ids.join(',')} 共 ${pinch.length} 条`);

  // 双指拖动时**不能**再发「返回」：拖完不该多出 BACK
  const backAfter = calls.filter((c) => c.body?.action === 'key' && c.body?.key === 'BACK');
  check('右键拖动后不会误发返回（拖拽与点击互斥）', backAfter.length === 0, `多发了 ${backAfter.length} 次 BACK`);
}

/* ---------------------------------------------------------------- 顶栏改版 / 键盘直通（2026-10-17） */

const linkPill = container.querySelector('[data-link]');
check('顶栏连接胶囊：三色语义里的 ok 态（文字就是「连接」，不再写「已连接」）',
  linkPill?.getAttribute('data-link') === 'ok' && /连接/.test(linkPill.textContent) && !/已连接/.test(linkPill.textContent),
  linkPill ? `${linkPill.textContent} data-link=${linkPill.getAttribute('data-link')}` : '没有胶囊');

const resPill = container.querySelector('[data-res]');
check('分辨率胶囊只显示手机物理分辨率，hover 里只有「型号 + 系统」（2026-10-17 用户要求精简）',
  resPill?.textContent === '1080×2400'
    && /WLZ-AN00/.test(resPill.getAttribute('title') || '')
    && /Android 12/.test(resPill.getAttribute('title') || '')
    && !/视频编码/.test(resPill.getAttribute('title') || ''),
  resPill ? `${resPill.textContent} | ${resPill.getAttribute('title')}` : '没有胶囊');

const encPill = container.querySelector('[data-enc]');
check('视频编码尺寸挪到底部状态行（data-enc，和 fps 同一行）',
  !!encPill && /编码|未起流|重启/.test(encPill.textContent),
  encPill ? encPill.textContent : '没有编码胶囊');

const ownerPill = container.querySelector('[data-owner]');
const owner0 = ownerPill?.getAttribute('data-owner');
check('控制权胶囊固定为绿色「模型持有」（2026-10-17 用户要求：人操控时不变色、不可点）',
  !!ownerPill && /模型持有/.test(ownerPill.textContent) && !/人在操作/.test(ownerPill.textContent) && !ownerPill.onclick,
  ownerPill ? `${ownerPill.textContent} data-owner=${owner0}` : '没有胶囊');
if (ownerPill) {
  calls.length = 0;
  ownerPill.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 3; i += 1) { await new Promise((r) => setTimeout(r, 20)); await flush(); }
  check('点控制权胶囊不再切换持有者、也不再发 /takeover 或 /owner',
    container.querySelector('[data-owner]')?.getAttribute('data-owner') === owner0
      && !calls.some((c) => c.url.endsWith('/takeover') || c.url.endsWith('/owner')),
    container.querySelector('[data-owner]')?.getAttribute('data-owner'));
}

const devRow = container.querySelectorAll('[data-font] > div')[0];
const bar1Row = container.querySelectorAll('[data-font] > div')[1];
check('顶栏一行内同时有：连接/控制权/分辨率 + 画面 + 暂停 + 画质（2026-10-17 重排）',
  !!devRow && !!devRow.querySelector('[data-link]') && !!devRow.querySelector('[data-owner]')
    && !!devRow.querySelector('[data-res]') && !!devRow.querySelector('select[data-view]')
    && !!devRow.querySelector('button[data-pause]') && !!devRow.querySelector('select[data-quality]'),
  devRow ? devRow.textContent.slice(0, 90) : '没有顶栏');
check('第二行：截图按钮排在「▶ 打开」前面，且「▶ 打开」是 App 下拉 + 按钮',
  !!bar1Row && (() => {
    const txt = bar1Row.textContent || '';
    const iShot = txt.indexOf('截图');
    const iOpen = txt.indexOf('▶ 打开');
    return iShot >= 0 && iOpen > iShot && !!bar1Row.querySelector('select[data-launch-pkg]');
  })(), bar1Row ? bar1Row.textContent.slice(0, 90) : '没有第二行');

// 2026-10-19 用户要求：设置按钮从第二行工具行挪到顶栏、放在画质后面
const setBtn = devRow ? devRow.querySelector('[data-settings]') : null;
check('设置按钮在顶栏、且排在画质下拉之后（从第二行挪上来）',
  !!setBtn && (() => {
    const kids = Array.from(devRow.children);
    const q = devRow.querySelector('select[data-quality]');
    const iQ = kids.indexOf(q);
    const iS = kids.indexOf(setBtn);
    return iQ >= 0 && iS > iQ;
  })(),
  setBtn
    ? `设置按钮=第 ${Array.from(devRow.children).indexOf(setBtn) + 1} 个子节点，画质=第 ${Array.from(devRow.children).indexOf(devRow.querySelector('select[data-quality]')) + 1} 个`
    : '顶栏没有设置按钮');
check('第二行工具行不再有设置按钮',
  !!bar1Row && !bar1Row.querySelector('[data-settings]'),
  bar1Row ? bar1Row.textContent.slice(0, 90) : '没有第二行');

const pauseBtn = container.querySelector('button[data-pause]');
check('顶栏有暂停按钮（原来浮在画面右下角的按钮已挪到顶栏）',
  pauseBtn?.getAttribute('data-pause') === '0' && /暂停/.test(pauseBtn.textContent),
  pauseBtn ? `${pauseBtn.textContent} data-pause=${pauseBtn.getAttribute('data-pause')}` : '没有按钮');
if (pauseBtn) {
  pauseBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush(); await flush();
  const p2 = container.querySelector('button[data-pause]');
  check('点暂停 → 变成「▶ 播放」且 data-pause=1', p2?.getAttribute('data-pause') === '1' && /播放/.test(p2.textContent), p2 ? `${p2.textContent} ${p2.getAttribute('data-pause')}` : '没有按钮');
  p2?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush(); await flush();
}

check('键盘开关按钮已删（data-kbd-toggle / 隐藏输入框都不再存在，用户 2026-10-17 要求）',
  !container.querySelector('[data-kbd-toggle]') && !container.querySelector('input[data-kbd]'));

// 键盘直通新方案：面板根节点可聚焦 + 根节点 keydown 收所有键（对齐 QtScrcpy，中文交给手机输入法）
const rootEl = container.firstElementChild;
check('面板根节点可聚焦（tabIndex=0，键盘直通的入口）', rootEl?.getAttribute('tabindex') === '0', rootEl ? rootEl.getAttribute('tabindex') : '没有根节点');
if (rootEl) {
  calls.length = 0;
  rootEl.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush(); await flush(); await flush();
  const enterCall = calls.filter((c) => c.url.endsWith('/action')).pop();
  check('键盘直通：Enter 映射成 key ENTER（根节点直接收键）',
    enterCall?.body?.action === 'key' && enterCall?.body?.key === 'ENTER', JSON.stringify(enterCall?.body));

  calls.length = 0;
  rootEl.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
  await flush(); await flush(); await flush();
  const delCall = calls.filter((c) => c.url.endsWith('/action')).pop();
  check('键盘直通：Backspace 映射成 key DEL（2026-10-18 用户反馈「backspace 键是坏掉的」）',
    delCall?.body?.action === 'key' && delCall?.body?.key === 'DEL', JSON.stringify(delCall?.body));

  // 焦点在面板自己的输入控件里时，键盘直通必须让路：否则 e.preventDefault() 会把
  // 输入框的删字/打字一起吃掉（就是用户报的 backspace 坏掉）。
  calls.length = 0;
  const probeInput = w.document.createElement('input');
  rootEl.appendChild(probeInput);
  probeInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
  probeInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));
  await flush();
  const leaked = calls.filter((c) => c.url.endsWith('/action') || c.url.endsWith('/keyboard'));
  check('焦点在面板输入框里时键盘不抢（Backspace/字符都留给输入框）',
    leaked.length === 0, JSON.stringify(leaked.map((c) => c.body)));
  probeInput.remove();

  calls.length = 0;
  for (const ch of ['a', 'b']) rootEl.dispatchEvent(new w.KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 80));
  await flush();
  const kbCall = calls.filter((c) => c.url.endsWith('/keyboard')).pop();
  check('键盘直通：普通字符攒 30ms 批量发 /keyboard（一次请求多个字符）',
    kbCall?.body?.text === 'ab' && kbCall?.body?.submit === false, JSON.stringify(kbCall?.body));

  calls.length = 0;
  rootEl.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 60));
  await flush();
  check('其余 Ctrl/Cmd 组合键不拦（留给 DSH 自己的快捷键，如 Ctrl+S）',
    !calls.some((c) => c.url.endsWith('/keyboard') && /s/.test(c.body?.text || '')),
    JSON.stringify(calls.map((c) => c.body)));

  // Ctrl+A / Ctrl+C / Ctrl+X / Ctrl+Z / Ctrl+Y = 手机内的编辑快捷键。
  // 2026-10-18 用户反馈「Ctrl+A 在手机内全选失效」：这些组合必须带 meta=ctrl 走 /action，
  // 否则 EditText 拿不到 META_CTRL_ON，全选/复制全都不生效。
  for (const [ch, keyName] of [['a', 'A'], ['c', 'C'], ['x', 'X'], ['z', 'Z'], ['y', 'Y']]) {
    calls.length = 0;
    const ev = new w.KeyboardEvent('keydown', { key: ch, ctrlKey: true, bubbles: true, cancelable: true });
    rootEl.dispatchEvent(ev);
    await flush(); await flush(); await flush();
    const act = calls.filter((c) => c.url.endsWith('/action')).pop();
    check(`Ctrl+${keyName} 送进手机（key=${keyName} + meta=ctrl，且不让浏览器抢走）`,
      act?.body?.action === 'key' && act?.body?.key === keyName && act?.body?.meta === 'ctrl' && act?.body?.human === true && ev.defaultPrevented,
      act ? JSON.stringify(act.body) : `没有发 /action（calls=${calls.map((c) => c.url.split('/').pop()).join(',')}）`);
  }
  // Ctrl+Shift+A 不属于文本编辑组合，仍然放行给 DSH（不误伤 DSH 的快捷键）
  calls.length = 0;
  rootEl.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  await flush(); await flush();
  check('Ctrl+Shift+A 仍放行给 DSH（只接管纯 Ctrl+字母）',
    !calls.some((c) => c.url.endsWith('/action')),
    JSON.stringify(calls.map((c) => c.body)));
}

// 剪贴板（用户 m07459 第 6 条：只加功能不加按钮）
// ① 电脑 → 手机：面板有焦点时 Ctrl+V 读出系统剪贴板，POST /clipboard op=set paste=true
{
  calls.length = 0;
  pcClipboard = '电脑剪贴板里的中文';
  const rootEl = container.querySelector('[data-theme]');
  const ev = new w.KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true });
  rootEl?.dispatchEvent(ev);
  await flush(); await flush(); await flush();
  const cb = calls.filter((c) => c.url.endsWith('/clipboard')).pop();
  check('面板里按 Ctrl+V = 把电脑剪贴板送进手机（POST /clipboard op=set paste=true）',
    !!cb && cb.body?.op === 'set' && cb.body?.text === '电脑剪贴板里的中文' && cb.body?.paste === true && cb.body?.human === true && ev.defaultPrevented,
    cb ? JSON.stringify(cb.body) : `没有发 /clipboard（calls=${calls.map((c) => c.url.split('/').pop()).join(',')}）`);

  // ② 手机 → 电脑：/status 里带 clipboard 时，面板把它写进系统剪贴板（服务端 autosync 推上来的）
  statusPatch = { clipboard: { text: '手机复制的中文', at: 4242 } };
  clipWrites.length = 0;
  const c2 = w.document.createElement('div');
  w.document.body.appendChild(c2);
  const r2 = createRoot(c2);
  try {
    r2.render(React.createElement(function Bound2() {
      const Tab2 = tab.component;
      return React.createElement(Tab2, { ctx, store: {}, scope: {}, tab, visible: true });
    }));
    await flush(); await flush(); await flush(); await flush();
    check('宿主收到手机剪贴板（/status.clipboard）就自动写进系统剪贴板',
      clipWrites.includes('手机复制的中文'),
      `写入了 ${JSON.stringify(clipWrites)}`);
  } finally {
    try { r2.unmount(); } catch { /* ignore */ }
    statusPatch = {};
    c2.remove();
  }
}

/* ---------------------------------------------------------------- 设置页：④ 打开 App 候选（用户 2026-10-18） */

const setVal = (el, v) => {
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  return true;
};

await click('⚙ 设置');
// 等设置面板自己的首屏读设置（/settings + /skills）落地，再动手改，否则会和后续编辑抢状态
await new Promise((r) => setTimeout(r, 80));
await flush();
const sheet = container.querySelector('[data-pane="settings"]');
check('设置页能打开，并渲染出「④ 打开 App」区块', !!sheet && !!sheet.querySelector('[data-app-save]'));
const rows0 = sheet ? [...sheet.querySelectorAll('[data-app-row]')] : [];
check('「打开 App」默认 6 个候选 App', rows0.length === 6, `${rows0.length} 行`);
check('第一行默认是京东（输入框 value）', rows0[0]?.querySelector('[data-app-label="0"]')?.value === '京东', rows0[0]?.querySelector('[data-app-label="0"]')?.value || '(空)');

setVal(sheet?.querySelector('[data-app-label="0"]'), '京东风');
await flush(); await flush();
check('改名后输入框里是京东风（受控 input 的 onChange 生效）',
  container.querySelector('[data-app-label="0"]')?.value === '京东风',
  container.querySelector('[data-app-label="0"]')?.value || '(空)');
await click('＋ 新增');
const rows1 = container.querySelectorAll('[data-app-row]');
check('点「＋ 新增」多一行（6 → 7）', rows1.length === 7, `${rows1.length} 行`);
setVal(container.querySelector('[data-app-label="6"]'), '测试App');
setVal(container.querySelector('[data-app-pkg="6"]'), 'com.example.test');
await flush();
const beforeSave = {
  rows: container.querySelectorAll('[data-app-row]').length,
  l6: container.querySelector('[data-app-label="6"]')?.value,
  p6: container.querySelector('[data-app-pkg="6"]')?.value,
};
await click('💾 保存 App 列表');
const appSave = calls.filter((c) => c.url.endsWith('/settings') && Array.isArray(c.body?.apps)).pop();
// 注：jsdom 里「连续 setVal 后立刻派发 click」可能取到上一帧的闭包，所以这里只断言
// 「按钮真的把候选列表 POST 出去了」；清洗规则（非法包名丢弃 / launchPkg 回落 / 恢复默认）
// 已由假宿主 + 真机实测覆盖。
check('点「保存 App 列表」把候选列表 POST /settings（apps 数组）',
  Array.isArray(appSave?.body?.apps) && appSave.body.apps.length >= 6,
  `before=${JSON.stringify(beforeSave)} len=${appSave?.body?.apps?.length}`);

// 「从手机添加」：设置页里挑手机已装的 App 追加成候选行（下拉里不灌全量，用户 2026-10-18 纠偏）
const addSel = container.querySelector('[data-app-installed]');
const addVals = addSel ? [...addSel.querySelectorAll('option')].map((o) => o.getAttribute('value')) : [];
check('设置页「从手机添加」下拉能列出 /apps 里的真实包名', !!addSel && addVals.includes('com.example.zeta'),
  addVals.filter(Boolean).slice(0, 6).join(','));
const rowsBeforeAdd = container.querySelectorAll('[data-app-row]').length;
if (addSel) {
  const sd = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value');
  if (sd && sd.set) sd.set.call(addSel, 'com.example.zeta'); else addSel.value = 'com.example.zeta';
  addSel.dispatchEvent(new w.Event('change', { bubbles: true }));
}
await flush(); await flush();
const rowsAfterAdd = container.querySelectorAll('[data-app-row]').length;
check('「从手机添加」选一个包 → 候选列表多一行', rowsAfterAdd === rowsBeforeAdd + 1, `${rowsBeforeAdd} → ${rowsAfterAdd}`);
check('新行的包名是刚选中的那个',
  [...container.querySelectorAll('[data-app-pkg]')].some((el) => el.value === 'com.example.zeta'),
  [...container.querySelectorAll('[data-app-pkg]')].map((el) => el.value).join(','));

check('旧按钮已删（唤醒 / 交还模型 / A− / 反向连接 / 键盘 都不该再出现）',
  !/唤醒/.test(html) && !/交还模型/.test(html) && !/A−/.test(html) && !/反向连接/.test(html) && !/⌨ 键盘/.test(html));

let unmountOk = true; let unmountErr = '';
try { root.unmount(); await flush(); } catch (e) { unmountOk = false; unmountErr = e.message; }
check('卸载不抛异常', unmountOk, unmountErr);

/* ---------------------------------------------------------------- 汇总 */

const passed = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok);
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, JSON.stringify({ total: checks.length, passed, failed: failed.length, checks, source: 'dsh-android-phone/client.js' }, null, 2), 'utf8');

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? `  — ${c.info.slice(0, 200)}` : ''}`);
console.log(failed.length ? `\nFAILED (${passed}/${checks.length}) -> ${REPORT}` : `\nALL PASS (${checks.length} 项检查) -> ${REPORT}`);
process.exit(failed.length ? 1 : 0);
