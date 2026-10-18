#!/usr/bin/env node
/**
 * 静态校验 —— CI 与 git 钩子共用（`npm run check`）。
 *
 * 检查四件事，都是本项目真实踩过的坑：
 *   1. 所有 .js / .mjs 能通过 `node --check`（语法错误不该等到跑起来才发现）
 *   2. scripts/install.ps1 是 UTF-8 BOM + LF（PowerShell 5.1 否则按 ANSI 解码，中文全乱）
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

// ── 2. install.ps1 编码 ────────────────────────────────────
const ps1 = join(ROOT, 'scripts', 'install.ps1');
try {
  const buf = readFileSync(ps1);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8');
  const crlf = (text.match(/\r\n/g) || []).length;
  if (!hasBom) fail('install.ps1：缺少 UTF-8 BOM（PowerShell 5.1 会把中文读成乱码）');
  else if (crlf > 0) fail(`install.ps1：含 ${crlf} 处 CRLF，应为 LF`);
  else pass('install.ps1：UTF-8 BOM + LF 正常');
} catch (e) {
  fail('install.ps1：读取失败', e.message);
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
