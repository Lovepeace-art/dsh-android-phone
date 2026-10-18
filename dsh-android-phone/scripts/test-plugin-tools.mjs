/**
 * 0.3 阶段的离线自测（不需要真机动作，只在设备上做只读查询）：
 *
 *   1. control.js 的编码器字节数与 scrcpy v5.0.1 的 ControlMessageReader 是否逐字段对齐；
 *   2. index.js 的 apply() 用假 ctx 起得来：注册了多少工具、路由前缀是不是 /dsh-android-phone/api；
 *   3. **控制权模型**：人接管（/takeover）之后，模型的写操作必须被拒（守门人），只读操作不受影响；
 *      交还（/owner {owner:'ai'}）之后写操作放行。
 *
 * 跑法：node scripts/test-plugin-tools.mjs
 * 输出：PROBE-P1-tools.json（报告）+ 控制台摘要；退出码 0 = 全绿。
 */
import { Readable } from 'node:stream';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const out = { ranAt: new Date().toISOString(), steps: [] };
const step = (name, ok, detail) => {
  out.steps.push({ name, ok: !!ok, detail });
  const flag = ok ? 'PASS' : 'FAIL';
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${flag}  ${name}  ${d}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 假 ctx / 假 HTTP */

function mkReq(url, method = 'GET', body) {
  const r = new Readable({ read() {} });
  r.url = url;
  r.method = method;
  if (body !== undefined) r.push(Buffer.from(JSON.stringify(body), 'utf8'));
  r.push(null);
  return r;
}

function mkRes() {
  const chunks = [];
  return {
    statusCode: 0, headers: null, ended: false, chunks,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write(b) { if (b) { chunks.push(Buffer.from(b)); } return true; },
    end(b) { if (b) { chunks.push(Buffer.from(b)); } this.ended = true; },
    json() { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } },
  };
}

function makeCtx() {
  const registered = { tools: [], routes: [] };
  const webServer = {
    register(opts) {
      registered.routes.push(opts);
      return () => { registered.routes = registered.routes.filter((r) => r !== opts); };
    },
  };
  const tools = {
    register(def) { registered.tools.push(def); return () => {}; },
  };
  const services = { tools, webServer, attachments: undefined };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => {
      if (name in services) return services[name];
      throw new Error(`没有服务 ${name}`);
    },
    inject: (deps, fn) => {
      const scoped = { get: (n) => ctx.get(n), effect: ctx.effect };
      fn(scoped);
    },
    effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {}; },
  };
  return { ctx, registered };
}

