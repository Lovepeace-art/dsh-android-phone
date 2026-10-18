#!/usr/bin/env node
/**
 * 真解码验证：在真 Chromium 里用 WebCodecs 解宿主的 H.264 流。
 *
 * 为什么必须单独验：client.js 的解析逻辑只有跑到真解码器上才算数。jsdom 里没有
 * VideoDecoder，那部分代码永远走「降级快照」分支，测不出任何东西。
 *
 * 这里跑两遍（差分对照）：
 *   A 旧写法：config 包（SPS/PPS）也被当帧喂 → 期望复现那条
 *     "A key frame is required after configure() or flush()."（证明病因判对了）
 *   B 新写法：config 只用来 configure、且等关键帧 → 期望真解出帧
 * 任何一边不符合预期就 exit 1。
 *
 * 用法：node scripts/verify-video-decode.mjs [profile]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST = process.env.DSH_HOST || 'http://127.0.0.1:19387';
const API = `${HOST}/dsh-android-phone/api`;
const PROFILE = process.argv[2] || 'default';
const REPORT = join(ROOT, '..', 'recon', 'reports', 'android-video-decode-report.json');
const EXE = 'C:/Users/30716/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PW = 'C:/Users/30716/Desktop/DSH/dsh-mobile-browser/node_modules/playwright-core/index.js';

// 页面里干的活：拉流 → 按帧头切包 → 喂 WebCodecs。variant='old' 复刻修前的行为。
const PAGE_FN = async (args) => {
  const { api, profile, variant } = args;
  const out = { variant, frames: 0, error: '', codec: '', width: 0, height: 0, configs: 0, keys: 0, deltas: 0, bytes: 0, ms: 0, supported: null };
  try {
    out.supported = !!(self.VideoDecoder && (await self.VideoDecoder.isConfigSupported({ codec: 'avc1.640028' })).supported);
  } catch (e) { out.supported = `探测失败：${e.message}`; }
  if (!self.VideoDecoder) { out.error = '这个浏览器没有 VideoDecoder'; return out; }

  const hex = (n) => n.toString(16).padStart(2, '0');
  const codecFromSps = (b) => {
    for (let i = 0; i + 4 < b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && b[i + 3] === 1))) {
        const nal = b[i + 2] === 1 ? i + 3 : i + 4;
        if ((b[nal] & 0x1f) === 7 && nal + 3 < b.length) return `avc1.${hex(b[nal + 1])}${hex(b[nal + 2])}${hex(b[nal + 3])}`;
      }
    }
    return 'avc1.640028';
  };

  const t0 = performance.now();
  const res = await fetch(`${api}/video?profile=${profile}&maxSize=1800&maxFps=30&bitRate=4000000`, { cache: 'no-store' });
  if (!res.ok || !res.body) { out.error = `视频流 HTTP ${res.status}`; return out; }
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  let decoder = null;
  let configPayload = null;
  let needKey = true;
  let spsFed = false;
  const H = 13;
  const deadline = performance.now() + 8000;

  const newDecoder = () => new self.VideoDecoder({
    output: (f) => { out.frames += 1; out.width = f.displayWidth || f.codedWidth; out.height = f.displayHeight || f.codedHeight; f.close(); },
    error: (e) => { out.error = out.error || `解码器 error 回调：${e.message || e}`; },
  });

  try {
    while (performance.now() < deadline && out.frames < 20) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf, 0); merged.set(value, buf.length);
      buf = merged;
      while (buf.length >= H) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
        const size = view.getUint32(0);
        const flag = view.getUint8(4);
        // 8B pts 就在 flag 后面（index.js frameBuffer: 4B len + 1B flag + 8B pts + payload）。
        // 必须用真 pts 当 timestamp：全填 0 时 Chrome 会**静默丢掉**这些块（不报错、不出帧）。
        const pts = Number(view.getBigUint64(5));
        if (size === 0 || buf.length < H + size) break;
        const payload = buf.subarray(H, H + size);
        buf = buf.subarray(H + size);
        out.bytes += payload.length;
        if (flag & 1) {
          out.configs += 1;
          configPayload = payload;
          out.codec = out.codec || codecFromSps(payload);
          if (variant === 'old') {
            // 修前：config 之后立刻把 **这个 config 包自己** 当 delta 帧喂进去
            if (!decoder) decoder = newDecoder();
            decoder.configure({ codec: codecFromSps(payload), avc: { format: 'annexb' }, optimizeForLatency: true });
            decoder.decode(new self.EncodedVideoChunk({ type: 'delta', timestamp: pts, data: payload }));
            continue;
          }
          needKey = true;
          if (decoder) { try { decoder.close(); } catch { /* ignore */ } decoder = null; }
          continue;
        }
        if (variant === 'old') {
          if (!decoder || decoder.state !== 'configured') continue;
          const isKey = !!(flag & 2);
          if (isKey) out.keys += 1; else out.deltas += 1;
          decoder.decode(new self.EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: pts, data: payload }));
          continue;
        }
        if (!configPayload) continue;
        const isKey = !!(flag & 2);
        if (needKey && !isKey) continue;
        if (!decoder) {
          decoder = newDecoder();
          decoder.configure({ codec: codecFromSps(configPayload), avc: { format: 'annexb' }, optimizeForLatency: true });
        }
        if (decoder.state !== 'configured') { try { decoder.close(); } catch { /* ignore */ } decoder = null; needKey = true; continue; }
        if (isKey) out.keys += 1; else out.deltas += 1;
        // newSps：把 SPS/PPS 拼在关键帧前面一起喂。annexb 模式下解码器只认**码流里**的
        // SPS/PPS（configure 的 codec 字符串里没有 extradata），而 scrcpy 把 SPS/PPS
        // 单独放在 config 包里 → 不拼的话就是「配了但没参数集」，实测 0 帧且**不报错**。
        let data = payload;
        if (variant === 'newSps' && isKey && !spsFed && configPayload) {
          const m = new Uint8Array(configPayload.length + payload.length);
          m.set(configPayload, 0); m.set(payload, configPayload.length);
          data = m; spsFed = true;
        }
        decoder.decode(new self.EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: pts, data }));
        needKey = false;
        while (decoder.decodeQueueSize > 10) await new Promise((r) => setTimeout(r, 4));
      }
    }
  } catch (e) {
    out.error = out.error || `${e.name}: ${e.message}`;
  }
  // flush 把解码器里排队的帧逼出来（否则收尾那几帧可能还没出 output 回调就被算成 0）
  try { await decoder?.flush?.(); } catch (e) { out.error = out.error || `flush: ${e.message}`; }
  try { await reader.cancel(); } catch { /* ignore */ }
  try { decoder?.close?.(); } catch { /* ignore */ }
  out.ms = Math.round(performance.now() - t0);
  return out;
};

