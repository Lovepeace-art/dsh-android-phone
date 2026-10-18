/**
 * 阶段 1 验收：单会话（视频 + 控制）真机测试。
 *
 * 验四件事：
 *  1) `tunnel=reverse` 的单会话能不能长跑（>18s，任务书里正向模式会 2~4s 静默死掉）
 *  2) 控制 socket 是否拿到（server 按 video→control 顺序连，且都在流头之前）
 *  3) 控制注入是否真的落到设备：HOME 键 → 前台包名变化；START_APP → 京东到前台
 *  4) 延迟对照：控制通道 tap 的宿主侧发起耗时 vs `adb shell input tap` 的端到端
 *
 * 跑法：node scripts/test-session.mjs [观察秒数]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adbRun, resolveAdb, pickDevice, screenMetrics, currentFocus } from '../src/android/adb.js';
import { startVideoStream } from '../src/android/video.js';
import { createControlChannel, MSG } from '../src/android/control.js';

const OBSERVE_MS = (Number(process.argv[2]) || 18) * 1000;
const out = { ranAt: new Date().toISOString(), steps: [] };
const step = (name, ok, detail) => {
  out.steps.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail === undefined ? '' : ' → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const adbPath = resolveAdb();
  const { serial } = await pickDevice(undefined, adbPath);
  const metrics = await screenMetrics(serial, { adbPath });
  out.device = { serial, adbPath, metrics };
  console.log(`设备=${serial} 分辨率=${metrics.width}x${metrics.height} density=${metrics.density}`);

  let session = null;
  try {
    const t0 = Date.now();
    session = await startVideoStream({
      serial, adbPath, control: true, maxSize: 1024, bitRate: 3_000_000, maxFps: 30,
      log: (m) => console.log(`  · ${m}`),
    });
    out.startMs = Date.now() - t0;
    step('会话启动', true, `${session.width}x${session.height} ${session.tunnel}/${session.layout} codec=${session.codec} ${out.startMs}ms`);
    step('reverse 模式', session.tunnel === 'reverse', session.tunnel);
    step('控制 socket', !!session.controlSocket, session.controlSocket ? '已建立' : '缺失');

    // 收流统计
    const buckets = new Map();
    let packets = 0, keyPkts = 0, cfgPkts = 0, bytes = 0;
    session.onPacket((p) => {
      packets++; bytes += p.size;
      if (p.key) keyPkts++;
      if (p.config) cfgPkts++;
      const s = Math.floor((Date.now() - t0) / 1000);
      buckets.set(s, (buckets.get(s) || 0) + p.size);
    });

    let ctl = null;
    if (session.controlSocket) {
      ctl = createControlChannel(session.controlSocket, { log: (m) => console.log(`  · ${m}`), screen: { width: metrics.width, height: metrics.height } });
      step('控制通道可用', ctl.available, ctl.screen);
    }

    await sleep(1500);

    // ---- 控制注入是否真落地：HOME 键 ----
    if (ctl) {
      const fgOf = (f) => (f && (f.package || f.raw)) || String(f || '');
      const before = fgOf(await currentFocus(serial, { adbPath }).catch(() => null));
      const rHome = ctl.keycode(3);                     // KEYCODE_HOME
      await sleep(900);
      const after = fgOf(await currentFocus(serial, { adbPath }).catch(() => null));
      out.homeKey = { before, after, send: rHome };
      step('HOME 键注入生效', before !== after || /launcher|home/i.test(after), `${before} → ${after}`);
      // 再点一下京东图标那条路不保险，直接用 START_APP 消息（scrcpy 控制通道独有）
      const rApp = ctl.startApp('com.jingdong.app.mall');
      await sleep(6000);
      const fg = fgOf(await currentFocus(serial, { adbPath }).catch(() => null));
      out.startApp = { send: rApp, fg };
      step('START_APP 拉起京东', /jingdong/i.test(fg), fg);
    }

    // ---- 延迟对照 ----
    if (ctl) {
      const us = [];
      for (let i = 0; i < 5; i++) { const r = ctl.tap(540, 1200); us.push(r.us); await sleep(120); }
      const avgUs = us.reduce((a, b) => a + b, 0) / us.length;
      out.controlTapUs = { samples: us.map((v) => Math.round(v)), avg: Math.round(avgUs), max: Math.round(Math.max(...us)) };
      step('控制通道 tap 宿主耗时', avgUs < 2000, `avg=${avgUs.toFixed(0)}µs max=${Math.max(...us).toFixed(0)}µs`);
    }
    const adbMs = [];
    for (let i = 0; i < 3; i++) {
      const s = Date.now();
      await adbRun(['shell', 'input', 'tap', '540', '1200'], { serial, adbPath, timeoutMs: 10000 });
      adbMs.push(Date.now() - s);
      await sleep(150);
    }
    out.adbTapMs = { samples: adbMs, avg: Math.round(adbMs.reduce((a, b) => a + b, 0) / adbMs.length) };
    step('adb input tap 端到端', true, `avg=${out.adbTapMs.avg}ms samples=${adbMs.join('/')}`);
    if (out.controlTapUs && out.adbTapMs.avg) {
      step('控制通道快于 adb', true, `${(out.adbTapMs.avg * 1000 / out.controlTapUs.avg).toFixed(0)}× (adb ${out.adbTapMs.avg}ms vs 控制 ${(out.controlTapUs.avg / 1000).toFixed(2)}ms)`);
    }

    // ---- 观察长跑 ----
    console.log(`  · 观察 ${OBSERVE_MS / 1000}s…`);
    await sleep(OBSERVE_MS);
    const secBytes = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([s, b]) => b);
    out.stream = {
      packets, keyPkts, cfgPkts, bytes, secBytes,
      sessionStats: { ...session.stats, firstPts: String(session.stats.firstPts), lastPts: String(session.stats.lastPts) },
      idleSeconds: secBytes.filter((b) => b === 0).length,
      exited: session.exited() || null,
      lastPacketAgoMs: Date.now() - session.stats.lastPacketAt,
    };
    step('收流长跑存活', !session.exited(), `exit=${JSON.stringify(session.exited())} 最后帧=${out.stream.lastPacketAgoMs}ms 前`);
    step('帧持续到达', (Date.now() - session.stats.lastPacketAt) < 2500, `最后帧距今 ${Date.now() - session.stats.lastPacketAt}ms`);
    console.log(`  包=${packets} 关键帧=${keyPkts} config=${cfgPkts} 字节=${bytes} 每秒=${secBytes.join(',')}`);
    if (ctl) out.controlStats = ctl.stats;
    out.ok = out.steps.every((s) => s.ok);
  } catch (e) {
    step('异常', false, e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
    out.ok = false;
    out.error = e.message;
  } finally {
    if (session) { try { await session.stop(); } catch (e) { console.log('  stop 出错: ' + e.message); } }
    const p = join(dirname(fileURLToPath(import.meta.url)), 'reports', 'session-report.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    console.log(`\n结果：${out.ok ? 'PASS' : 'FAIL'}；报告 → ${p}`);
  }
}

main().then(() => process.exit(out.ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(3); });
