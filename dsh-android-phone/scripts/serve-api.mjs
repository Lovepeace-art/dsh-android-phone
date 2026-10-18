/**
 * serve-api.mjs —— 把插件的 HTTP 接口单独跑起来（**开发/联调用的假宿主**）
 *
 * 用途：不重启 DSH、不动真 profile，就能拿 `curl` / skill 脚本 / 侧栏以外的程序
 * 打真实的 `/dsh-android-phone/api` 接口。
 *
 *   node scripts/serve-api.mjs --port 19399
 *   # 然后： curl http://127.0.0.1:19399/dsh-android-phone/api/status
 *
 * 注意：这是**假宿主**（没有 better-sidebar、没有真实 attachments），只实现插件注册的
 * webServer 路由；`phone_screenshot` 之类会用到 attachments 的工具在这里不可用，
 * 但 `/shot`、`/action`、`/inspect`、长截图这些纯宿主能力都能真机跑。
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const PORT = Number(arg('port', 19399));
const HOST = arg('host', '127.0.0.1');

/* 与 test-plugin-tools.mjs / test-e2e-jd.mjs 同款假 ctx */
function makeCtx() {
  const registered = { tools: [], routes: [] };
  const webServer = { register(opts) { registered.routes.push(opts); return () => {}; } };
  const tools = { register(def) { registered.tools.push(def); return () => {}; } };
  const services = { tools, webServer, attachments: undefined };
  const ctx = {
    logger: { info: (...a) => console.log('[plugin]', ...a), warn: (...a) => console.warn('[plugin]', ...a), error: (...a) => console.error('[plugin]', ...a) },
    get: (n) => { if (n in services) return services[n]; throw new Error(`没有服务 ${n}`); },
    inject: (deps, fn) => { const scoped = { get: (n) => ctx.get(n), effect: ctx.effect }; fn(scoped); },
    effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {}; },
  };
  return { ctx, registered };
}

const { ctx, registered } = makeCtx();
const plugin = (await import(pathToFileURL(join(root, 'index.js')).href)).default;
await plugin.apply(ctx, { adbPath: '', defaultSerial: '', shotsDir: arg('shots-dir', '') });

const prefixes = registered.routes.filter((r) => r.kind === 'prefix').map((r) => r.path);
console.log(`[serve-api] 已注册路由前缀：${prefixes.join(', ') || '(无)'}`);
console.log(`[serve-api] 工具：${registered.tools.map((t) => t.name).join(', ')}`);

const server = createServer((req, res) => {
  const hit = registered.routes.find((r) => r.kind === 'prefix' && req.url.split('?')[0].startsWith(r.path));
  if (!hit) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `no route for ${req.url}` }));
    return;
  }
  Promise.resolve(hit.handler(req, res)).catch((e) => {
    console.error('[serve-api] handler 抛错', e);
    if (!res.writableEnded) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String((e && e.message) || e) })); }
  });
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log(`[serve-api] 监听 http://${HOST}:${addr.port}/dsh-android-phone/api`);
  console.log(`[serve-api] 例：curl http://${HOST}:${addr.port}/dsh-android-phone/api/status`);
  // 给脚本解析用（拿着它去跑探针，别猜端口）
  console.log(`SERVE_API_PORT=${addr.port}`);
  console.log('SERVE_API_READY');
});

// 端口撞车必须吵出来：**旧的 serve-api 还活着时，新实例会 EADDRINUSE 退出，
// 之后的请求全被旧进程用旧代码回答** —— 这个坑会让人对着"改了却没生效"的代码调半天
// （2026-10-17 真的踩了：19399 上的僵尸进程让三轮探针跑的都是同一份旧代码）。
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[serve-api] 端口 ${PORT} 已被占用：很可能有旧的 serve-api 还在跑（那是旧代码！）。`
      + ' 先杀掉占用者（netstat -ano | findstr :' + PORT + '），或用 --port 0 让系统分配端口。');
  } else {
    console.error('[serve-api] server error', e);
  }
  process.exit(1);
});

const bye = async () => {
  try { const { stopSession } = await import(pathToFileURL(join(root, 'src/android/session.js')).href); await stopSession('serve-api 退出'); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
