#!/usr/bin/env node
/**
 * 静态校验 —— CI 与 git 钩子共用（`npm run check`）。
 *
 * 检查四件事，都是本项目真实踩过的坑：
 *   1. 所有 .js / .mjs 能通过 `node --check`（语法错误不该等到跑起来才发现）
 *   2. scripts/install.ps1（若存在）是 UTF-8 BOM + LF；1.2.0 起该文件已移除，安装交给 DSH 插件页
 *   3. .gitattributes 里那两条关键规则还在（*.ps1 -text、源码 LF）
 *   4. git 索引里没有混进调试产物（PROBE-* / recon/ / out/ / *.bak-* / test/reports/）
 *
 * 退出码：0 全部通过；1 有失败项。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'reports', 'coverage']);
const results = [];

function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
}
function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
}

// ── 1. 语法检查 ─────────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (relative(ROOT, full).replaceAll('\\', '/').startsWith('test/reports')) continue;
      walk(full, out);
    } else if (/\.(?:js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

let checked = 0;
const syntaxErrors = [];
for (const file of walk(ROOT)) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  checked += 1;
  if (r.status !== 0) {
    syntaxErrors.push(`${relative(ROOT, file).replaceAll('\\', '/')}\n${(r.stderr || '').trim()}`);
  }
}
if (syntaxErrors.length === 0) pass(`语法：${checked} 个 .js/.mjs 通过 node --check`);
else fail(`语法：${syntaxErrors.length} 个文件有语法错误`, syntaxErrors.join('\n\n'));

// ── 2. install.ps1 编码（安装已交给 DSH 插件页；文件不存在则跳过） ──
const ps1 = join(ROOT, 'scripts', 'install.ps1');
let ps1buf = null;
try { ps1buf = readFileSync(ps1); } catch { /* 文件不存在 = 正常 */ }
if (!ps1buf) {
  pass('install.ps1：已移除（安装交给 DSH 插件页），跳过编码校验');
} else {
  const hasBom = ps1buf.length >= 3 && ps1buf[0] === 0xef && ps1buf[1] === 0xbb && ps1buf[2] === 0xbf;
  const text = ps1buf.toString('utf8');
  const crlf = (text.match(/\r\n/g) || []).length;
  if (!hasBom) fail('install.ps1：缺少 UTF-8 BOM（PowerShell 5.1 会把中文读成乱码）');
  else if (crlf > 0) fail(`install.ps1：含 ${crlf} 处 CRLF，应为 LF`);
  else pass('install.ps1：UTF-8 BOM + LF 正常');
}

// ── 3. .gitattributes 关键规则 ─────────────────────────────
try {
  const ga = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  const need = [
    ['*.ps1 -text', /^\s*\*\.ps1\s+-text\s*$/m],
    ['*.js text eol=lf', /^\s*\*\.js\s+text\s+eol=lf\s*$/m],
  ];
  const missing = need.filter(([, re]) => !re.test(ga)).map(([label]) => label);
  if (missing.length) fail(`.gitattributes：缺规则 ${missing.join('、')}`);
  else pass('.gitattributes：保护规则齐全');
} catch (e) {
  fail('.gitattributes：读取失败', e.message);
}

// ── 4. git 索引无调试产物 ──────────────────────────────────
function gitTracked() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
}
const tracked = gitTracked();
if (tracked === null) {
  pass('git 产物检查：跳过（不在 git 仓库或没有 git）');
} else {
  const bad = tracked.filter((p) => {
    const posix = p.replaceAll('\\', '/');
    return /(^|\/)(PROBE-[^/]*)$/.test(posix)
      || /^recon\//.test(posix)
      || /^out\//.test(posix)
      || /^test\/reports\//.test(posix)
      || /\.bak-/.test(posix);
  });
  if (bad.length) fail(`git 索引里有 ${bad.length} 个调试产物`, bad.slice(0, 20).join('\n'));
  else pass(`git 产物检查：${tracked.length} 个跟踪文件里没有调试产物`);
}

