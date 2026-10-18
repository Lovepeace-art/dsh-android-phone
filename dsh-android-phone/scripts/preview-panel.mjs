/**
 * 侧栏 UI 预览（用于「看不清」这类只能靠眼睛判断的问题）——不需要 DSH、不需要真机。
 *
 * 做法：用 jsdom + 真 React 真挂载 `client.js` 的面板，等首帧 effect 跑完，把渲染出的
 * DOM（全是 inline style）序列化成两个纯 HTML（浅色/深色主题各一份），
 * 再可选调用本机 Chrome `--headless=new --screenshot` 出 PNG。
 *
 *   node scripts/preview-panel.mjs                # 生成 HTML（+ 有 Chrome 就出 PNG）
 *   node scripts/preview-panel.mjs --no-shot      # 只出 HTML
 *
 * 产物在 `recon/ui-preview/`：panel-light.html / panel-dark.html / panel-*.png
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const OUT = join(REPO, 'recon', 'ui-preview');
const SHOT = !process.argv.includes('--no-shot');

const MODULES = process.env.CLIENT_TEST_MODULES || join(REPO, '.client-test', 'node_modules');
const requireFrom = createRequire(join(MODULES, 'noop.js'));
const React = requireFrom('react');
const { createRoot } = requireFrom('react-dom/client');
const { JSDOM } = requireFrom('jsdom');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe'),
].find((p) => p && existsSync(p));

const SRC = readFileSync(join(ROOT, 'client.js'), 'utf8');

/** 三种状态 × 两种面板宽度，够看出「挤不挤 / 看不看得清 / 空白有没有交代」。 */
const CASES = [
  { id: 'no-device', width: 420, status: { ok: true, ready: false, devices: [], device: {}, screen: {}, foreground: {}, video: { running: false } } },
  {
    id: 'ready-idle', width: 420,
    status: {
      ok: true, ready: true, adbPath: 'C:\\...\\vendor\\platform-tools\\adb.exe', adbVersion: '1.0.41',
      devices: [{ serial: 'ADF0220515005425', state: 'device', model: 'WLZ-AN00' }],
      device: { serial: 'ADF0220515005425', model: 'WLZ-AN00', brand: 'HUAWEI', android: '12', sdk: '31' },
      screen: { width: 1080, height: 2400, density: 480 },
      foreground: { package: 'com.jingdong.app.mall', activity: '.MainFrameActivity' },
      video: { running: false, width: 0, height: 0 },
      owner: 'ai', session: { running: false, subscribers: 0 },
    },
  },
  {
    id: 'streaming', width: 700,
    status: {
      ok: true, ready: true, adbPath: 'C:\\...\\vendor\\platform-tools\\adb.exe', adbVersion: '1.0.41',
      devices: [{ serial: 'ADF0220515005425', state: 'device', model: 'WLZ-AN00' }],
      device: { serial: 'ADF0220515005425', model: 'WLZ-AN00', brand: 'HUAWEI', android: '12', sdk: '31' },
      screen: { width: 1080, height: 2400, density: 480 },
      foreground: { package: 'com.jingdong.app.mall', activity: '.MainFrameActivity' },
      video: { running: true, width: 808, height: 1800, tunnel: 'reverse', maxSize: 1024, stats: { packets: 1234, kbps: 3200 } },
      owner: 'human', session: { running: true, subscribers: 1, restarts: 0 },
    },
  },
  {
    id: 'settings', width: 420, click: '[data-settings]',
    status: {
      ok: true, ready: true, adbPath: 'C:\\...\\vendor\\platform-tools\\adb.exe', adbVersion: '1.0.41',
      devices: [{ serial: 'ADF0220515005425', state: 'device', model: 'WLZ-AN00' }],
      device: { serial: 'ADF0220515005425', model: 'WLZ-AN00', brand: 'HUAWEI', android: '12', sdk: '31' },
      screen: { width: 1080, height: 2400, density: 480 },
      foreground: { package: 'com.jingdong.app.mall', activity: '.MainFrameActivity' },
      video: { running: true, width: 808, height: 1800, tunnel: 'reverse', maxSize: 1024, stats: { packets: 1234, kbps: 3200 } },
      owner: 'ai', session: { running: true, subscribers: 1, restarts: 0 },
    },
  },
];