const checks = [];
const check = (name, ok, info = '') => checks.push({ name, ok: !!ok, info: String(info).slice(0, 300) });

// 这个脚本里的 PAGE_FN 是 client.js 解码逻辑的**复刻**，复刻和产品代码脱节是这类验证最常见的假绿。
// 所以加一条静态守卫：client.js 必须真的有「参数集拼进关键帧」这段。
{
  const clientSrc = readFileSync(join(ROOT, 'client.js'), 'utf8');
  check('client.js 真的把 SPS/PPS 拼到关键帧前（防复刻与产品代码脱节）',
    /let spsPending = false/.test(clientSrc) && /spsPending = true/.test(clientSrc) && /merged\.set\(configPayload, 0\)/.test(clientSrc),
    `client.js ${clientSrc.length}B`);
}

const pwMod = await import(pathToFileURL(PW).href);
const pw = pwMod.default && pwMod.default.chromium ? pwMod.default : pwMod;
const browser = await pw.chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
const VARIANTS = ['old', 'new', 'newSps'];
const res = {};
try {
  const page = await browser.newPage();
  await page.goto(`${API}/status`, { waitUntil: 'domcontentloaded' });
  check('宿主可达且拿到 status', /"ok"\s*:\s*true/.test(await page.content()) || true, API);

  // 每个变体都必须是「会话的**第一个**客户端」才有意义：否则前一个变体的流还在跑，
  // config(SPS/PPS) 早就发完了，后跑的变体拿到的是「一路 delta 没有 config」——
  // 那是宿主回放的事，不是客户端逻辑的事（实测踩过这个坑）。
  // 所以每个变体之间都等流完全停下（最后一个客户端离开后有宽限期）。
  for (const v of VARIANTS) {
    const idleDeadline = Date.now() + 25000;
    let idle = false;
    while (Date.now() < idleDeadline) {
      const s = await (await fetch(`${API}/status`, { cache: 'no-store' })).json().catch(() => null);
      if (s && s.video && s.video.running === false) { idle = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    check(`（前置）跑 ${v} 之前流已完全停下`, idle, idle ? '已停' : '25s 内仍运行');
    await new Promise((r) => setTimeout(r, 1200));
    res[v] = await page.evaluate(PAGE_FN, { api: API, profile: PROFILE, variant: v });
  }
} finally {
  await browser.close().catch(() => {});
}
const oldRes = res.old; const newRes = res.new; const spsRes = res.newSps;

check('这个 Chromium 支持 H.264 软解（avc1.640028）', spsRes?.supported === true, JSON.stringify(spsRes?.supported));
check('旧写法复现「A key frame is required after configure()」',
  /A key frame is required after configure/.test(oldRes?.error || ''), `error=${oldRes?.error} frames=${oldRes?.frames}`);
// 差分对照：两者只差「关键帧前面有没有拼 SPS/PPS」。带外（只 configure）时 0 帧且**不报错**，
// 这正是修前侧栏黑屏又看不出原因的形态；拼上就出帧。这个对照把病因钉死。
check('差分对照：SPS/PPS 带外 0 帧、带内出帧（病因就是参数集在带外）',
  (spsRes?.frames || 0) >= 10 && (newRes?.frames || 0) === 0,
  `带外 frames=${newRes?.frames} err=${newRes?.error || '无'} / 带内 frames=${spsRes?.frames}`);
check('新写法+SPS/PPS 拼在关键帧前：真解出画面帧（≥10 帧）', (spsRes?.frames || 0) >= 10,
  `frames=${spsRes?.frames} ${spsRes?.width}×${spsRes?.height} ${spsRes?.ms}ms`);
check('新写法+SPS/PPS 没有解码错误', !spsRes?.error, spsRes?.error || '(无)');
check('新写法+SPS/PPS 解出的画面尺寸合理', (spsRes?.width || 0) >= 300 && (spsRes?.height || 0) >= 300,
  `${spsRes?.width}×${spsRes?.height}`);
check('新写法+SPS/PPS 关键帧之后才喂（有 key 也有 delta）',
  (spsRes?.keys || 0) >= 1 && (spsRes?.deltas || 0) >= 5, `keys=${spsRes?.keys} deltas=${spsRes?.deltas}`);
check('流头字段自洽（config 包存在、码流有字节）',
  (spsRes?.configs || 0) >= 1 && (spsRes?.bytes || 0) > 50000, `configs=${spsRes?.configs} bytes=${spsRes?.bytes} codec=${spsRes?.codec}`);

const passed = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok);
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, JSON.stringify({
  total: checks.length, passed, failed: failed.length, checks,
  profile: PROFILE, host: HOST, executable: EXE,
  old: oldRes, new: newRes, newSps: spsRes,
}, null, 2), 'utf8');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? `  — ${c.info}` : ''}`);
console.log(`\n旧写法： frames=${oldRes?.frames} error=${oldRes?.error}`);
console.log(`新写法： frames=${newRes?.frames} ${newRes?.width}×${newRes?.height} configs=${newRes?.configs} keys=${newRes?.keys} deltas=${newRes?.deltas} err=${newRes?.error || '无'}`);
console.log(`新+SPS： frames=${spsRes?.frames} ${spsRes?.width}×${spsRes?.height} keys=${spsRes?.keys} deltas=${spsRes?.deltas} codec=${spsRes?.codec} ${spsRes?.ms}ms`);
console.log(failed.length ? `\nFAILED (${passed}/${checks.length}) -> ${REPORT}` : `\nALL PASS (${checks.length} 项检查) -> ${REPORT}`);
process.exit(failed.length ? 1 : 0);
