/**
 * 宿主半边（index.js）离线自测 —— 用假 cordis ctx 把插件装起来，把 prefix 路由挂到真 http server，
 * 然后按 client.js 的调用流程逐个打接口，并校验工具的定义、返回值、图片附件。
 *
 * 需要：真机连着（adb 可用）+ 放宽权限（沙箱里 node spawn 带管道会 EPERM）。
 *
 * 用法：
 *   node scripts/test-host.mjs                # 全流程（会真开视频流 + 真截屏，约 40~60s）
 *   node scripts/test-host.mjs --no-video     # 跳过视频流
 *   node scripts/test-host.mjs --long         # 额外跑一次真机长截图（会滚动手机，注意）
 *   node scripts/test-host.mjs --no-device    # 只验装配（没有手机时用）
 *
 * 报告：recon/reports/android-host-report.json
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const REPORT = join(REPO, 'recon', 'reports', 'android-host-report.json');

const argv = process.argv.slice(2);
const NO_VIDEO = argv.includes('--no-video');
const DO_LONG = argv.includes('--long');
const NO_DEVICE = argv.includes('--no-device');
const PROFILE = 'default';

const checks = [];
function check(name, ok, info = '') { checks.push({ name, ok: !!ok, info: String(info ?? '').slice(0, 400) }); }

/* ---------------------------------------------------------------- 假 cordis ctx */

const registered = { tools: [], routes: [], effects: 0, injects: [] };
const attachments = { saved: [] };

const hostCtx = {
  get(name) {
    if (name === 'tools') {
      return {
        register(def) {
          registered.tools.push(def);
          return () => { registered.tools = registered.tools.filter((d) => d !== def); };
        },
      };
    }
    if (name === 'attachments') {
      return {
        async saveImage({ data, mediaType, name }) {
          const id = `att-${attachments.saved.length + 1}`;
          attachments.saved.push({ attachmentId: id, mediaType, name, bytes: data?.length ?? 0 });
          return { attachmentId: id, mediaType, name, bytes: data?.length ?? 0 };
        },
      };
    }
    return undefined;
  },
  effect(fn) { registered.effects += 1; return fn(); },
  logger: { info() {}, warn() {}, error() {} },
};

const webServer = {
  register({ kind, path, handler }) {
    registered.routes.push({ kind, path, handler });
    return () => {};
  },
};

const ctx = {
  get: hostCtx.get,
  get logger() { return hostCtx.logger; },
  effect: hostCtx.effect,
  inject(names, cb) {
    registered.injects.push(names);
    const scoped = {
      get: (n) => (n === 'webServer' ? webServer : hostCtx.get(n)),
      webServer,
      effect: hostCtx.effect,
    };
    return cb(scoped);
  },
};

/* ---------------------------------------------------------------- 无损 JSON 复刻校验（同 DSH walkJsonValue） */

function isLosslessJson(value) {
  return describeLossless(value, '$', new Set()) === null;
}
function describeLossless(value, trail, seen) {
  const t = typeof value;
  if (value === null || t === 'string' || t === 'boolean') return null;
  if (t === 'number') return (Number.isFinite(value) && !Object.is(value, -0)) ? null : `${trail} 数字非法(${value})`;
  if (t !== 'object') return `${trail} 类型 ${t} 不合法`;
  if (Buffer.isBuffer(value)) return `${trail} 是 Buffer`;
  if (seen.has(value)) return `${trail} 有环`;
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) return `${trail} 数组原型异常`;
    for (let i = 0; i < value.length; i++) {
      const bad = describeLossless(value[i], `${trail}[${i}]`, seen);
      if (bad) return bad;
    }
    return null;
  }
  if (proto !== Object.prototype && proto !== null) return `${trail} 对象原型异常(${proto?.constructor?.name})`;
  for (const [k, v] of Object.entries(value)) {
    const bad = describeLossless(v, `${trail}.${k}`, seen);
    if (bad) return bad;
  }
  return null;
}

/* ---------------------------------------------------------------- 装插件 + 起服务 */

const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href);
check('index.js 导出 name = dsh-android-phone', mod.name === 'dsh-android-phone', mod.name);
check('index.js 导出 apply 函数', typeof mod.apply === 'function');

let applyErr = '';
try {
  mod.apply(ctx, { adbPath: process.env.DSH_ADB || '', defaultSerial: '', video: { maxSize: 480, maxFps: 30 } });
} catch (e) { applyErr = e.stack || e.message; }
check('apply() 不抛异常', !applyErr, applyErr.split('\n').slice(0, 3).join(' | '));
check('注册了 phone_* 工具（12 个，含 phone_clipboard / phone_takeover）', registered.tools.length === 12
  && registered.tools.every((t) => /^phone_/.test(t.name))
  && registered.tools.some((t) => t.name === 'phone_takeover'),
  registered.tools.map((t) => t.name).join(', '));