function makeFetchStub(status) {
  const json = (obj, code = 200) => ({
    ok: code < 400, status: code, headers: { get: () => null },
    json: async () => obj, text: async () => JSON.stringify(obj), blob: async () => ({ size: 1 }),
  });
  return async (url, opts) => {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}') || {}; } catch { body = {}; }
    if (u.includes('/settings')) {
      if (body.action === 'get') return json({ ok: true, settings: { shotsDir: '', cleanup: '7' }, dir: 'C:\\Users\\Administrator\\.dsh\\android-phone\\shots', choices: ['off', '1', '3', '7', '30'] });
      if (body.action === 'cleanup') return json({ ok: true, removed: 3, kept: 233, dir: 'C:\\Users\\Administrator\\.dsh\\android-phone\\shots', days: 7 });
      return json({ ok: true, settings: { shotsDir: body.shotsDir || '', cleanup: body.cleanup || '7' }, dir: 'C:\\Users\\Administrator\\.dsh\\android-phone\\shots' });
    }
    if (u.includes('/skills')) return json({ ok: true, dir: 'C:\\...\\dsh-android-phone\\skills', skills: [{ id: 'jd-mall-capture', name: 'jd-mall-capture', description: '用安卓真机打开京东 App，搜索关键字 → 切「店铺」tab → 进目标店铺 → 把店铺首页长截图成一张整页图。', dir: 'C:\\...\\skills\\jd-mall-capture' }] });
    if (u.includes('/status')) return json(status);
    if (u.includes('/owner')) return json({ ok: true, owner: status.owner || 'ai' });
    if (u.includes('/takeover')) return json({ ok: true, owner: 'human' });
    if (u.includes('/video')) return json({ error: '预览模式：不接视频流' }, 503);
    if (u.includes('/snapshot')) return json({ ok: true });
    return json({ ok: true });
  };
}

