#!/usr/bin/env node
/**
 * 环境自检：一条命令看清「插件在这台机器上到底能不能用」。
 *
 *   npm run doctor
 *
 * 只做只读检查（不会起会话、不会碰手机状态），随时可以跑。
 * 需要验证完整链路（起流 / 注入 / 长截图）请跑 `npm run test:device`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'dsh-android-phone';

const rows = [];
const add = (ok, title, detail = '') => rows.push({ ok, title, detail: String(detail) });

function sh(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, ...opts });
  return { code: r.status ?? -1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error };
}

// ── 1. 运行时 ────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
add(major >= 20, `Node ≥ 20（当前 ${process.version}）`, major >= 20 ? '' : '插件运行时要求 Node ≥ 20');
if (major === 22 && minor < 15) add(false, '跑测试需要 Node ≥ 22.15', 'jsdom 依赖的 undici 需要 zlib.createZstdDecompress');
add(process.platform === 'win32', `平台 Windows（当前 ${process.platform}）`, process.platform === 'win32' ? '' : '本插件只支持 Windows');

// ── 2. 随包二进制 ────────────────────────────────────────────
const vendorAdb = join(ROOT, 'vendor', 'platform-tools', 'adb.exe');
const vendorServer = join(ROOT, 'vendor', 'scrcpy-server');
add(existsSync(vendorAdb), 'vendor/platform-tools/adb.exe 存在', existsSync(vendorAdb) ? `${(statSync(vendorAdb).size / 1048576).toFixed(1)}MB` : '重新下载仓库或用 -Copy 安装');
add(existsSync(vendorServer), 'vendor/scrcpy-server 存在', existsSync(vendorServer) ? `${statSync(vendorServer).size} 字节` : '缺失会导致起流失败');

// ── 3. adb 可用性（按插件同样的查找顺序） ────────────────────
const adbCandidates = [
  process.env.DSH_ADB,
  vendorAdb,
  join(process.cwd(), 'vendor', 'platform-tools', 'adb.exe'),
  join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'adb',
].filter(Boolean);
let adbPath = null;
let adbVersion = '';
for (const c of adbCandidates) {
  const r = sh(c, ['version']);
  if (r.code === 0 && /Android Debug Bridge/i.test(r.out)) {
    adbPath = c;
    adbVersion = (r.out.match(/Version\s+(\S+)/) || [])[1] || 'unknown';
    break;
  }
}
add(!!adbPath, 'adb 可用', adbPath ? `${adbPath}（${adbVersion}）` : '没找到 adb：装 platform-tools，或把路径写进插件 config 的 adbPath');

// ── 4. 设备 ──────────────────────────────────────────────────
let serial = null;
let metrics = null;
if (adbPath) {
  const r = sh(adbPath, ['devices', '-l']);
  const lines = r.out.split(/\r?\n/).slice(1).filter((l) => l.trim());
  const parsed = lines.map((l) => l.split(/\s+/)).filter((p) => p[0] && p[1]);
  const ready = parsed.filter((p) => p[1] === 'device');
  const unauth = parsed.filter((p) => p[1] === 'unauthorized');
  if (ready.length) {
    serial = ready[0][0];
    add(true, `设备已连接（${ready.length} 台）`, ready[0].join(' '));
  } else if (unauth.length) {
    add(false, '设备未授权', `${unauth[0][0]}：在手机上点「允许 USB 调试」（勾「一律允许」）`);
  } else {
    add(false, '没有检测到设备', '手机解锁 + USB 调试已开 + 换「传输文件」模式，再跑一次');
  }

  if (serial) {
    const size = sh(adbPath, ['-s', serial, 'shell', 'wm', 'size']).out;
    const dens = sh(adbPath, ['-s', serial, 'shell', 'wm', 'density']).out;
    const m = size.match(/(\d+)x(\d+)/);
    const d = dens.match(/Override density:\s*(\d+)/) || dens.match(/(\d+)/);
    metrics = m ? { width: Number(m[1]), height: Number(m[2]), density: d ? Number(d[1]) : null } : null;
    add(!!metrics, '能读到屏幕参数', metrics ? `${metrics.width}x${metrics.height} @ ${metrics.density || '?'}dpi` : 'wm size 输出异常');
  }
}

// ── 5. 截图目录可写 ──────────────────────────────────────────
const shots = join(homedir(), '.dsh', 'android-phone', 'shots');
try {
  mkdirSync(shots, { recursive: true });
  const probe = join(shots, `.doctor-${Date.now()}.tmp`);
  writeFileSync(probe, 'ok');
  rmSync(probe, { force: true });
  const n = existsSync(shots) ? 1 : 0;
  add(n === 1, '截图目录可写', shots);
} catch (e) {
  add(false, '截图目录不可写', `${shots}：${e.message}`);
}

// ── 6. 装进 DSH profile 了吗 ────────────────────────────────
const profilesDir = join(homedir(), '.dsh', 'profiles');
let installed = null;
if (existsSync(profilesDir)) {
  for (const prof of ['desktop']) {
    const dir = join(profilesDir, prof);
    if (!existsSync(dir)) continue;
    const link = join(dir, 'node_modules', NAME);
    let linked = false;
    try {
      linked = existsSync(link) && realpathSync(link).toLowerCase() === realpathSync(ROOT).toLowerCase();
    } catch { linked = false; }
    let bundled = false;
    let skillRoot = false;
    try {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      bundled = (pj?.dsh?.profile?.bundles || []).includes(NAME);
    } catch { /* 读不到就按未注册处理 */ }
    try {
      const yml = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
      skillRoot = yml.includes(join(ROOT, 'skills'));
    } catch { /* 同上 */ }
    installed = { prof, dir, linked, bundled, skillRoot };
    break;
  }
}
if (installed) {
  add(installed.linked, `profile 里指向本仓库（${installed.prof}）`, installed.linked ? installed.dir : `junction 不存在或指向别处：跑 npm run install:profile`);
  add(installed.bundled, '已注册进 dsh.profile.bundles', installed.bundled ? '' : '跑 npm run install:profile');
  add(installed.skillRoot, '插件 skill 已并进 profile', installed.skillRoot ? '' : '跑 npm run install:profile');
} else {
  add(false, '没找到 DSH desktop profile', `${profilesDir} 不存在：DSH 装了吗？装好后跑 npm run install:profile`);
}

// ── 7. 附带 skill ───────────────────────────────────────────
const skillMd = join(ROOT, 'skills', 'jd-mall-capture', 'SKILL.md');
add(existsSync(skillMd), '附带 skill jd-mall-capture 存在', existsSync(skillMd) ? '' : '缺文件，skill 不会出现在技能列表');

// ── 输出 ────────────────────────────────────────────────────
const bad = rows.filter((r) => !r.ok).length;
const pad = Math.max(...rows.map((r) => r.title.length));
console.log(`\n${NAME} 环境自检\n`);
for (const r of rows) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.title.padEnd(pad)}  ${r.detail}`);
}
console.log(`\n${bad === 0 ? '全部通过' : `${bad} 项需要处理`}  ·  完整链路验证：npm run test:device\n`);
process.exit(bad === 0 ? 0 : 1);