// ── 5. 注释吃掉代码 ────────────────────────────────────────
// 真实事故：一次脚本化替换把 "\n" 当转义字符写进了 `//` 注释，于是同一行后面的
// `if (route === 'apps') …` 整段被注释掉 —— 语法合法、测试没覆盖，功能静默消失。
// 规则：① 单行注释里出现字面量 \n / \t；② // 之后紧跟控制流（if/for/while/return）语句。
const COMMENT_BUGS = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  // 本文件自身要描述这些模式（注释里必然出现字面量转义），跳过以免自我误报
  if (rel === 'scripts/check.mjs') continue;
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const idx = line.indexOf('//');
    if (idx < 0) return;
    const comment = line.slice(idx + 2);
    if (/\\[nt]/.test(comment)) {
      COMMENT_BUGS.push(`${rel}:${i + 1} 注释里有字面量 \\n/\\t（很可能是替换脚本写错，吞掉了后面的代码）`);
    }
    const tail = comment.trim();
    if (/^(?:if|for|while|do|return|throw|const|let|var|await|import|export)\b/.test(tail) && /[;{]\s*$/.test(tail)) {
      COMMENT_BUGS.push(`${rel}:${i + 1} 这行 // 后面像是可执行代码：${tail.slice(0, 70)}`);
    }
  });
}
if (COMMENT_BUGS.length === 0) pass('注释检查：没有被注释吃掉的代码');
else fail(`注释检查：${COMMENT_BUGS.length} 处可疑`, COMMENT_BUGS.join('\n'));

// ── 6. 插件图标链路 ────────────────────────────────────────
// 图标在五处被引用：assets/icon.png 文件本身、package.json 的 icon、exports "./icon"、
// 宿主 /icon.png 路由、client.js 的侧栏 tab。任何一处对不上都会静默退回默认插画，所以做静态自检。
const ICON_PROBLEMS = [];
const iconFile = join(ROOT, 'assets', 'icon.png');
try {
  const bytes = readFileSync(iconFile);
  if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
    ICON_PROBLEMS.push('assets/icon.png 不是合法 PNG');
  }
} catch {
  ICON_PROBLEMS.push('assets/icon.png 不存在');
}
try {
  const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (pkgJson.icon !== 'assets/icon.png') ICON_PROBLEMS.push(`package.json 的 icon 应为 assets/icon.png，实际 ${JSON.stringify(pkgJson.icon)}`);
  if (!pkgJson.exports || pkgJson.exports['./icon'] !== './assets/icon.png') ICON_PROBLEMS.push('package.json 缺少 exports "./icon": "./assets/icon.png"');
  if (!Array.isArray(pkgJson.files) || !pkgJson.files.includes('assets')) ICON_PROBLEMS.push('package.json 的 files 缺少 assets');
} catch (e) {
  ICON_PROBLEMS.push(`package.json 读取失败：${e.message}`);
}
try {
  if (!/route === 'icon\.png'/.test(readFileSync(join(ROOT, 'index.js'), 'utf8'))) ICON_PROBLEMS.push("index.js 没有 /icon.png 路由");
  if (!/\/icon\.png/.test(readFileSync(join(ROOT, 'client.js'), 'utf8'))) ICON_PROBLEMS.push('client.js 的侧栏 tab 没有引用 icon.png');
} catch (e) {
  ICON_PROBLEMS.push(`index.js/client.js 读取失败：${e.message}`);
}
if (ICON_PROBLEMS.length === 0) pass('图标链路：icon.png + manifest + exports + /icon.png 路由 + 侧栏引用齐全');
else fail(`图标链路：${ICON_PROBLEMS.length} 处不一致`, ICON_PROBLEMS.join('\n'));
// ── 输出 ───────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
  else {
    failed += 1;
    console.log(`✗ ${r.name}`);
    if (r.detail) console.log(r.detail.replace(/^/gm, '    '));
  }
}
console.log(failed === 0 ? '\ncheck: 全部通过' : `\ncheck: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
