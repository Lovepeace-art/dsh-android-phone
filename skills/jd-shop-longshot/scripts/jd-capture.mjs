/**
 * jd-capture —— 京东 App 单页长截图（skill 的执行器）。
 *
 * 流程：确保京东在前台 → 执行 --pre 里的动作（可取 jd.json 的命名动作）→
 *       逐帧滚动拼接长截图 → 质量自检（重复贴段/未遮固定栏）→ 落盘 PNG + sidecar JSON。
 *
 * 用法：
 *   node .agents/skills/jd-shop-longshot/scripts/jd-capture.mjs [选项]
 *     --serial <序列号>   指定设备（默认取唯一在线设备）
 *     --out-dir <目录>    产物目录（默认 <工作区>/recon/android-shots）
 *     --pre a,b           长截图前依次执行的动作名（来自 dsh-android-phone/actions/jd.json）
 *     --steps <n>         最多拼几步（默认 8）
 *     --app <包名>        目标 App（默认 com.jingdong.app.mall）
 *     --adb <路径>        adb 可执行文件（默认自动找 QtScrcpy / PATH）
 *     --no-launch         不要自动启动 App（只处理当前前台页面）
 *     --no-quality        跳过质量自检
 *     --json              只打印 JSON（给自动化用）
 * 退出码：0 成功且自检通过；1 自检发现问题；2 参数/环境错误；3 运行失败。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

/** 找 dsh-android-phone 引擎目录：env 优先，否则从脚本位置往上找 */
function findEngineRoot() {
  const fromEnv = process.env.DSH_ANDROID_PHONE_ROOT;
  if (fromEnv && existsSync(join(fromEnv, 'src', 'android', 'adb.js'))) return resolve(fromEnv);
  let dir = HERE;
  for (let i = 0; i < 6; i += 1) {
    const cand = join(dir, 'dsh-android-phone');
    if (existsSync(join(cand, 'src', 'android', 'adb.js'))) return cand;
    dir = dirname(dir);
  }
  const direct = resolve(HERE, '..', '..', '..', 'dsh-android-phone');
  if (existsSync(join(direct, 'src', 'android', 'adb.js'))) return direct;
  throw new Error('找不到 dsh-android-phone 引擎目录（设 DSH_ANDROID_PHONE_ROOT 环境变量指向它）');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const ENGINE = findEngineRoot();
const load = (rel) => import(pathToFileURL(join(ENGINE, rel)).href);
const adb = await load('src/android/adb.js');
const { androidLongshot } = await load('src/android/longshot.js');
const actionsMod = await load('src/android/actions.js');
const { decodePng } = await load('src/core/png.js');
const { checkStitchQuality } = await load('src/core/quality.js');

const log = (...a) => { if (!args.json) console.log(...a); };
const started = Date.now();
const result = { ok: false, engine: ENGINE, steps: [] };

try {
  const adbPath = typeof args.adb === 'string' ? args.adb : adb.resolveAdb();
  const dev = await adb.pickDevice(typeof args.serial === 'string' ? args.serial : undefined, adbPath);
  const serial = dev.serial;
  const pkg = typeof args.app === 'string' ? args.app : 'com.jingdong.app.mall';
  result.adbPath = adbPath;
  result.serial = serial;
  result.device = { state: dev.state, model: dev.model };
  result.app = pkg;
  const adbVer = await adb.adbVersion(adbPath).catch(() => null);
  result.adbVersion = adbVer?.version || '';
  log(`[jd-capture] 设备 ${serial}${dev.model ? ` (${dev.model})` : ''} / adb ${adbPath}${adbVer?.version ? ` [adb ${adbVer.version}]` : ''}`);

  const metrics = await adb.screenMetrics(serial, { adbPath });
  result.metrics = metrics;
  log(`[jd-capture] 屏幕 ${metrics.width}x${metrics.height} @${metrics.density ?? '?'}dpi`);

  if (!args['no-launch']) {
    const fg = await actionsMod.ensureForeground(serial, pkg, { adbPath, waitMs: 8000 });
    const before = fg.focus?.package || '(未知)';
    const after = fg.after?.package || fg.focus?.package || '(未知)';
    result.foreground = { before, after: fg.after?.package || fg.focus?.package, launched: fg.launched };
    log(`[jd-capture] 前台：${before} → ${after}${fg.launched ? '（已启动）' : ''}`);
    if (after !== '(未知)' && after !== pkg) {
      log(`[jd-capture] 警告：当前前台不是 ${pkg}，长截图可能拍错应用`);
    }
  }

  const mapPath = join(ENGINE, 'actions', 'jd.json');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const pre = typeof args.pre === 'string' ? args.pre.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (pre.length) {
    log(`[jd-capture] 前置动作：${pre.join(' → ')}`);
    const steps = await actionsMod.runActions(serial, metrics, map, pre, { adbPath, settleMs: 400 });
    for (const s of steps) log(`[jd-capture]   ${s.type} ${s.detail} (${s.ms}ms)${s.comment ? ` — ${s.comment}` : ''}`);
    result.steps = steps;
  }

  const outDir = typeof args['out-dir'] === 'string'
    ? resolve(args['out-dir'])
    : join(resolve(ENGINE, '..'), 'recon', 'android-shots');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const png = join(outDir, `${stamp}-${pkg.split('.').pop()}-long.png`);

  log('[jd-capture] 开始逐帧滚动拼接…');
  const shot = await androidLongshot(serial, png, {
    adbPath,
    maxSteps: Number(args.steps) || 8,
    settleMs: 420,
    scrollRatio: 0.58,
  });
  result.longshot = {
    path: png, bytes: statSync(png).size, width: shot.width, height: shot.height,
    mode: shot.mode, steps: shot.steps?.length ?? 0, offsets: shot.offsets,
    masks: shot.masks, uiMask: shot.uiMask,
  };
  log(`[jd-capture] 长截图 ${shot.width}x${shot.height} ${(statSync(png).size / 1024).toFixed(0)}KB mode=${shot.mode} offsets=${JSON.stringify(shot.offsets)}`);
  log(`[jd-capture] 遮罩 top=${shot.masks?.top} bottom=${shot.masks?.bottom}（控件树量出 top=${shot.uiMask?.top} bottom=${shot.uiMask?.bottom}）`);

  if (!args['no-quality']) {
    const q = checkStitchQuality(decodePng(readFileSync(png)));
    result.quality = { ok: q.ok, reason: q.reason, duplicateCount: q.duplicateCount, coarseCount: q.coarseCount, runCount: q.runCount };
    log(`[jd-capture] 自检：${q.ok ? 'OK' : '有问题'} — 重复贴段 ${q.duplicateCount}，粗粒度相似 ${q.coarseCount}，长同色段 ${q.runCount}${q.ok ? '' : `（${q.reason}）`}`);
    if (!q.ok) result.ok = false;
  }

  result.ok = !result.quality || result.quality.ok;
  result.ms = Date.now() - started;
  const sidecar = png.replace(/\.png$/, '.json');
  writeFileSync(sidecar, JSON.stringify(result, null, 2), 'utf8');
  result.sidecar = sidecar;
  if (args.json) console.log(JSON.stringify(result));
  else {
    log(`[jd-capture] ${result.ok ? '完成' : '完成但有告警'}：${png}`);
    log(`[jd-capture] sidecar：${sidecar}（总耗时 ${result.ms}ms）`);
  }
  process.exit(result.ok ? 0 : 1);
} catch (e) {
  result.error = e?.message || String(e);
  console.error(`[jd-capture] 失败：${result.error}`);
  if (args.json) console.log(JSON.stringify(result));
  process.exit(3);
}