check('注册了 1 条 webServer 路由', registered.routes.length === 1 && registered.routes[0].path === '/dsh-android-phone/api',
  JSON.stringify(registered.routes.map((r) => `${r.kind}:${r.path}`)));
check('每个工具都有 parameters/output/execute', registered.tools.every((t) => t.parameters && t.output && typeof t.execute === 'function'),
  registered.tools.map((t) => t.name).join(','));

const toolMap = Object.fromEntries(registered.tools.map((t) => [t.name, t]));
const callTool = async (name, args = {}) => {
  const t = toolMap[name];
  if (!t) throw new Error(`没有工具 ${name}`);
  const value = await t.execute(args);
  return { value, lossless: describeLossless(value, '$.value', new Set()) };
};

/* 把 prefix 路由挂到真 http server */
const CANS = { lastHeaders: null, lastBody: null };
const server = createServer((req, res) => {
  const r = registered.routes[0];
  if (!r) { res.writeHead(500); res.end('no route'); return; }
  r.handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/dsh-android-phone/api`;

async function getJson(url, init) {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}
const post = (p, body) => getJson(`${BASE}${p}`, { method: 'POST', body: JSON.stringify(body || {}) });

/* ---------------------------------------------------------------- 接口测试 */

const st = await getJson(`${BASE}/status`);
check('GET /status 返回 200 且 ok', st.status === 200 && st.json?.ok === true, JSON.stringify(st.json).slice(0, 300));
check('GET /status 给出 adb 路径与版本', !!st.json?.adbPath && !!st.json?.adbVersion, `${st.json?.adbPath} / ${st.json?.adbVersion}`);
check('GET /status 返回播放器视频流状态字段', st.json?.video && typeof st.json.video.running === 'boolean', JSON.stringify(st.json?.video).slice(0, 200));
check('GET /status 列出声明式动作表（jd）', Array.isArray(st.json?.actions) && st.json.actions.some((a) => a.map === 'jd' && a.count > 5),
  JSON.stringify(st.json?.actions || []).slice(0, 200));


const toolStatus = await callTool('phone_status');check('工具 phone_status 返回值是无损 JSON', toolStatus.lossless === null, toolStatus.lossless || '');
check('工具 phone_status 认到设备', NO_DEVICE ? true : !!toolStatus.value?.serial, `${toolStatus.value?.serial} / ${toolStatus.value?.device?.model}`);

if (!NO_DEVICE) {
  const shot = await callTool('phone_screenshot', { name: 'hosttest', outDir: join(REPO, 'recon', 'android-shots') });
  check('工具 phone_screenshot 落盘成功', shot.value?.ok === true && shot.value?.width > 0, `${shot.value?.width}x${shot.value?.height} ${shot.value?.bytes}B`);
  check('工具 phone_screenshot 返回值是无损 JSON', shot.lossless === null, shot.lossless || '');
  check('截图 render 返回 image 附件（模型能看图）', shot.value?.image?.attachmentId && String(shot.value.image.mediaType).startsWith('image/'), JSON.stringify(shot.value?.image || {}).slice(0, 200));
  check('attachments.saveImage 真被调用', attachments.saved.length >= 1, JSON.stringify(attachments.saved.slice(-1)));

  const insp = await callTool('phone_inspect', { max: 20 });
  check('工具 phone_inspect 返回带坐标节点', inspectOk(insp.value), `${insp.value?.count} 个节点`);
  check('工具 phone_inspect 返回值是无损 JSON', insp.lossless === null, insp.lossless || '');

  const act = await callTool('phone_action', { action: 'tap', nx: 0.5, ny: 0.5 });
  check('工具 phone_action 执行 tap 成功', act.value?.ok === true && act.value?.step?.type === 'tap', JSON.stringify(act.value).slice(0, 200));
  check('工具 phone_action 回报屏幕尺寸（相对坐标可换算）', act.value?.screen?.width > 0, JSON.stringify(act.value?.screen));

  const open = await post('/open', { package: 'com.jingdong.app.mall', waitMs: 6000 });
  check('POST /open 打开京东（或已在前台）', open.json?.ok === true, JSON.stringify(open.json).slice(0, 200));

  const snap = await fetch(`${BASE}/snapshot?scale=0.5`);
  const buf = Buffer.from(await snap.arrayBuffer());
  const isPng = buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG';
  check('GET /snapshot 返回 PNG', snap.status === 200 && isPng, `${buf.length}B ${snap.headers.get('content-type')}`);
  check('GET /snapshot 的 scale 生效（宽度约一半）', Number(snap.headers.get('X-Image-Width')) > 300 && Number(snap.headers.get('X-Image-Width')) < 700,
    `${snap.headers.get('X-Image-Width')}x${snap.headers.get('X-Image-Height')}`);

  const shotApi = await post('/shot', { mode: 'screen', name: 'hosttest-api' });
  check('POST /shot mode=screen 落盘并回报宽高', shotApi.json?.ok === true && shotApi.json?.width > 0, JSON.stringify(shotApi.json).slice(0, 240));
  check('POST /shot 不把 image 附件塞进 JSON', shotApi.json?.image === undefined, String(shotApi.json?.image));

  const actApi = await post('/action', { action: 'scroll', dir: 'up', pages: 0.2 });
  check('POST /action scroll 成功', actApi.json?.ok === true, JSON.stringify(actApi.json).slice(0, 200));

  const presets = await callTool('phone_preset');
  check('工具 phone_preset 能列出动作表（jd ≥ 10 个动作）', presets.value?.count >= 10 && presets.value?.actions?.length >= 10,
    `map=${presets.value?.map} count=${presets.value?.count} 前几个=${(presets.value?.actions || []).slice(0, 4).map((a) => a.name).join(',')}`);
  check('工具 phone_preset 返回值是无损 JSON', presets.lossless === null, presets.lossless || '');

  const runPreset = await callTool('phone_preset', { names: ['wait-1s'] });
  check('工具 phone_preset 跑命名动作（wait-1s）成功', runPreset.value?.ok === true && Array.isArray(runPreset.value?.steps) && runPreset.value.steps.length === 1,
    JSON.stringify(runPreset.value?.steps || []).slice(0, 200));

  const presetApi = await post('/action', { preset: 'wait-1s' });
  check('POST /action {preset} 走动作表', presetApi.json?.ok === true && presetApi.json?.map === 'jd', JSON.stringify(presetApi.json).slice(0, 200));

  if (DO_LONG) {
    const t0 = Date.now();
    const long = await post('/shot', { mode: 'long', name: 'hosttest-long', maxSteps: 4 });
    check('POST /shot mode=long 拼出长图', long.json?.ok === true && long.json?.height > long.json?.width, `${long.json?.width}x${long.json?.height} ${long.json?.mode} ${Date.now() - t0}ms`);
    check('长图自检有结果', !!long.json?.quality, JSON.stringify(long.json?.quality || {}).slice(0, 200));
  }
}

/* 视频流：读一段二进制，校验我们自己的分帧头 + H.264 起始码 */
if (!NO_VIDEO && !NO_DEVICE) {
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const res = await fetch(`${BASE}/video?maxSize=480&maxFps=30`, { signal: ac.signal });
    check('GET /video 返回 200 与自定义 content-type', res.status === 200 && /octet-stream/.test(res.headers.get('content-type') || ''),
      `${res.headers.get('content-type')} ${res.headers.get('x-video-width')}x${res.headers.get('x-video-height')}`);
    const reader = res.body.getReader();
    let buf = Buffer.alloc(0);
    const sizes = []; const flags = []; let keyFrame = false; let startCodes = 0;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && sizes.length < 12) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      while (buf.length >= 13) {
        const size = buf.readUInt32BE(0);
        if (size === 0 || buf.length < 13 + size) break;
        const flag = buf.readUInt8(4);
        const payload = buf.subarray(13, 13 + size);
        sizes.push(size); flags.push(flag);
        if (flag & 1) { /* config 包 */ }
        if (flag & 2) keyFrame = true;
        if (payload.length > 8 && payload.readUInt32BE(0) === 1) startCodes += 1;
        buf = buf.subarray(13 + size);
      }
      if (sizes.length >= 6) break;
    }
    ac.abort();
    check('视频流能解析出 ≥5 个分帧包', sizes.length >= 5, `sizes=${sizes.slice(0, 8).join(',')} flags=${flags.slice(0, 8).join(',')} ${Date.now() - t0}ms`);
    check('有配置包（SPS/PPS，解码器要靠它）', flags.some((f) => f & 1), flags.join(','));
    check('有关键帧', keyFrame, flags.join(','));
    check('载荷是 Annex-B 的 H.264（00 00 00 01 起始码）', startCodes > 0, `startCodes=${startCodes}`);
    const stopRes = await post('/stream', { op: 'stop' });
    check('POST /stream op=stop 停流成功', stopRes.json?.ok === true, JSON.stringify(stopRes.json).slice(0, 160));
  } catch (e) {
    check('视频流读取', false, e.message);
  }
}

/* ---------------------------------------------------------------- 汇总 */

server.close();
const passed = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok);
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, JSON.stringify({ total: checks.length, passed, failed: failed.length, checks }, null, 2), 'utf8');

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? `  — ${c.info}` : ''}`);
console.log(failed.length ? `\nFAILED (${passed}/${checks.length}) -> ${REPORT}` : `\nALL PASS (${checks.length} 项检查) -> ${REPORT}`);
process.exit(failed.length ? 1 : 0);

function inspectOk(v) {
  const nodes = v?.nodes || [];
  return nodes.length > 0 && nodes.some((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
}
