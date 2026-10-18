/**
 * 长截图质量自检 CLI（逻辑在 src/core/quality.js，这里只负责读文件打印）。
 * 用法：node dsh-android-phone/scripts/verify-stitch-quality.mjs <png> [块高=100] [相隔阈值=400]
 * 退出码：0 = 没发现问题；1 = 需要人眼核对；2 = 参数/文件问题。
 */
import { readFileSync } from 'node:fs';
import { decodePng } from '../src/core/png.js';
import { checkStitchQuality } from '../src/core/quality.js';

const [file, blockArg, gapArg] = process.argv.slice(2);
if (!file) {
  console.error('用法: node verify-stitch-quality.mjs <png> [块高=100] [相隔阈值=400]');
  process.exit(2);
}
const r = checkStitchQuality(decodePng(readFileSync(file)), {
  block: Number(blockArg) || 100,
  minGap: Number(gapArg) || 400,
});

console.log(`${file}: ${r.width}x${r.height}`);
console.log(`重复块（块高 ${r.block}，相隔 ≥400 行）：${r.duplicateCount} 处`);
for (const d of r.duplicates) console.log(`  row ${d.a} == row ${d.b}  (相隔 ${d.gap} 行)`);
console.log(`粗粒度重复块：${r.coarseCount} 处`);
for (const d of r.coarse) console.log(`  row ${d.a} ≈ row ${d.b}  (平均亮度差 ${d.mad})`);
console.log(`连续同签名段 >150 行：${r.runCount} 处`);
for (const s of r.runs) console.log(`  rows ${s.from}..${s.to} (${s.rows} 行)`);
console.log(r.ok ? 'RESULT OK：没发现重复贴段/未遮掉的固定栏' : `RESULT CHECK：${r.reason}`);
process.exit(r.ok ? 0 : 1);