async function main() {
  /* ------------------------------------------------------ 1. 控制消息编码器 */
  const ctl = await import('../src/android/control.js');
  const { MSG, ACTION, POINTER, KEYCODES, splitUtf8, encInjectKeycode, encInjectText, encInjectTouch, encInjectScroll, encStartApp, encEmpty } = ctl;
  const enc = { encInjectKeycode, encInjectText, encInjectTouch, encInjectScroll, encStartApp, encEmpty };
  step('control.js 导出了编码器', Object.values(enc).every((f) => typeof f === 'function'), Object.keys(enc).join(', '));

  // 长度按 ControlMessageReader.java 逐字段算（见 PLAN.md §3）：
  //   KEYCODE = 1+1+4+4+4 = 14 · TOUCH = 1+1+8+12+2+4+4 = 32 · SCROLL = 1+12+2+2+4 = 21
  const len = (buf) => (buf && buf.length) || 0;
  {
    const kc = encInjectKeycode({ action: ACTION.DOWN, keycode: 3 });
    step('INJECT_KEYCODE = 14 字节', len(kc) === 14, `${len(kc)} 字节`);
    const touch = encInjectTouch({ action: ACTION.DOWN, pointerId: POINTER.FINGER, x: 540, y: 1200, screenWidth: 1080, screenHeight: 2400, pressure: 1 });
    step('INJECT_TOUCH_EVENT = 32 字节', len(touch) === 32, `${len(touch)} 字节`);
    step('  touch 里的 Position = 12 字节', touch.readInt32BE(10) === 540 && touch.readInt32BE(14) === 1200 && touch.readUInt16BE(18) === 1080 && touch.readUInt16BE(20) === 2400,
      `x=${touch.readInt32BE(10)} y=${touch.readInt32BE(14)} w=${touch.readUInt16BE(18)} h=${touch.readUInt16BE(20)}`);
    step('  pointerId=-2 按 i64 写入', touch.readBigInt64BE(2) === -2n, `${touch.readBigInt64BE(2)}`);
    step('  pressure=1.0 夹到 65535（u16 定点）', touch.readUInt16BE(22) === 65535, `${touch.readUInt16BE(22)}`);
    const scroll = encInjectScroll({ x: 540, y: 1200, screenWidth: 1080, screenHeight: 2400, vScroll: 1, hScroll: 0 });
    step('INJECT_SCROLL_EVENT = 21 字节', len(scroll) === 21, `${len(scroll)} 字节`);
    step('  scroll 定点满量程 ±16（vScroll=1 → 2048）', scroll.readInt16BE(15) === 2048, `vScroll=${scroll.readInt16BE(15)} / hScroll=${scroll.readInt16BE(13)}`);
    const text = encInjectText('牛奶');
    step('INJECT_TEXT = 5 + UTF-8 字节', len(text) === 5 + Buffer.byteLength('牛奶', 'utf8'), `${len(text)} 字节 / 中文 ${Buffer.byteLength('牛奶', 'utf8')} 字节`);
    step('START_APP = 2 + UTF-8 字节', len(encStartApp('com.jingdong.app.mall')) === 2 + 'com.jingdong.app.mall'.length, '');
    step('空消息只有 1 字节', len(encEmpty(MSG.ROTATE_DEVICE)) === 1, '');
  }

  // 中文按 UTF-8 边界切段，绝不劈成半个字
  const long = '店铺名'.repeat(400);
  const chunks = splitUtf8(long, 300);
  step('splitUtf8 每段 ≤300 字节', chunks.every((c) => Buffer.byteLength(c, 'utf8') <= 300), `段数=${chunks.length} 最大=${Math.max(...chunks.map((c) => Buffer.byteLength(c, 'utf8')))}`);
  step('splitUtf8 拼回原文（没劈中文）', chunks.join('') === long, '');
  step('KEYCODES 是小写名（home/back/enter/appswitch）', !!KEYCODES.home && !!KEYCODES.back && !!KEYCODES.enter && !!KEYCODES.appswitch, Object.keys(KEYCODES).slice(0, 6).join(','));

  /* ------------------------------------------------------ 2. apply() 装起来 */
  const { default: plugin } = await import('../index.js');
  const { ctx, registered } = makeCtx();
  const api = plugin.apply(ctx, {});
  await sleep(50);

  const names = registered.tools.map((t) => t.name);
  step('工具数量 = 12（原 10 + phone_clipboard + phone_takeover）', names.length === 12, `${names.length} 个: ${names.join(',')}`);
  step('phone_takeover 已注册', names.includes('phone_takeover'), '');
  step('路由前缀 = /dsh-android-phone/api', registered.routes.some((r) => r.path === '/dsh-android-phone/api' && r.kind === 'prefix'), JSON.stringify(registered.routes.map((r) => r.path)));

  const handler = registered.routes.find((r) => r.kind === 'prefix')?.handler;
  // 注意：注册进去的 handler 是 `(req,res) => { handleRoute().catch() }`，**不返回 promise**，
  // 所以不能 await 它 —— 得等 res.ended（假 res 上由 end() 置位）。
  const callRoute = async (path, method = 'GET', body, timeoutMs = 20_000) => {
    const res = mkRes();
    await handler(mkReq(`/dsh-android-phone/api${path}`, method, body), res);
    const t0 = Date.now();
    while (!res.ended && Date.now() - t0 < timeoutMs) await sleep(20);
    if (!res.ended) res.timeout = true;
    return res;
  };

  /* ------------------------------------------------------ 3. 控制权模型 */
  const session = await import('../src/android/session.js');

  const rOwner0 = await callRoute('/owner');
  step('GET /owner 返回 owner=ai（默认模型持有）', rOwner0.json()?.owner === 'ai', JSON.stringify(rOwner0.json()));

  const rTake = await callRoute('/takeover', 'POST', { reason: '自测' });
  step('POST /takeover → owner=human', rTake.json()?.owner === 'human', JSON.stringify(rTake.json()));

  const rBlocked = await callRoute('/action', 'POST', { action: 'tap', nx: 0.5, ny: 0.5 });
  const blockedMsg = String(rBlocked.json()?.error || '');
  step('人接管时：模型写操作被拒（守门人）', rBlocked.statusCode === 500 && /人工接管/.test(blockedMsg), `HTTP ${rBlocked.statusCode} ${blockedMsg}`);
  step('  拒绝码是 OWNER_HUMAN', /手机控制权已被人工接管/.test(blockedMsg), '');

  // 只读不受影响：模型仍能看（status 不碰控制权）
  const rStatus = await callRoute('/status');
  const st = rStatus.json();
  step('人接管时：只读 phone_status 仍可用', rStatus.statusCode === 200 && st?.ok === true, `HTTP ${rStatus.statusCode} ready=${st?.ready} owner=${st?.owner}`);
  step('  status 里有 owner/session/control 字段', st?.owner === 'human' && !!st?.session && st?.control !== undefined,
    `owner=${st?.owner} control=${st?.control} session.running=${st?.session?.running} tunnel=${st?.session?.tunnel}`);
  step('  status.video 用量来自会话（不是旧 state）', !!st?.video && st.video.maxSize !== undefined && st.video.clients !== undefined,
    JSON.stringify({ running: st?.video?.running, maxSize: st?.video?.maxSize, clients: st?.video?.clients }));

  // 人静默租约：接管时能设 idleMs，ownerInfo 里带 humanHoldMs
  const rOwner2 = await callRoute('/owner', 'POST', { owner: 'human', idleMs: 1234 });
  step('POST /owner 可设置人工租约（idleMs）', rOwner2.json()?.humanHoldMs === 1234, JSON.stringify(rOwner2.json()));
  step('session.setOwner 校验非法值', (() => { try { session.setOwner('robot'); return false; } catch { return true; } })(), '');

  const rBack = await callRoute('/owner', 'POST', { owner: 'ai', reason: '自测交还' });
  step('交还后 owner=ai', rBack.json()?.owner === 'ai', JSON.stringify(rBack.json()));
  const rAllowed = await callRoute('/action', 'POST', { action: 'wait', ms: 1 });
  step('交还后：模型写操作放行（不再报人工接管）', !/人工接管/.test(String(rAllowed.json()?.error || '')), `HTTP ${rAllowed.statusCode} ${JSON.stringify(rAllowed.json()).slice(0, 120)}`);

  // 会话信息与退出兜底
  step('sessionInfo 字段齐全（含 deviceName/maxSize/stats）', (() => {
    const i = session.sessionInfo();
    return ['running', 'owner', 'tunnel', 'control', 'subscribers', 'restarts', 'deviceName', 'maxSize', 'bitRate', 'stats'].every((k) => k in i);
  })(), JSON.stringify(session.sessionInfo()));
  step('killStrayServerSync 已导出（退出兜底）', typeof (await import('../src/android/video.js')).killStrayServerSync === 'function', '');
  step('sweepScrcpyReverseSync 已导出（清理 adb reverse 泄漏，坑 13）', typeof (await import('../src/android/video.js')).sweepScrcpyReverseSync === 'function', '');

  // 坑 14 的防回归：install.ps1 必须是带 BOM 的 UTF-8，且不得用默认编码的 Get-Content 读用户文件
  {
    const ps1 = join(root, 'scripts', 'install.ps1');
    const raw = readFileSync(ps1);
    const hasBom = raw.length > 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    step('install.ps1 带 UTF-8 BOM（否则 PS 5.1 会把中文读坏、报假的语法错，坑 11/14）', hasBom, hasBom ? 'EF BB BF ✓' : `首字节 ${raw[0].toString(16)} ${raw[1].toString(16)} ${raw[2].toString(16)}`);
    const src = raw.toString('utf8');
    const badReads = src.split(/\r?\n/).filter((l) => /Get-Content\s/.test(l) && !/Encoding/.test(l) && !/^\s*#/.test(l));
    step('install.ps1 里没有「默认编码 Get-Content」（会把 UTF-8 中文写成乱码）', badReads.length === 0, badReads.join(' | ').slice(0, 160));
  }

  // 收尾：把自测里可能起来的会话停掉
  try { await session.shutdown(); } catch { /* ignore */ }
  try { await api?.status?.(); } catch { /* ignore */ }

  const failed = out.steps.filter((s) => !s.ok);
  out.ok = failed.length === 0;
  out.failed = failed.map((s) => s.name);
  const path = join(root, '..', 'recon', 'reports', 'probe-tools.json');
  mkdirSync(dirname(path), { recursive: true });
  console.log(`\n${out.ok ? '全绿' : `失败 ${failed.length} 项`} · ${out.steps.length} 项 · 报告 ${path}`);
  if (!out.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error('自测崩了：', e);
  process.exitCode = 3;
});