async function renderCase(c) {
  // url 必须给：不给的话是 opaque origin，jsdom 的 localStorage 会抛 SecurityError
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/preview' });
  const w = dom.window;
  global.window = w;
  global.document = w.document;
  global.self = w;
  try { Object.defineProperty(global, 'navigator', { value: w.navigator, configurable: true }); } catch { /* ignore */ }
  global.HTMLElement = w.HTMLElement;
  global.Element = w.Element;
  global.Node = w.Node;
  global.Event = w.Event;
  global.MouseEvent = w.MouseEvent;
  global.requestAnimationFrame = (cb) => w.setTimeout(() => cb(Date.now()), 16);
  global.cancelAnimationFrame = (id) => w.clearTimeout(id);
  w.requestAnimationFrame = global.requestAnimationFrame;
  w.cancelAnimationFrame = global.cancelAnimationFrame;
  // ResizeObserver：jsdom 没有，用假实现把「面板宽度」喂进去（这正是自动字号依赖的输入）
  w.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { this.cb([{ target: el, contentRect: { width: c.width, height: 900 } }]); }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
  };
  w.localStorage.clear?.();
  w.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: c.width, height: 900, right: c.width, bottom: 900, x: 0, y: 0 });
  w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, clearRect() {}, fillRect() {}, imageSmoothingEnabled: false });
  w.createImageBitmap = async () => ({ width: 4, height: 8, close() {} });

  const fetchStub = makeFetchStub(c.status);
  global.fetch = fetchStub; w.fetch = fetchStub;

  // 载入 client.js，拿 tab 组件
  let def = null;
  w.__ModuleLoader__ = { load: (d) => { def = d; } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', 'performance', 'setTimeout', 'console', SRC)(w, w.document, w.navigator, w.performance, w.setTimeout, console);
  const exported = def.factory((n) => { if (n === 'react') return React; throw new Error(`不该 require ${n}`); });
  let tab = null;
  const ctx = {
    betterSidebar: { hostRouteUrl: (p) => `/dsh-android-phone/${p}`.replace('/api/api', '/api'), registerTab: (t) => { tab = t; return () => {}; } },
    effect: (fn) => fn(),
    get: () => undefined,
  };
  exported.apply(ctx);

  const container = w.document.getElementById('root');
  container.style.width = `${c.width}px`;
  container.style.height = '900px';
  container.style.overflow = 'hidden';
  // 模拟宿主主题：themePalette() 是从**宿主容器的实际文字色**推调色板的，
  // 所以这里必须先把宿主的颜色放进 jsdom，否则两套主题会拿到同一个兜底色（预览就不忠实了）。
  // 注意：jsdom 的 getComputedStyle **不解析 <style> 样式表**，所以只能写成内联样式（等价于宿主给容器上的色）。
  const light = c.theme !== 'dark';
  const hostFg = light ? '#1f1f1f' : '#d4d4d4';
  container.style.color = hostFg;
  // 还要把 getComputedStyle 挂到全局：client.js 里是无前缀调用，在 new Function 沙箱里
  // 会去全局对象找，Node 的 globalThis 上本来没有（真浏览器里有）。
  // jsdom 只对「自己身上有内联色」的元素给得出 color，样式表里继承来的颜色它算不出来
  // ⇒ 这里统一回落到模拟的宿主文字色，保证整套预览都是按目标主题取色的。
  // 注意：必须先抓住 jsdom 原始实现再覆盖，否则 w.getComputedStyle = 我们这个函数会自递归爆栈
  // （2026-10-17 踩过：报 Maximum call stack size exceeded，被 themePalette 的 try 吞掉后静默退回兜底色）。
  const origGCS = w.getComputedStyle.bind(w);
  global.getComputedStyle = (el) => {
    let computed = '';
    try { computed = origGCS(el).color || ''; } catch { /* ignore */ }
    return { color: (el && el.style && el.style.color) || computed || hostFg };
  };
  w.getComputedStyle = global.getComputedStyle;
  const root = createRoot(container);
  root.render(React.createElement(tab.component, { ctx }));
  await new Promise((r) => setTimeout(r, 120));
  // 需要进入某个子页（例如 ⚙ 设置）就点一下再等一拍，让 React 把新状态画出来
  if (c.click) {
    const el = container.querySelector(c.click);
    if (el) {
      el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 220));
    } else { console.log('  (没找到 ' + c.click + ')'); }
  }
  const html = container.innerHTML;
  root.unmount();
  return html;
}

function page(bodyHtml, theme, width) {
  const light = theme === 'light';
  return `<!doctype html><html><head><meta charset="utf-8"><title>android-phone panel (${theme})</title>
<style>
  :root { --vscode-foreground: ${light ? '#1f1f1f' : '#d4d4d4'}; }
  html,body { margin:0; padding:0; background:${light ? '#ffffff' : '#1e1e1e'}; }
  body { color:${light ? '#1f1f1f' : '#d4d4d4'}; font-family:"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif; }
  .frame { width:${width}px; height:900px; overflow:hidden; }
</style></head>
<body><div class="frame">${bodyHtml}</div></body></html>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const made = [];
  const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
  for (const c of CASES) {
    if (ONLY && c.id !== ONLY) continue;
    for (const theme of ['light', 'dark']) {
      const body = await renderCase({ ...c, theme });
      const file = join(OUT, `${c.id}-${theme}.html`);
      writeFileSync(file, page(body, theme, c.width), 'utf8');
      made.push({ case: c.id, width: c.width, theme, html: file });
      if (SHOT && CHROME) {
        const png = join(OUT, `${c.id}-${theme}.png`);
        execFileSync(CHROME, [
          '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
          `--window-size=${c.width},900`, `--screenshot=${png}`, `file:///${file.replace(/\\/g, '/')}`,
        ], { stdio: 'ignore', timeout: 60000 });
        made[made.length - 1].png = png;
      }
    }
    console.log(`[ok] ${c.id} (宽 ${c.width}px)`);
  }
  const report = join(OUT, 'preview-report.json');
  writeFileSync(report, JSON.stringify({ ranAt: new Date().toISOString(), chrome: CHROME || null, files: made }, null, 2));
  console.log(`\n产物：${OUT}`);
  if (!CHROME) console.log('（没找到 Chrome，只出了 HTML）');
}

main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
