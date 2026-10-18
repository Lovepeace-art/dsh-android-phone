/**
 * dsh-android-phone —— 客户端半边（DSH 右侧栏 tab）。
 *
 * 这是「眼睛和手」：侧栏里显示真机实时画面（scrcpy 的 H.264 视频流，WebCodecs 解码到 canvas），
 * 并且把鼠标/触摸操作换算成设备相对坐标回传给宿主，注入到手机上（tap / 长按 / 拖拽 / 滚轮）。
 *
 * 规矩（client 半边）：
 *  - 手写纯 JS，不能用 JSX/TS/import/export；只 require baseline 里有的包（这里只用 react）。
 *  - 必须用 window.__ModuleLoader__.load({ id: '<包名>', factory }) 注册，id 要与包名一致。
 *  - 拿宿主路由 URL 必须走 ctx.betterSidebar.hostRouteUrl('dsh-android-phone/api')，不能带前导斜杠。
 *  - registerTab 必须包在 ctx.effect 里，否则 HMR 二次激活会抛 "already registered"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-android-phone',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } = React;
    // 有些宿主注入的 React 可能没有 useLayoutEffect（极少见），兜底成 useEffect
    const useIsoLayoutEffect = typeof useLayoutEffect === 'function' ? useLayoutEffect : useEffect;

    /* ---------------------------------------------------------------- 常量/样式 */

    const JD_PACKAGE = 'com.jingdong.app.mall';
    const FRAME_HEADER = 13; // 4B size + 1B flag + 8B pts

    // 工具栏「▶ 打开」的兜底候选（与宿主 SETTINGS_DEFAULT_APPS 同口径）：
    // 宿主 /settings 读不到时用它，避免下拉变成空列表（2026-10-18 用户反馈「下拉里没有更多 App」）。
    const DEFAULT_APPS = [
      { label: '京东', pkg: 'com.jingdong.app.mall' },
      { label: '淘宝', pkg: 'com.taobao.taobao' },
      { label: '拼多多', pkg: 'com.xunmeng.pinduoduo' },
      { label: '抖音', pkg: 'com.ss.android.ugc.aweme' },
      { label: '微信', pkg: 'com.tencent.mm' },
      { label: 'QQ', pkg: 'com.tencent.mobileqq' },
    ];

    // 与宿主 VIDEO_PRESETS 保持同一口径：maxSize 是长边像素，bitRate 是 H.264 码率。
    // 真机是 1080x2400（9:20）。默认「自适应」：按画布在屏幕上的实际设备像素反推需要的长边，
    // 传多了白烧带宽、传少了被浏览器放大成糊——这就是之前「发虚」的一半原因。
    const QUALITY = {
      // maxFps 全部给 60：手机屏幕本身是 60Hz，QtScrcpy 默认也是不设上限，
      // 卡在 30 时鼠标拖动/滚动的跟手感只有一半（用户原话「不如 qtscrcpy 那么流畅」）。
      // 标签按用户 2026-10-17 的要求用全称：自动 / 省流 / 标准 / 高清。
      auto: { label: '自动', full: '自适应（按侧栏实际像素算）', maxSize: 0, bitRate: 0, maxFps: 60 },
      eco: { label: '省流', full: '省流（长边 1200）', maxSize: 1200, bitRate: 2500000, maxFps: 60 },
      std: { label: '标准', full: '标准（长边 1800）', maxSize: 1800, bitRate: 4000000, maxFps: 60 },
      hd: { label: '高清', full: '高清（长边 2400）', maxSize: 2400, bitRate: 8000000, maxFps: 60 },
    };

    // 真机是 1080x2400（竖屏 9:20），编码出来的画面宽度只有长边的 0.45 倍。
    // 所以「画布足够清晰」要同时满足两个方向：
    //   竖向：maxSize（长边）≥ 画布高 × dpr
    //   横向：0.45 × maxSize ≥ 画布宽 × dpr  →  maxSize ≥ 画布宽 × dpr / 0.45
    // 早先只按 max(cssW,cssH)×dpr 算，在窄长侧栏里会被「高」那一项压住：
    // 例如 400x700 的侧栏只会要 720 → 编码 324x720，横向比画布还窄，被浏览器放大就发糊。
    const ASPECT_W = 0.45; // 编码宽度 / 长边（1080/2400）
    const BUCKETS = [480, 720, 1024, 1440, 1800, 2400];

    /**
     * 自适应档：画布 CSS 尺寸 × devicePixelRatio = 面板真实能显示的设备像素，
     * 再向上取到常用档位（避免每次微调都重启一路编码器/会话）。
     */
    function autoMaxSize(canvas) {
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const cssW = (canvas && canvas.clientWidth) || 380;
      const cssH = (canvas && canvas.clientHeight) || 720;
      const need = Math.max(cssH * dpr, (cssW * dpr) / ASPECT_W);
      for (const s of BUCKETS) if (need <= s) return s;
      return 2400;
    }

    /** 码率跟着长边走：1080x2400@30fps 用 ~8Mbps 才不糊；小档位别浪费带宽 */
    function autoBitRate(maxSize) {
      return Math.min(8_000_000, Math.max(1_500_000, Math.round(maxSize * 4500)));
    }

    // 字体：原来只写 system-ui，在 DSH 的 Electron/Chromium 里会落到不含中文字形的默认字体，
    // 中文被逐字回退渲染（粗细/基线跳），小字号看着就是「发虚」。钉死一套有中文的字体族。
    const FONT = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif';

    // 字号自适应（坑 17）：面板宽 → 字大，窄 → 字小但不下于 13px。再加上 A− / A+ 手动微调
    // （存在 localStorage）。除了这里，所有尺寸都写成 em，跟着根字号一起缩放，不再到处写死 px。
    const FONT_MIN = 13;
    const FONT_MAX = 20;
    const FONT_ZOOM_KEY = 'dsh-android-phone.zoom';
    // 键盘直通开关（默认开，用户拍板 m02983）：只在画面聚焦时生效，不影响 DSH 自己的快捷键
    const KBD_KEY = 'dsh-android-phone.kbd'; // 旧版键盘开关的持久化键，现已不用（保留避免读旧值报错）
    const KEY_BATCH_MS = 8; // 键盘攒批窗口（原来 30ms，体感延迟明显）
    // 截图待命（绿）多少秒后自动退回灰（用户拍板 m02983：5 秒）
    const CAP_ARM_MS = 5000;
    function autoFont(panelWidth, zoom) {
      const w = panelWidth || 420; // 没量到宽度时按一个常见侧栏宽度算
      const base = Math.min(FONT_MAX, Math.max(FONT_MIN, w / 34));
      return Math.round(base * (zoom || 1) * 10) / 10;
    }

    // 颜色：**不能再靠继承**。原来写的是 color: 'var(--vscode-foreground, #d4d4d4)'，
    // 而 DSH 的侧栏并不定义 --vscode-foreground，于是浅色主题下整页文字落到 #d4d4d4
    // （浅灰配白底）→ 用户看到的「字体发灰」就是这一行。
    // 现在的做法：从**宿主自己的文字颜色**推出一套调色板（见 themePalette），
    // 深浅主题都不用猜；再把它作为 CSS 变量铺到根节点，下面所有样式只引用变量。
    const V = {
      fg: 'var(--dshp-fg, #d4d4d4)',
      soft: 'var(--dshp-fg-soft, #a8a8a8)',
      faint: 'var(--dshp-fg-faint, #8a8a8a)',
      line: 'var(--dshp-line, rgba(128,128,128,0.45))',
      fill: 'var(--dshp-fill, rgba(128,128,128,0.14))',
      fillStrong: 'var(--dshp-fill-strong, rgba(128,128,128,0.24))',
      lineStrong: 'var(--dshp-line-strong, rgba(110,110,110,0.85))',
    };

    /** 解析颜色 → [r,g,b,a]（真实浏览器里 getComputedStyle 给 rgb()/rgba()；顺手也认 #rgb/#rrggbb） */
    function parseColor(color) {
      const s = String(color || '').trim();
      const m = /rgba?\(([^)]+)\)/i.exec(s);
      if (m) {
        const p = m[1].split(',').map((x) => parseFloat(x));
        if (p.length >= 3 && p.slice(0, 3).every((n) => Number.isFinite(n))) {
          return [p[0], p[1], p[2], Number.isFinite(p[3]) ? p[3] : 1];
        }
        return null;
      }
      const h = /^#([0-9a-f]{3,8})$/i.exec(s);
      if (h) {
        let v = h[1];
        if (v.length === 3 || v.length === 4) v = v.split('').map((ch) => ch + ch).join('');
        if (v.length !== 6 && v.length !== 8) return null;
        const n = parseInt(v.slice(0, 6), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, v.length === 8 ? parseInt(v.slice(6), 16) / 255 : 1];
      }
      return null;
    }
    /** 把颜色按比例调透明（用来从宿主文字色派生弱化色/描边色） */
    function fade(color, a) {
      const p = parseColor(color);
      if (!p) return color;
      return `rgba(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])},${a})`;
    }
    function luminance(color) {
      const p = parseColor(color);
      if (!p) return null;
      return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255;
    }
    /** 没有宿主颜色可用时的兜底（按系统深浅主题走） */
    function fallbackFg() {
      const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
      return dark ? 'rgb(232,232,232)' : 'rgb(26,28,32)';
    }
    /**
     * 从宿主容器（我们的父元素）的实际文字色生成调色板。
     * 宿主的文字色本身就是「这个主题下正文该是什么色」，比自己猜 data-theme 稳。
     */
    function themePalette(rootEl) {
      let fg = null;
      try {
        const host = (rootEl && rootEl.parentElement) || document.body;
        if (host) fg = getComputedStyle(host).color;
      } catch { /* ignore */ }
      if (!fg || luminance(fg) === null) fg = fallbackFg();
      const dark = (luminance(fg) || 0.5) > 0.5;
      // 半透明描边/填充在深色主题下要更实一点，否则同样看不清
      return {
        fg,
        soft: fade(fg, dark ? 0.78 : 0.72),
        faint: fade(fg, dark ? 0.55 : 0.5),
        line: fade(fg, dark ? 0.34 : 0.3),
        lineStrong: fade(fg, dark ? 0.75 : 0.72),
        fill: fade(fg, dark ? 0.12 : 0.07),
        fillStrong: fade(fg, dark ? 0.2 : 0.13),
        dark,
      };
    }
    function paletteVars(p) {
      return {
        '--dshp-fg': p.fg,
        '--dshp-fg-soft': p.soft,
        '--dshp-fg-faint': p.faint,
        '--dshp-line': p.line,
        '--dshp-line-strong': p.lineStrong,
        '--dshp-fill': p.fill,
        '--dshp-fill-strong': p.fillStrong,
      };
    }

    // 面板内的 CSS（client 半边不许 import 样式文件，只能塞一段 <style> 进根节点）
    const PANEL_CSS = `
@keyframes dshPhoneRipple{from{opacity:.95;transform:scale(.5)}to{opacity:0;transform:scale(1.6)}}
`;

    const S = {
      root: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%',
        boxSizing: 'border-box', overflow: 'hidden', minWidth: 0,
        fontFamily: FONT, lineHeight: 1.55, color: V.fg, WebkitFontSmoothing: 'antialiased',
      },
      bar: { display: 'flex', flexWrap: 'wrap', gap: '0.4em', rowGap: '0.35em', alignItems: 'center', padding: '0.45em 0.5em 0.28em', minWidth: 0 },
      btn: { flexShrink: 0, whiteSpace: 'nowrap', borderStyle: 'solid', borderWidth: '1px', borderColor: V.lineStrong, background: V.fill, color: V.fg, borderRadius: '0.4em', padding: '0.34em 0.66em', fontSize: '1em', fontFamily: 'inherit', cursor: 'pointer' },
      btnPrimary: { borderStyle: 'solid', borderWidth: '1px', borderColor: 'rgba(255,73,0,0.9)', background: 'rgba(255,73,0,0.18)', fontWeight: 600 },
      btnGhost: { borderStyle: 'dashed', borderWidth: '1px', borderColor: V.lineStrong, background: 'transparent' },
      input: { flex: '1 1 7em', minWidth: '4.5em', borderStyle: 'solid', borderWidth: '1px', borderColor: V.lineStrong, background: V.fill, color: V.fg, borderRadius: '0.4em', padding: '0.32em 0.5em', fontSize: '1em', fontFamily: 'inherit' },
      // 舞台背景原来是纯黑 #111：画面按比例居中后左右留出来的就是「黑边」。改成跟随主题的
      // 透明面，留白处就是侧栏本来的底色，不再是两条黑杠。
      stage: { position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', overflow: 'hidden' },
      // width/height 100% + object-fit：完整(contain) / 铺满(cover) 两种口径都由浏览器缩放，
      // 点击坐标再用同一套换算（见 imageRect），所以两种模式下点哪儿就是哪儿。
      // 光标用系统默认箭头（用户 m25412：原来写 crosshair，跟 PC 上看到的不一样、觉得奇怪）。
      // 注意：这只是侧栏画布上的 CSS 光标；手机画面里若出现白色箭头，那是 Android 自己画的
      // 指针图标（scrcpy 注入 SOURCE_MOUSE 滚动事件时系统会显示），跟这条 CSS 无关。
      canvas: { display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: 'default' },
      empty: { padding: '1.2em', textAlign: 'center', color: V.soft, lineHeight: 1.8, fontSize: '1.02em' },
      pill: { padding: '0.14em 0.55em', borderRadius: 999, background: V.fill, borderStyle: 'solid', borderWidth: '1px', borderColor: V.lineStrong, fontSize: '0.86em', whiteSpace: 'nowrap', color: V.fg },
      pillOk: { background: 'rgba(46,204,113,0.18)', borderStyle: 'solid', borderWidth: '1px', borderColor: 'rgba(36,170,90,0.9)', fontWeight: 600 },
      pillBad: { background: 'rgba(255,80,80,0.16)', borderStyle: 'solid', borderWidth: '1px', borderColor: 'rgba(215,50,50,0.9)', fontWeight: 600 },
      pillWarn: { background: 'rgba(255,170,0,0.18)', borderStyle: 'solid', borderWidth: '1px', borderColor: 'rgba(200,120,0,0.9)', fontWeight: 600 },
      status: { padding: '0.35em 0.55em', borderTop: `1px solid ${V.line}`, display: 'flex', flexWrap: 'wrap', gap: '0.4em', rowGap: '0.3em', alignItems: 'center', fontSize: '0.86em', minWidth: 0, color: V.soft },
      notice: { padding: '0.45em 0.6em', fontSize: '0.92em', fontWeight: 600, color: V.fg, background: 'rgba(255,170,0,0.22)', borderLeft: '3px solid #e08600' },
      // 没画面时不再给一片白/黑：写清楚「为什么没画面、下一步该干什么」。
      overlay: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5em', textAlign: 'center', padding: '1.2em' },
      hintTitle: { fontSize: '1.15em', fontWeight: 700, color: V.fg },
      hintBody: { fontSize: '0.95em', color: V.soft, lineHeight: 1.85, maxWidth: '24em' },
      settingsWrap: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '0.5em 0.6em', display: 'flex', flexDirection: 'column', gap: '0.6em', background: 'transparent' },
      settingsBlock: { display: 'flex', flexDirection: 'column', gap: '0.35em', padding: '0.5em 0.55em', borderStyle: 'solid', borderWidth: '1px', borderColor: V.line, borderRadius: '0.5em' },
      skillList: { display: 'flex', flexDirection: 'column', gap: '0.3em', fontSize: '0.9em' },
      skillItem: { display: 'flex', flexDirection: 'column', gap: '0.1em', padding: '0.2em 0.35em', borderLeft: '2px solid ' + V.line },
      // 绿色 = 已生效/正在工作（键盘直通开、截图待命、长截图进行中），与「模型持有」同一个绿
      btnOk: { borderStyle: 'solid', borderWidth: '1px', borderColor: 'rgba(36,170,90,0.95)', background: 'rgba(46,204,113,0.22)', fontWeight: 600 },
      // 画面模式下拉（铺满 / 完整）：跟画质下拉同一套外观，但宽度固定一点
      select: { flexShrink: 0, borderStyle: 'solid', borderWidth: '1px', borderColor: V.lineStrong, background: V.fill, color: V.fg, borderRadius: '0.4em', padding: '0.3em 0.45em', fontSize: '1em', fontFamily: 'inherit', cursor: 'pointer' },
      // 键盘直通的落点：不能 display:none（否则无法聚焦），做成 1px 的透明盒子放在画面右下
      kbdSink: { position: 'absolute', left: 0, top: 0, width: '1px', height: '1px', opacity: 0, border: 0, padding: 0, margin: 0, background: 'transparent', pointerEvents: 'none' },
      ripple: { position: 'absolute', width: 34, height: 34, marginLeft: -17, marginTop: -17, borderRadius: '50%', borderStyle: 'solid', borderWidth: '2px', borderColor: 'rgba(255,73,0,0.95)', pointerEvents: 'none', animation: 'dshPhoneRipple 600ms ease-out forwards' },
    };

    const TAP_MAX_MS = 380;
    const TAP_MAX_MOVE = 14;

    /* ---------------------------------------------------------------- 小工具 */

    function apiBase(ctx) {
      try {
        const u = ctx.betterSidebar.hostRouteUrl('dsh-android-phone/api');
        if (typeof u === 'string' && u) return u.replace(/\/+$/, '');
      } catch { /* 回退 */ }
      return '/dsh-android-phone/api';
    }

    function codecFromSps(buf) {
      // Annex-B：[0,0,0,1,0x67, profile, constraints, level, ...]
      for (let i = 0; i + 4 < buf.length; i++) {
        if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
          const nal = buf[i + 2] === 1 ? i + 3 : i + 4;
          if ((buf[nal] & 0x1f) === 7 && nal + 3 < buf.length) {
            const hex = (n) => n.toString(16).padStart(2, '0');
            return `avc1.${hex(buf[nal + 1])}${hex(buf[nal + 2])}${hex(buf[nal + 3])}`;
          }
        }
      }
      return 'avc1.640028';
    }

    /**
     * 画面在元素盒里实际占了哪一块。object-fit: contain/cover 都按它算，
     * 所以「点哪儿 = 手机上哪儿」在两种模式下都成立（cover 时被裁掉的部分点不到，返回 null）。
     */
    function imageRect(box, natW, natH, fit) {
      const bw = box.width; const bh = box.height;
      if (!natW || !natH || !bw || !bh) return { left: 0, top: 0, width: bw, height: bh };
      const s = fit === 'cover' ? Math.max(bw / natW, bh / natH) : Math.min(bw / natW, bh / natH);
      const width = natW * s; const height = natH * s;
      return { left: (bw - width) / 2, top: (bh - height) / 2, width, height };
    }

    const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const clampRange = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

    /* ---------------------------------------------------------------- 视频解码 hook */

    /**
     * 上屏器 —— 借鉴 QtScrcpy 的渲染管线：**解码帧 → GL 纹理 → GPU 一次采样上屏**。
     *
     * 以前是 canvas2D `drawImage` 先把帧缩一遍、再由合成器按 CSS `object-fit` 缩第二遍（两次重采样），
     * 而且 canvas2D 在有些机器/显卡组合上会掉回软件栅格化，表现就是「画面发肉 + 掉帧」。
     * 这里把纹理尺寸固定成解码尺寸，缩放交给 GPU 的线性采样，中间不再拷一份。
     * 只有 canvas2D 一条路（2026-10-18 删掉 WebGL），坐标换算与命中判定共用同一套几何：
     * 两条路的「可见画面矩形」都等价于 CSS object-fit 的 cover/contain。
     */
    function createPresenter(canvas, getFit, getDpr) {
      const fitOf = () => {
        try { return (typeof getFit === 'function' ? getFit() : 'cover') || 'cover'; } catch { return 'cover'; }
      };
      const dprOf = () => {
        try {
          if (typeof getDpr === 'function') return Number(getDpr()) || 1;
          return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        } catch { return 1; }
      };

      // 上屏只有一条路：canvas2d。画布后备存储按「面板 devicePixel」算（不按视频原始尺寸），
      // 铺满/完整靠画布尺寸 + CSS object-fit + imageRect 换算，命中判定与上屏共用同一套几何。
      // 2026-10-18 删掉 WebGL 那条路（用户拍板）：它当初是为「全屏/大窗口」引进的（任意窗口尺寸
      // 只做一次纹理采样），该功能 m07268 已整条删除；侧栏尺寸下两条路每帧成本相同，而 canvas2d
      // 少 96 行，且大比例缩小时 imageSmoothingQuality:'high' 比 GL 的 LINEAR 更细腻。
      // 哪天要把画面放到全屏/大窗口，再按需加回 GPU 纹理路径。
      const ctx2d = (() => {
        try { return canvas.getContext('2d', { desynchronized: true }); } catch { return null; }
      })();
      return {
        kind: '2d',
        present: (frame, w, h) => {
          if (!ctx2d || !w || !h) return;
          const dpr = dprOf();
          const boxW = (canvas.clientWidth || w) * dpr;
          const boxH = (canvas.clientHeight || h) * dpr;
          const need = fitOf() === 'contain' ? Math.min(boxW / w, boxH / h) : Math.max(boxW / w, boxH / h);
          const s = Math.min(1, need) || 1;
          const cw = Math.max(2, Math.round(w * s));
          const ch = Math.max(2, Math.round(h * s));
          if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
          try { ctx2d.imageSmoothingEnabled = true; ctx2d.imageSmoothingQuality = 'high'; } catch { /* ignore */ }
          try { ctx2d.drawImage(frame, 0, 0, cw, ch); } catch { /* 关帧竞争 */ }
        },
        destroy: () => { /* nothing */ },
      };
    }

    function useVideoStream(canvasRef, base, running, quality, onStats, onError, fitRef) {
      const stopRef = useRef(null);
      useEffect(() => {
        if (!running) return undefined;
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        // 上屏走 createPresenter（只有 canvas2D 一条路，见其上方注释）。
        const presenter = createPresenter(canvas, () => (fitRef && fitRef.current) || 'cover', null);
        const ac = new AbortController();
        let decoder = null;
        let configPayload = null; // 最近一次 SPS/PPS（config 包）——建/重建解码器都要它
        let spsPending = false;   // 参数集还没随关键帧进过码流（annexb 必须带内，见 ③）
        let needKey = true;       // 下一个必须是关键帧才允许喂进解码器
        let dropped = 0;          // 解码报错次数
        let skipped = 0;          // 为了追延迟主动丢掉的帧数
        let pollTimer = null;
        let closed = false;
        let frames = 0;
        let bytes = 0;
        let last = nowMs();
        let showFps = 0;
        let showKbps = 0;
        let pollFail = 0;
        // 画面链路的自测：pending 记「帧交给解码器」的时刻，output 回调里算差 ⇒ 排队+解码耗时。
        const pending = new Map();
        let decodeEwma = 0;
        let lastOut = 0;

        /**
         * 把一帧交给上屏器。
         *
         * 旧实现在这里算「面板设备像素 + 铺满/完整口径」的后备尺寸，然后 drawImage 缩一遍、
         * 合成器再按 object-fit 缩一遍 —— 两次重采样。现在缩放只发生在 GPU 采样那一步
         * （见 createPresenter），这里只管把帧和它的原始尺寸递下去。
         */
        const draw = (source, w, h) => {
          presenter.present(source, w, h);
        };

        const statTimer = setInterval(() => {
          const t = nowMs();
          const dt = t - last;
          if (dt > 0) { showFps = (frames * 1000) / dt; showKbps = (bytes * 8) / dt; }
          last = t; frames = 0; bytes = 0;
          onStats({
            fps: showFps, kbps: showKbps, mode: decoder ? 'video' : 'idle', skipped, dropped,
            // 画面链路的两个自测指标（侧栏底栏显示，用来分清「是手机慢/网络慢」还是「浏览器慢」）：
            decodeMs: decodeEwma,             // 从交给解码器到解出画面的时间（含排队+解码）
            frameAgeMs: lastOut ? nowMs() - lastOut : null,  // 距上一张解出的画面过了多久
          });
        }, 1000);

        const startPoll = (reason) => {
          if (pollTimer || closed) return;
          onError(`${reason}，已退回「每秒 2 张快照」模式`);
          const tick = async () => {
            try {
              const r = await fetch(`${base}/snapshot?scale=0.5`, { cache: 'no-store', signal: ac.signal });
              if (!r.ok) throw new Error(`快照 HTTP ${r.status}`);
              const blob = await r.blob();
              const bmp = await createImageBitmap(blob, { resizeQuality: 'high' });
              draw(bmp, bmp.width, bmp.height);
              if (bmp.close) bmp.close();
              pollFail = 0;
            } catch (e) {
              if (!closed) { pollFail += 1; if (pollFail === 3) onError(`快照也失败：${e.message}`); }
            }
          };
          tick();
          pollTimer = setInterval(tick, 500);
        };

        const consume = async () => {
          // 自适应档：按画布真实设备像素推 maxSize/bitRate（面板缩放变了就换档，见 deps）
          const effMax = quality.maxSize > 0 ? quality.maxSize : autoMaxSize(canvas);
          const effBit = quality.bitRate > 0 ? quality.bitRate : autoBitRate(effMax);
          const res = await fetch(`${base}/video?maxSize=${effMax}&maxFps=${quality.maxFps}&bitRate=${effBit}`, { signal: ac.signal, cache: 'no-store' });
          if (!res.ok || !res.body) throw new Error(`视频流 HTTP ${res.status}`);
          onStats({ mode: 'video', width: Number(res.headers.get('X-Video-Width')) || 0, height: Number(res.headers.get('X-Video-Height')) || 0, device: res.headers.get('X-Device-Name') || '' });
          onError('');
          const reader = res.body.getReader();
          let buf = new Uint8Array(0);
          const take = (n) => {
            const out = buf.subarray(0, n);
            buf = buf.subarray(n);
            return out;
          };
          // 解码里任何一步抛出去（比如上面那个关键帧错误）都要把响应体取消掉，
          // 否则宿主还在往这条没人读的 socket 里推帧，内存一路涨、流也不会停。
          try {
          while (!closed) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            const merged = new Uint8Array(buf.length + value.length);
            merged.set(buf, 0); merged.set(value, buf.length);
            buf = merged;
            while (buf.length >= FRAME_HEADER) {
              const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
              const size = view.getUint32(0);
              const flag = view.getUint8(4);
              if (size === 0 || buf.length < FRAME_HEADER + size) break;
              const ptsUs = Number(view.getBigUint64(5));
              const payload = take(FRAME_HEADER + size).subarray(FRAME_HEADER);
              bytes += payload.length;

              // ① config 包（SPS/PPS，flag=1）**只能用来建/重建解码器，绝不能当帧喂**。
              //    原来它走的是下面那个 decode 分支、被标成 type:'delta'，于是刚 configure 完就收到
              //    非关键帧 → 同步抛 "A key frame is required after configure() or flush()"，
              //    整条 H.264 通道崩掉、降级成「每秒 2 张快照」——侧栏那条黄色报错就是这么来的。
              if (flag & 1) {
                configPayload = payload;
                needKey = true;
                spsPending = true;          // 新参数集要连同下一个关键帧一起喂（见 ③）
                if (decoder) { try { decoder.close(); } catch { /* ignore */ } decoder = null; }
                continue;
              }
              if (!configPayload) continue;                       // 还没拿到 SPS/PPS，先攒着
              if (typeof window.VideoDecoder !== 'function') throw new Error('这个环境没有 WebCodecs（VideoDecoder）');
              const isKey = !!(flag & 2);
              if (needKey && !isKey) continue;                    // configure 之后第一帧必须是关键帧，否则解码器拒收

              if (!decoder) {
                decoder = new window.VideoDecoder({
                  output: (frame) => {
                    frames += 1;
                    lastOut = nowMs();
                    const queuedAt = pending.get(frame.timestamp);
                    if (queuedAt != null) {
                      pending.delete(frame.timestamp);
                      const dt = nowMs() - queuedAt;
                      decodeEwma = decodeEwma ? decodeEwma * 0.75 + dt * 0.25 : dt;
                    }
                    draw(frame, frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight);
                    frame.close();
                  },
                  error: (e) => {
                    // 单帧花屏不该把整条流降级成快照：关掉解码器，等下一个关键帧重新 configure
                    if (closed) return;
                    try { decoder?.close?.(); } catch { /* ignore */ }
                    decoder = null; needKey = true; dropped += 1;
                    if (dropped > 40) startPoll(`解码反复失败（${e.message || e}）`);
                  },
                });
                decoder.configure({ codec: codecFromSps(configPayload), avc: { format: 'annexb' }, optimizeForLatency: true });
                spsPending = true;          // 刚建的解码器还没见过 SPS/PPS（见 ③）
              }

              if (decoder.state === 'configured') {
                // ② 落后太多就丢掉非关键帧直接追到最新画面，否则解码队列越积越长，
                //    「鼠标都松手了画面还在滚」的罪魁之一就是这个积压。
                // 遥控场景只允许 1~2 帧在飞：积压超过 2 帧就直接丢（丢的是旧帧，画面立刻追上手指）。
                // 旧值 12 帧 @30fps = 400ms 延迟，这正是「画面不跟手」的主因。
                if (decoder.decodeQueueSize > 4 && !isKey) { skipped += 1; } else {
                  // ③ annexb 模式下 configure() 的 codec 字符串里**没有参数集**，SPS/PPS 必须出现在
                  //    码流里。scrcpy 把 SPS/PPS 放在**带外**的 config 包，所以这里要把它拼到关键帧
                  //    前面。不拼的后果实测极具迷惑性：解码器 state 是 configured、feed 了几十个包、
                  //    error 回调一次都不响，但 output 一帧都不出（侧栏表现＝黑屏，且不像报错）。
                  //    差分验证见 scripts/verify-video-decode.mjs：带外 0 帧 / 带内 21 帧（808×1800）。
                  let data = payload; let inBand = false;
                  if (isKey && spsPending && configPayload) {
                    const merged = new Uint8Array(configPayload.length + payload.length);
                    merged.set(configPayload, 0); merged.set(payload, configPayload.length);
                    data = merged; inBand = true;
                  }
                  pending.set(ptsUs / 1000, nowMs());
                  if (pending.size > 60) {                       // 别为丢掉/不出的帧攒内存
                    let n = 0;
                    for (const k of pending.keys()) { pending.delete(k); if (++n >= 30) break; }
                  }
                  decoder.decode(new window.EncodedVideoChunk({
                    type: isKey ? 'key' : 'delta', timestamp: ptsUs / 1000, data,
                  }));
                  if (inBand) spsPending = false;
                  needKey = false;
                }
                while (!closed && decoder.decodeQueueSize > 4) await new Promise((r) => setTimeout(r, 4));
              } else {
                try { decoder.close(); } catch { /* ignore */ }
                decoder = null; needKey = true;                     // configure 失败：等下一个关键帧再来
              }
            }
          }
          } finally {
            try { reader.cancel(); } catch { /* ignore */ }
          }
        };

        // 断线自动重连：会话重启（换画质 / 自愈 / 被别的消费者抢）时宿主会结束这条流。
        // 以前这里只在异常时 startPoll、正常结束时静默退出 ⇒ 画面冻在最后一帧、底栏 0 fps，
        // 人怎么操作手机都不动（真机复现：探针重启会话后侧栏冻住）。现在退避重连，8 次后才降级快照。
        let tries = 0;
        const runLoop = async () => {
          for (;;) {
            if (closed) return;
            const t0 = Date.now();
            try {
              await consume();
            } catch (e) {
              if (closed || e.name === 'AbortError') return;
              onError(`取流失败（${e.message || e}）`);
            }
            if (closed) return;
            if (Date.now() - t0 > 3000) tries = 0;   // 稳定跑过 3 秒就重置计数
            tries += 1;
            if (tries > 8) { startPoll('视频流反复中断，已改用快照'); return; }
            onError(`视频流中断，正在重连（第 ${tries} 次）…`);
            await new Promise((r) => setTimeout(r, Math.min(2000, 250 * tries)));
          }
        };
        runLoop();

        const stop = () => {
          closed = true;
          clearInterval(statTimer);
          if (pollTimer) clearInterval(pollTimer);
          try { decoder?.close?.(); } catch { /* ignore */ }
          try { ac.abort(); } catch { /* ignore */ }
          onStats({ fps: 0, kbps: 0, mode: 'idle' });
        };
        stopRef.current = stop;
        return stop;
      }, [running, quality.maxSize, quality.maxFps, quality.bitRate]);
      return () => { try { stopRef.current?.(); } catch { /* ignore */ } };
    }

    /* ---------------------------------------------------------------- 画面组件（含输入注入） */

    function Screen(props) {
      const { api, quality, pushNotice, running, setRunning, view, setView, onStats, onHuman, onPanelFocus, overlay, emptyText } = props;
      // 暂停 / 画面模式（铺满·完整）统一由顶栏控制：状态提到 Panel 里，
      // 这里只读。2026-10-17 用户要求把原来浮在画面右下角的三个按钮全部挪到顶栏。
      const fit = view === 'contain' ? 'contain' : 'cover';
      const [stats, setStats] = useState({ fps: 0, kbps: 0, mode: 'idle', width: 0, height: 0, device: '' });
      const [err, setErr] = useState('');
      const [marks, setMarks] = useState([]);
      const fitRef = useRef('cover');
      fitRef.current = fit;
      const canvasRef = useRef(null);
      const stageRef = useRef(null);
      const gesture = useRef(null);
      const seq = useRef(0);
      // 输入事件**必须按顺序**到达宿主：宿主是并发处理 HTTP 的，MOVE 抢在 DOWN 前面会被服务端的
      // PointersState 丢掉（手指状态直接乱掉）。所以串成一条单飞队列，一次只有一个在飞；
      // 队列里的 MOVE 只保留最后一个（位置事件天然可丢），但 DOWN/UP 一个都不能丢。
      const queue = useRef({ busy: false, q: [] });
      // 滚轮：累计**格数**（不是像素），16ms 一帧发一次，同样单飞 + 只留最新
      const wheelRef = useRef({ acc: 0, timer: null, busy: false });
      // 滚轮事件要带坐标（Android 把滚动投给那个点下面的控件）：记最后一次鼠标位置
      const hoverRef = useRef({ nx: 0.5, ny: 0.5 });
      // 右键 = 双指缩放（QtScrcpy 手感）。两根手指沿竖直方向对称张开：
      //   半距 d 变大 = 手指分开 = 放大；按住右键滚轮 = 按格步进缩放。
      // 双指：第二根手指也发 DOWN(0)，不能发 POINTER_DOWN(5) —— 原因见 pinchSend 上方注释。
      const pinchRef = useRef(null);
      const PINCH_ID_A = 11;
      const PINCH_ID_B = 12;
      const PINCH_BASE_D = 0.05;    // 起始半距（相对视频高度）≈ 1800 高时 90px
      const PINCH_MIN_D = 0.006;
      const PINCH_MAX_D = 0.45;
      const PINCH_WHEEL_STEP = 0.012; // 滚轮一格 = 半距 ±1.2% 视频高度
      const MOVE_MERGE_MS = 8;      // 两个 MOVE 至少隔 8ms（~120Hz 上限，别把 HTTP 打爆）
      const MOVE_EPS = 0.0015;      // 相对位移小于它就不发（去抖：轻点别抖出一串 MOVE）
      const DRAG_EPS = 0.006;       // 超过它才算"在拖"（≈ 1080 × 0.006 = 6.5px）
      const WHEEL_PER_DETENT = 100; // 一个滚轮格 ≈ 100 像素 deltaY（Windows/Chrome 的常见值）
      // 单次最多送 3 格（真机实测 1 格 = 192px，3 格 = 576px，约 1/4 屏）。
      // 之前是 12 格：/action 卡一下就会攒满 12 格一次补发 = 2300px 的跳变，
      // 用户描述的「本来固定长度，过一会再滚就滚过头」就是这个（见 PROBE-wheel-units.json）。
      const WHEEL_MAX_NOTCHES = 3;

      useVideoStream(canvasRef, api.base, running, quality, setStats, setErr, fitRef);
      useEffect(() => { if (typeof onStats === 'function') onStats(stats); }, [stats, onStats]);

      const addMark = useCallback((x, y) => {
        const id = (seq.current += 1);
        setMarks((m) => [...m.slice(-4), { id, x, y }]);
        setTimeout(() => setMarks((m) => m.filter((k) => k.id !== id)), 620);
      }, []);

      /** 屏幕坐标 → 0~1 相对坐标（宿主按设备像素换算，所以这里不关心分辨率） */
      const toRel = useCallback((ev) => {
        const c = canvasRef.current;
        if (!c) return null;
        const r = c.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        // 必须按「画面实际占的那块」换算：cover 模式下画面比元素盒大、还被居中裁掉一截，
        // 用元素盒直接归一化会让点击整体偏移。
        const ir = imageRect(r, c.width || stats.width, c.height || stats.height, fitRef.current);
        const x = ev.clientX - r.left - ir.left;
        const y = ev.clientY - r.top - ir.top;
        if (x < 0 || y < 0 || x > ir.width || y > ir.height) return null; // 点在留白/裁掉的部分
        return { nx: x / ir.width, ny: y / ir.height };
      }, [stats.width, stats.height]);

      const send = useCallback(async (body, quiet, silent) => {
        try {
          // 人一碰画面就算接管（模型的动作会被宿主守门人挡下，直到交还或租约到期）
          if (typeof onHuman === 'function') { try { await onHuman(); } catch { /* ignore */ } }
          const r = await fetch(`${api.base}/action`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ human: true, ...body }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
          if (!quiet) pushNotice(`已执行 ${body.action}${body.key ? ` ${body.key}` : ''}`);
          return j;
        } catch (e) {
          // silent：拖拽/滚轮这类高频事件失败不弹条（否则一次卡顿能刷满一屏提示）
          if (!silent) pushNotice(`动作失败：${e.message}`);
          return null;
        }
      }, [api.base, pushNotice, onHuman]);

      /** 单飞队列：保证 DOWN → MOVE… → UP 的顺序，MOVE 过多时只留最后一个 */
      const pump = useCallback(async () => {
        const s = queue.current;
        if (s.busy) return;
        s.busy = true;
        try {
          while (s.q.length) {
            const body = s.q.shift();
            await send(body, true, true);
          }
        } finally {
          s.busy = false;
        }
      }, [send]);

      const pushInput = useCallback((body) => {
        const s = queue.current;
        // 上一个 MOVE 还没发出去，就把它换成最新的（位置事件：旧位置没有任何价值）。
        // 双指（raw 有值）不能合并：两根手指各一条 MOVE，合并会把另一根的那条吃掉。
        if (s.busy && body.phase === 'move' && body.raw === undefined) {
          const last = s.q[s.q.length - 1];
          if (last && last.phase === 'move' && last.raw === undefined) { s.q[s.q.length - 1] = body; return; }
        }
        if (s.q.length > 64) {
          // 兜底：极端卡顿时别无限攒（只丢 MOVE，DOWN/UP 必须留）
          const i = s.q.findIndex((b) => b.phase === 'move');
          if (i >= 0) s.q.splice(i, 1); else s.q.shift();
        }
        s.q.push(body);
        void pump();
      }, [pump]);

      // 双指：**每根手指都发 ACTION_DOWN(0)/ACTION_UP(1)**，MOVE 发 2。
      // 不要自己发 5/6 —— scrcpy v5.0.1 的 Controller.injectTouch 只在 pointerCount>1 时
      // 把 DOWN/UP 改写成 ACTION_POINTER_DOWN/UP|(index<<8)；5/6 会被原样透传，
      // Android 认为「index 0 又按下了一次」→ 整条事件被丢弃（真机实测：相册不缩放）。
      // phase 只为让 pushInput 的 MOVE 合并逻辑生效（位置事件可丢，DOWN/UP 不能丢）。
      const pinchSend = useCallback((raw, nx, ny, pointerId) => {
        const phase = raw === 2 ? 'move' : raw === 1 ? 'up' : 'down';
        pushInput({ action: 'touch', raw, phase, nx, ny, pointerId });
      }, [pushInput]);

      const onPointerDown = (ev) => {
        const rel = toRel(ev);
        if (!rel) return;
        ev.preventDefault();
        // 点画面 = 把键盘焦点交给隐藏输入框（键盘直通）：之后直接打字就进手机
        if (typeof onPanelFocus === 'function') { try { onPanelFocus(); } catch { /* ignore */ } }
        try { ev.currentTarget.setPointerCapture?.(ev.pointerId); } catch { /* ignore */ }
        hoverRef.current = rel;
        // 右键 = 双指（QtScrcpy 手感）：按下就摆出两根手指，上下拖 = 手指张开/收拢 = 缩放；
        // 按住右键再滚轮 = 步进缩放；右键点一下不拖 = 手机「返回」（在 onPointerUp 里判）。
        if (ev.button === 2) {
          gesture.current = null;
          const p = {
            cx: rel.nx, cy: rel.ny, y0: rel.ny, d: PINCH_BASE_D, t0: nowMs(), moved: 0, sentAt: 0,
          };
          pinchRef.current = p;
          pinchSend(0, p.cx, clamp01(p.cy - p.d), PINCH_ID_A);
          pinchSend(0, p.cx, clamp01(p.cy + p.d), PINCH_ID_B);
          return;
        }
        if (ev.button !== 0) return;
        gesture.current = { t0: nowMs(), down: rel, last: rel, moved: 0, dragging: false, sentMoveAt: 0 };
        const sr = stageRef.current?.getBoundingClientRect();
        if (sr) addMark(ev.clientX - sr.left, ev.clientY - sr.top);
        // 立刻按下：手机里的手指与鼠标同时按下。轻点/长按/拖拽全部交给 Android 自己判定，
        // 我们不再猜"多久算长按""挪多少算拖拽"（旧实现那套阈值正是拖拽不跟手的根源）。
        pushInput({ action: 'touch', phase: 'down', nx: rel.nx, ny: rel.ny });
      };

      const onPointerMove = (ev) => {
        const rel = toRel(ev);
        if (!rel) return;
        hoverRef.current = rel;
        // 双指缩放中：鼠标上移 = 两指分开 = 放大，下移 = 收拢 = 缩小
        const p = pinchRef.current;
        if (p) {
          const d = clampRange(p.d + (p.y0 - rel.ny), PINCH_MIN_D, PINCH_MAX_D);
          const t = nowMs();
          if (Math.abs(d - p.d) < 0.0005) return;
          p.d = d;
          if (t - p.sentAt < MOVE_MERGE_MS) return;
          p.sentAt = t;
          pinchSend(2, p.cx, clamp01(p.cy - p.d), PINCH_ID_A);
          pinchSend(2, p.cx, clamp01(p.cy + p.d), PINCH_ID_B);
          return;
        }
        const g = gesture.current;
        if (!g) return;
        g.moved += Math.abs(rel.nx - g.last.nx) + Math.abs(rel.ny - g.last.ny);
        g.last = rel;
        if (!g.dragging && g.moved > DRAG_EPS) g.dragging = true;
        const t = nowMs();
        if (t - g.sentMoveAt < MOVE_MERGE_MS) return;
        // 拖动中：每个 MOVE 都回放（真拖拽）；没在拖就不发，避免轻点抖出一串 MOVE
        if (!g.dragging) {
          if (Math.abs(rel.nx - g.down.nx) + Math.abs(rel.ny - g.down.ny) < MOVE_EPS) return;
          g.dragging = true;
        }
        g.sentMoveAt = t;
        pushInput({ action: 'touch', phase: 'move', nx: rel.nx, ny: rel.ny });
      };

      const onPointerUp = (ev) => {
        // 双指：先 POINTER_UP 第二根，再 UP 第一根；没动过就当成「右键 = 返回」
        const p = pinchRef.current;
        if (p) {
          pinchRef.current = null;
          pinchSend(1, p.cx, clamp01(p.cy + p.d), PINCH_ID_B);
          pinchSend(1, p.cx, clamp01(p.cy - p.d), PINCH_ID_A);
          if (Math.abs(p.d - PINCH_BASE_D) < 0.004 && nowMs() - p.t0 < 400) {
            void send({ action: 'key', key: 'BACK' }, true);
          }
          return;
        }
        const g = gesture.current;
        gesture.current = null;
        if (!g) return;
        // 抬起必须在「最后已知位置」：鼠标划出画布时 toRel 返回 null，而漏发一个 UP
        // 会让手机里的手指一直按着（界面卡死）—— 所以这里永远发 UP。
        const rel = toRel(ev) || g.last;
        pushInput({ action: 'touch', phase: 'up', nx: rel.nx, ny: rel.ny });
      };

      // 滚轮：16ms 内的增量合并成一次 wheel；同一时刻只允许一个在飞，飞回来还有积压立刻追发。
      // 关键是**送格数**而不是合成滑动手势 —— INJECT_SCROLL_EVENT 由 Android 自己滚，
      // 一格里还能带小数，所以精密触控板的小步滚动也不会一格一格地跳。
      const flushWheel = useCallback(() => {
        const w = wheelRef.current;
        if (w.busy || !w.acc) return;
        const acc = w.acc;
        const notches = Math.max(-WHEEL_MAX_NOTCHES, Math.min(WHEEL_MAX_NOTCHES, acc));
        // 只留「不到一格」的小数尾巴，超上限的部分**丢掉**而不是留到下一帧补发：
        // 补发会把一次网络抖动攒成一次大跳变，手感就变成「越滚越远」。
        const rest = acc - notches;
        w.acc = Math.abs(rest) > 1 ? Math.sign(rest) : rest;
        w.busy = true;
        const { nx, ny } = hoverRef.current;
        Promise.resolve(send({ action: 'wheel', notches, nx, ny }, true, true)).finally(() => {
          w.busy = false;
          if (wheelRef.current.acc) flushWheel();
        });
      }, [send]);

      const onWheel = (ev) => {
        // Ctrl+滚轮 = 调面板字号（冒泡给面板处理，别当滚动发到手机）
        if (ev.ctrlKey) return;
        ev.preventDefault();
        // 按住右键（双指已摆好）时滚轮 = 步进缩放：往上滚 = 放大
        const p = pinchRef.current;
        if (p) {
          const n = ev.deltaMode === 1 ? ev.deltaY / 3 : ev.deltaMode === 2 ? ev.deltaY * 10 : ev.deltaY / WHEEL_PER_DETENT;
          p.d = clampRange(p.d - n * PINCH_WHEEL_STEP, PINCH_MIN_D, PINCH_MAX_D);
          pinchSend(2, p.cx, clamp01(p.cy - p.d), PINCH_ID_A);
          pinchSend(2, p.cx, clamp01(p.cy + p.d), PINCH_ID_B);
          return;
        }
        const w = wheelRef.current;
        const rel = toRel(ev);
        if (rel) hoverRef.current = rel;
        // 统一折成「格」：deltaMode 1 = 行（一行算 1/3 格），0 = 像素（一格 100px），2 = 页
        const notches = ev.deltaMode === 1 ? ev.deltaY / 3 : ev.deltaMode === 2 ? ev.deltaY * 10 : ev.deltaY / WHEEL_PER_DETENT;
        w.acc += notches;
        if (!w.timer) w.timer = setTimeout(() => { w.timer = null; flushWheel(); }, 16);
      };

      useEffect(() => () => { const w = wheelRef.current; if (w.timer) clearTimeout(w.timer); }, []);

      const stage = h('div', { ref: stageRef, style: { ...S.stage, borderRadius: '0.4em', margin: '0 0.45em' } },
        running
          ? h('canvas', {
            ref: canvasRef, style: { ...S.canvas, objectFit: fit },
            onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onWheel,
            // 右键 = 双指缩放 / 点一下 = 手机「返回」（都在 onPointerDown/Up 里处理）；
            // 侧栏里右键本来是浏览器菜单，这里只负责拦掉菜单。
            onContextMenu: (ev) => { ev.preventDefault(); },
            width: stats.width || 360, height: stats.height || 780,
          })
          : h('div', { style: S.empty }, emptyText || '画面已暂停。顶栏点「▶ 播放」继续接收视频。'),
        overlay || null,
        marks.map((m) => h('div', { key: m.id, style: { ...S.ripple, left: m.x, top: m.y } })),
      );

      return h('div', { style: S.root },
        stage,
        err ? h('div', { style: S.notice }, err) : null,
      );
    }

    /* ---------------------------------------------------------------- 面板 */

    // 工具栏「▶ 打开」的候选 App 缓存：设置页读写后刷新，避免每次渲染都发请求。
    let APPS_CACHE = null;
    async function fetchSettings(ctx) {
      try {
        const r = await fetch(`\${apiBase(ctx)}/settings`, {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get' }),
        });
        const j = await r.json();
        if (j && j.ok) { APPS_CACHE = j; return j; }
      } catch { /* 读不到就用上次的 */ }
      return APPS_CACHE;
    }
    function Panel(props) {
      const { ctx } = props;
      const api = useMemo(() => ({ base: apiBase(ctx) }), [ctx]);
      const [status, setStatus] = useState(null);
      // /status 的 ref 镜像：剪贴板轮询要读最新值，用 state 会多一层闭包过期问题
      const statusRef = useRef(null);
      const [notice, setNotice] = useState('');
      const [quality, setQuality] = useState('auto');
      const [busy, setBusy] = useState('');
      const [shot, setShot] = useState(null);
      // 画面模式：cover 铺满（默认）/ contain 完整（「全屏」「大窗口」两条路 2026-10-18 用户拍板删掉）
      const [view, setView] = useState('cover');
      const [showSettings, setShowSettings] = useState(false);
      // 工具栏「▶ 打开」的候选 App（用户 2026-10-18：候选可配置，默认 6 个）。设置页加载/保存后会刷新。
      const [apps, setApps] = useState(() => (APPS_CACHE && APPS_CACHE.settings && Array.isArray(APPS_CACHE.settings.apps) && APPS_CACHE.settings.apps.length ? APPS_CACHE.settings.apps : DEFAULT_APPS));
      const [launchPkg, setLaunchPkg] = useState(() => (APPS_CACHE && APPS_CACHE.settings && APPS_CACHE.settings.launchPkg) || JD_PACKAGE);
      useEffect(() => {
        if (showSettings) return undefined;   // 设置页开着时不抢它的请求
        let dead = false;
        fetchSettings(ctx).then((j) => {
          if (dead || !j || !j.settings) return;
          setApps(Array.isArray(j.settings.apps) && j.settings.apps.length ? j.settings.apps : DEFAULT_APPS);
          setLaunchPkg(j.settings.launchPkg || JD_PACKAGE);
        });
        return () => { dead = true; };
      }, [showSettings]);   // ⚙ 设置页（截图地址 / 自动清理 / skill）
      const [running, setRunning] = useState(true);
      // 截图机：idle（灰）→ 单击截一张 → armed（绿，5 秒内按 L 开始长截图）→ capturing（⏹ 停止）
      const [cap, setCap] = useState('idle');
      const capRef = useRef('idle');
      const armTimer = useRef(null);
      const [longInfo, setLongInfo] = useState(null);
      // 键盘直通：没有开关了（用户 2026-10-17：映射做好后按钮可以删），
      // 只要面板有焦点就打进手机；点 DSH 别处自动失效。
      const kbuf = useRef({ s: '', timer: null });
      const [videoStats, setVideoStats] = useState({ fps: 0, kbps: 0 });
      const [owner, setOwner] = useState('ai');
      const ownerRef = useRef('ai'); // claimHuman 里避免每点一下都发一次 /takeover（多一个往返就是多一份手感延迟）
      useEffect(() => { ownerRef.current = owner; }, [owner]);
      // 字号：宽度自适应 + 手动微调（A− / A+），免得「看不清」只能去改代码（坑 17）
      const [zoom, setZoom] = useState(() => {
        try { return Number(localStorage.getItem(FONT_ZOOM_KEY)) || 1; } catch { return 1; }
      });
      const [panelW, setPanelW] = useState(0);
      const rootRef = useRef(null);
      // 调色板：从宿主给我们的实际文字色派生（见 themePalette）。宿主切深浅主题时重取。
      const [palette, setPalette] = useState(() => themePalette(null));
      // 双保险：把调色板同时用 style.setProperty 写到根元素上（React 对自定义属性的 diff 历史上不稳，
      // 一旦漏写，所有引用 var(--dshp-*) 的边框/填充都会失效 —— 用户看到的就是「按钮框线没了」）。
      useIsoLayoutEffect(() => {
        const el = rootRef.current;
        if (!el || !el.style || typeof el.style.setProperty !== 'function') return;
        const vars = paletteVars(palette);
        for (const k of Object.keys(vars)) {
          try { el.style.setProperty(k, vars[k]); } catch { /* ignore */ }
        }
      }, [palette]);
      useEffect(() => {
        const el = rootRef.current;
        if (!el) return undefined;
        const sync = () => {
          const p = themePalette(el);
          setPalette((prev) => (prev && prev.fg === p.fg ? prev : p));
        };
        sync();
        let mo = null;
        try {
          mo = new MutationObserver(sync);
          mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-mode'] });
          if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-mode'] });
        } catch { /* ignore */ }
        const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
        if (mq && mq.addEventListener) mq.addEventListener('change', sync);
        return () => {
          if (mo) mo.disconnect();
          if (mq && mq.removeEventListener) mq.removeEventListener('change', sync);
        };
      }, []);
      // 必须 useLayoutEffect：useEffect 是「画完再量」，首帧会用 panelW=0 算出的 13px 字号，
      // 量到真实宽度后再跳到正常字号 —— 整块面板闪一下，边框/文字在那一下里看起来是「虚」的。
      useIsoLayoutEffect(() => {
        const el = rootRef.current;
        if (!el) return undefined;
        setPanelW(el.clientWidth || 0);
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver((entries) => { for (const e of entries) setPanelW(e.contentRect.width); });
        ro.observe(el);
        return () => ro.disconnect();
      }, []);
      const bumpZoom = useCallback((delta) => {
        setZoom((z) => {
          const v = Math.min(2, Math.max(0.8, Math.round((Number(z) + delta) * 10) / 10));
          try { localStorage.setItem(FONT_ZOOM_KEY, String(v)); } catch { /* ignore */ }
          return v;
        });
      }, []);
      const fontPx = autoFont(panelW, zoom);

      const pushNotice = useCallback((msg) => { setNotice(msg || ''); }, []);

      const getJson = useCallback(async (path, init) => {
        const r = await fetch(`${api.base}${path}`, { cache: 'no-store', ...(init || {}) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      }, [api.base]);

      const refresh = useCallback(async () => {
        try {
          const st = await getJson('/status');
          statusRef.current = st;
          setStatus(st);
          if (st?.owner) { ownerRef.current = st.owner; setOwner(st.owner); }
          void pullClipboard();
        } catch (e) { setNotice(`状态获取失败：${e.message}`); }
      }, [getJson]);

      useEffect(() => { refresh(); }, [refresh]);
      useEffect(() => {
        const t = setInterval(() => { refresh(); }, 5000);
        return () => clearInterval(t);
      }, [refresh]);

      // 剪贴板单独走一条快轮询（1.2s）：手机上复制完切到电脑，不该等 5 秒。
      // 只读宿主缓存（phone_clipboard status），不碰设备、不发 adb。
      useEffect(() => {
        const t = setInterval(() => {
          void getJson('/clipboard', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'status', human: true }),
          }).then((j) => {
            if (!j) return;
            statusRef.current = { ...(statusRef.current || {}), clipboard: { text: j.text || '', at: j.at || 0 } };
            void pullClipboard();
          }).catch(() => { /* 剪贴板读失败不打扰用户 */ });
        }, 1200);
        return () => clearInterval(t);
      }, [getJson]);

      // 跟随侧边栏：会话由 Screen 的 GET /video 一起拉起来 —— 只有那条请求知道画布真实占多少设备像素，
      // 会把 maxSize / bitRate 一起带上。这里以前还会再 POST 一次 /session，用的是配置里的默认尺寸，
      // 结果「先按默认起一路、再被 /video 用另一个尺寸重启一次」（坑 15）；去掉后只起一次。
      // 关闭侧栏不主动停 —— 宿主按「无订阅者 + 空闲」自己收（idleStopMs），免得模型跑到一半被掐。

      /** 人一动就算接管：先把控制权抢过来（模型的动作会被宿主的守门人拒绝），再注入动作。 */
      const claimHuman = useCallback(async () => {
        // 已经是人的了就别再发一次 —— 每次点击都多一个 HTTP 往返会直接反映到「点完等多久」的手感上
        if (ownerRef.current === 'human') return 'human';
        try {
          const j = await getJson('/takeover', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: '侧栏操作' }),
          });
          if (j?.owner) { ownerRef.current = j.owner; setOwner(j.owner); }
          return j?.owner || 'human';
        } catch { return null; /* 抢不到也让动作继续 */ }
      }, [getJson]);

      const post = useCallback(async (path, body, label) => {
        setBusy(label || '');
        try {
          const j = await getJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body }) });
          setNotice('');
          return j;
        } catch (e) {
          setNotice(`${label || path} 失败：${e.message}`);
          return null;
        } finally { setBusy(''); }
      }, [getJson]);

      // 侧栏里的点击/输入都带 human:true，宿主按「人」记账（不再撞 AI 的守门人）
      const act = useCallback(async (body, label) => {
        await claimHuman();
        return await post('/action', { ...body, human: true }, label);
      }, [post, claimHuman]);

      /* ---- 剪贴板同步（用户 2026-10-18 m07459 第 6 条：只加功能不加按钮）----
         手机 → 电脑：服务端 autosync 默认开着，手机上复制任何东西都会推给宿主，
         宿主存进 `/status.clipboard`（text + at）。面板轮询发现 at 变了就写进系统剪贴板。
         电脑 → 手机：面板有焦点时 Ctrl+V，读出系统剪贴板后 SET_CLIPBOARD + paste ——
         这是把**中文**送进手机输入框最稳的一条路（INJECT_TEXT 只能送 ASCII）。
         刻意用 function 声明（不是 const）：refresh 在文本上先于它们定义，函数声明会提升，
         免得撞上 const 的 TDZ。 */
      const clipRef = useRef({ at: 0, written: '' });

      async function pullClipboard() {
        const cb = statusRef.current && statusRef.current.clipboard;
        if (!cb || !cb.text || !cb.at) return;
        const prev = clipRef.current;
        if (cb.at === prev.at) return;
        if (cb.text === prev.written) { prev.at = cb.at; return; }
        const nc = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (!nc || typeof nc.writeText !== 'function') { prev.at = cb.at; return; }
        try {
          await nc.writeText(cb.text);
          clipRef.current = { at: cb.at, written: cb.text };
          pushNotice(`已把手机剪贴板同步到电脑：${cb.text.length > 24 ? `${cb.text.slice(0, 24)}…` : cb.text}`);
        } catch (e) {
          // 权限被拒之类：记下 at 跳过，别每次轮询都弹一遍
          clipRef.current = { at: cb.at, written: prev.written };
          pushNotice(`手机剪贴板读到了，但写不进电脑剪贴板：${e.message}`);
        }
      }

      /** 电脑 → 手机：Ctrl+V 的落地实现（中文唯一的可靠入口） */
      async function pushClipboard() {
        const nc = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (!nc || typeof nc.readText !== 'function') { pushNotice('这个宿主读不到系统剪贴板'); return; }
        let text = '';
        try { text = await nc.readText(); } catch (e) { pushNotice(`读电脑剪贴板失败：${e.message}`); return; }
        if (!text) { pushNotice('电脑剪贴板是空的'); return; }
        await claimHuman();
        const j = await post('/clipboard', { op: 'set', text, paste: true, human: true }, '粘贴');
        if (j) pushNotice(`已送进手机：${text.length > 24 ? `${text.slice(0, 24)}…` : text}`);
      }

      /* ---- 截图机：单击截图 → 5 秒内按 L 开始长截图 → 进行中点一次停止并保存 ---- */
      const armCapture = useCallback(() => {
        // ref 与 state 同步改：按键处理要立刻看到最新状态（等 useEffect 会慢一拍，L 键会漏）
        capRef.current = 'armed';
        setCap('armed');
        if (armTimer.current) clearTimeout(armTimer.current);
        armTimer.current = setTimeout(() => {
          armTimer.current = null;
          if (capRef.current === 'armed') { capRef.current = 'idle'; setCap('idle'); }
        }, CAP_ARM_MS);
      }, []);

      const onShot = useCallback(async () => {
        await claimHuman();
        const j = await post('/shot', { mode: 'screen', name: 'screen', human: true }, '截图');
        if (j) {
          setShot({ path: j.path, width: j.width, height: j.height, bytes: j.bytes, mode: 'screen' });
          armCapture();
        }
      }, [post, claimHuman, armCapture]);

      const startLong = useCallback(async () => {
        if (capRef.current === 'capturing') return;
        await claimHuman();
        // 单击截图已经存了一张短图，既然现在开始长截图，那张短图就没用了 —— 让宿主删掉，
        // 否则截图目录里全是「一张短 + 一张长」的成对垃圾（用户明确提过这点）。
        const drop = shot && shot.mode === 'screen' ? shot.path : undefined;
        const j = await post('/shot', { mode: 'long', op: 'start', name: 'long', human: true, drop }, '长截图');
        if (j && j.ok !== false) {
          if (armTimer.current) { clearTimeout(armTimer.current); armTimer.current = null; }
          setShot(null);
          setLongInfo(j);
          capRef.current = 'capturing';
          setCap('capturing');
        }
      }, [post, claimHuman, shot]);

      const stopLong = useCallback(async () => {
        await post('/shot', { mode: 'long', op: 'stop' }, '停止长截图');
      }, [post]);

      useEffect(() => { capRef.current = cap; }, [cap]);
      useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);

      // 长截图进行中：400ms 轮询进度（宿主 GET /longshot → {running, height, frames, ms, result, error}）
      useEffect(() => {
        if (cap !== 'capturing') return undefined;
        let cancelled = false;
        let t = null;
        const tick = async () => {
          if (cancelled) return;
          let j = null;
          try { j = await getJson('/longshot'); } catch { /* 轮询失败就下一轮再试 */ }
          if (cancelled) return;
          if (j) {
            setLongInfo(j);
            if (!j.running) {
              capRef.current = 'idle';
              setCap('idle');
              if (j.result) {
                setShot({ path: j.result.path, width: j.result.width, height: j.result.height, bytes: j.result.bytes, mode: 'long', quality: j.result.quality, warning: j.result.warning });
                // 「只截到一屏」不是成功也不是失败，必须明说，否则用户以为长截图坏了
                setNotice(j.result.warning || '');
              } else if (j.error) {
                setNotice(`长截图失败：${j.error}`);
              }
              return;
            }
          }
          t = setTimeout(tick, 400);
        };
        t = setTimeout(tick, 400);
        return () => { cancelled = true; if (t) clearTimeout(t); };
      }, [cap, getJson]);

      /* ---- 键盘直通（对齐 QtScrcpy）：面板拿到焦点后，电脑键盘的每个键直接送进手机 ----
         关键点（2026-10-17 修）：**不经过电脑的输入法**。中文是让「手机上的输入法」自己去拼 ——
         我们只把字母/数字/符号一个个送到手机，手机 IME 弹候选，用户按数字/空格选词。
         这正是 QtScrcpy 的行为（它也是把物理键映射成 INJECT_TEXT/INJECT_KEYCODE）。
         上一版走「隐藏 input + 电脑输入法 composition」的路子，在 DSH 里焦点抢不到，打字没反应。
         攒 30ms 批量发，避免一个字一个 HTTP 请求。 */
      const flushKeys = useCallback(() => {
        const k = kbuf.current;
        if (k.timer) { clearTimeout(k.timer); k.timer = null; }
        const s = k.s;
        if (!s) return;
        k.s = '';
        void claimHuman().then(() => post('/keyboard', { text: s, submit: false, human: true }, ''));
      }, [post, claimHuman]);

      const typeChar = useCallback((s) => {
        if (!s) return;
        const k = kbuf.current;
        k.s += s;
        // 攒批窗口从 30ms 收到 8ms：一次按键只多一个往返，但体感差很多。
        // 连续快速输入（>120 字/秒才会漏）仍会被并进同一个 INJECT_TEXT。
        if (!k.timer) k.timer = setTimeout(() => { k.timer = null; flushKeys(); }, KEY_BATCH_MS);
      }, [flushKeys]);

      const sendKey = useCallback((key, meta) => {
        void claimHuman().then(() => post('/action', { action: 'key', key, ...(meta ? { meta } : {}), human: true }, ''));
      }, [post, claimHuman]);

      // 物理键 → Android keycode（其余可打印字符走 INJECT_TEXT）
      const KEY_PASS = {
        Enter: 'ENTER', Backspace: 'DEL', Delete: 'DEL', Tab: 'TAB', Escape: 'BACK',
        ArrowUp: 'DPAD_UP', ArrowDown: 'DPAD_DOWN', ArrowLeft: 'DPAD_LEFT', ArrowRight: 'DPAD_RIGHT',
      };

      /** 面板根节点的 keydown：所有键盘输入的唯一入口（根节点 tabIndex=0，点面板就会聚焦） */
      const onPanelKeyDown = (e) => {
        // 焦点在面板自己的输入控件里（设置页的截图目录 / App 名称 / 包名 / 筛选框 …）时一律放行：
        // 键盘直通只服务「把键送进手机」，不能把面板内部的文字编辑也抢走
        // （2026-10-18 用户反馈「backspace 键是坏掉的」——就是这里的 e.preventDefault() 把输入框的删字吃掉了）。
        const el = e.target;
        const tag = el && el.tagName ? String(el.tagName).toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || (el && el.isContentEditable)) return;
        // Ctrl+V / Cmd+V：把电脑剪贴板送进手机（中文唯一可靠入口，见 pushClipboard）
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V')) {
          e.preventDefault();
          void pushClipboard();
          return;
        }
        // Ctrl/Cmd + A/C/X/Z/Y：**手机内**的编辑快捷键（全选 / 复制 / 剪切 / 撤销 / 重做）。
        // 2026-10-18 用户反馈「Ctrl+A 在手机内全选失效」——以前带修饰键的键一律放行给 DSH，
        // 而 Android 的 EditText 只在 metaState 带 META_CTRL_ON(0x1000) 时才认这些组合，
        // 所以这里必须拦下来、显式带上 meta 送进控制通道（adb 的 input keyevent 做不到）。
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[acxzy]$/i.test(String(e.key || ''))) {
          e.preventDefault();
          flushKeys();
          sendKey(String(e.key).toUpperCase(), 'ctrl');
          return;
        }
        // 其余带修饰键的一律放行：Ctrl/Cmd/Alt 组合留给 DSH 自己的快捷键
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // 截图待命态下按 L = 开始长截图（不把这个 L 打进手机）
        if (capRef.current === 'armed' && (e.key === 'l' || e.key === 'L')) {
          e.preventDefault();
          void startLong();
          return;
        }
        const mapped = KEY_PASS[e.key];
        if (mapped) { e.preventDefault(); flushKeys(); sendKey(mapped); return; }
        // 可打印字符：单字符 key（'a'、'1'、'中' 由输入法直接给的也会走到这里）
        if (typeof e.key === 'string' && e.key.length === 1) {
          e.preventDefault();
          typeChar(e.key);
        }
      };

      /** 点面板任意位置 → 把焦点交给根节点，键盘从此打进手机（点 DSH 别处即自动失效） */
      const focusPanel = useCallback(() => {
        try { rootRef.current?.focus({ preventScroll: true }); } catch { /* ignore */ }
      }, []);

      // Esc：什么都不做（全屏那条路已删，见 2026-10-18）
      useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return undefined;
        const onKey = (e) => {
          if (e.key !== 'Escape') return;
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [view]);

      // 截图待命态按 L 开始长截图：再挂一层 window 兜底 ——
      // 刚点完「截图」按钮时焦点在按钮上（不在根节点），只有根节点监听会收不到 L。
      useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return undefined;
        const onKey = (e) => {
          if (e.key !== 'l' && e.key !== 'L') return;
          const el = e.target;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
          if (capRef.current !== 'armed') return;
          e.preventDefault();
          void startLong();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [startLong]);

      const devices = status?.devices || [];
      const dev = status?.device || {};
      const scr = status?.screen || {};
      const fg = status?.foreground || {};
      const online = devices.filter((d) => d.state === 'device').length;

      // 没画面时给出「为什么」+「怎么做」，不再留一片空白让人猜
      const overlay = !status
        ? null
        : (!status.ready
          ? h('div', { style: S.overlay, 'data-overlay': 'no-device' },
            h('div', { style: S.hintTitle }, '没有检测到手机'),
            h('div', { style: S.hintBody }, '① 数据线插好，手机上选「传输文件」模式；② 打开「开发者选项 → USB 调试」；③ 手机上弹「允许 USB 调试吗」时点「允许」；④ 插好后点下面按钮重新检测。'),
            h('button', { style: { ...S.btn, ...S.btnPrimary }, onClick: refresh }, '↻ 重新检测'),
          )
          : (!status.video || !status.video.running
            ? h('div', { style: S.overlay, 'data-overlay': 'no-stream' },
              h('div', { style: S.hintTitle }, '还没起视频流'),
              h('div', { style: S.hintBody }, '手机已连上。视频流是打开侧栏时自动起的；如果停过，点下面按钮拉起来。'),
              h('button', { style: { ...S.btn, ...S.btnPrimary }, onClick: () => post('/session', { op: 'start' }, '起流') }, '▶ 起流'),
            )
            : null));

      const video = h(Screen, {
        api, quality: QUALITY[quality], pushNotice,
        running,
        setRunning, view, setView,
        onStats: setVideoStats, onHuman: claimHuman, onPanelFocus: focusPanel, overlay,
      });

      // 顶栏三个胶囊：连接（三色）/ 控制权（模型=绿、人=灰，用户拍板 m02983）/ 分辨率（hover 出机型与编码参数）
      const link = status?.link || null;
      const linkState = link?.state || (status ? (status.ready ? 'ok' : 'none') : 'none');
      const linkText = linkState === 'ok' ? '● 连接' : linkState === 'error' ? '● 连接' : '○ 连接';
      const linkPill = h('span', {
        style: { ...S.pill, ...(linkState === 'ok' ? S.pillOk : linkState === 'error' ? S.pillBad : null) },
        'data-link': linkState,
        title: link ? `${link.message || ''}${link.hint ? `\n${link.hint}` : ''}` : (status ? '' : '正在检测…'),
        onClick: () => { if (link && linkState !== 'ok') pushNotice(`${link.message || '连接异常'}${link.hint ? `：${link.hint}` : ''}`); },
      }, linkText);

      // 控制权胶囊（用户 2026-10-18）：文案固定「模型持有」，只有颜色随持有者变 ——
      // 模型持有 = 绿；非模型持有（人已接管）= 默认灰。不做点击交互。
      const ownerPill = h('span', {
        style: { ...S.pill, ...(owner === 'ai' ? S.pillOk : null) },
        'data-owner': owner,
        title: owner === 'ai'
          ? '模型持有控制权（人点画面会自动接管，静默 90s 自动交还）'
          : '人已接管控制权（模型的动作会被拒绝，静默 90s 自动交还）',
      }, '🤖 模型持有');

      // 悬停只给「型号 + 系统」（用户 2026-10-17：信息太多）。编码尺寸挪到底部状态行。
      const resPill = h('span', {
        style: S.pill,
        'data-res': scr.width ? `${scr.width}x${scr.height}` : '',
        title: `${dev.model || '未知机型'} · Android ${dev.android || dev.release || '?'}`,
      }, scr.width ? `${scr.width}×${scr.height}` : '—');

      const capturing = cap === 'capturing';
      const capLabel = capturing
        ? `⏹ 停止${longInfo && longInfo.height ? ` ${Math.round(longInfo.height)}px` : ''}`
        : cap === 'armed' ? '📷 按 L 长截图' : '📷 截图';
      const captureBtn = h('button', {
        style: { ...S.btn, ...(cap === 'idle' ? null : S.btnOk) },
        'data-capture': cap,
        title: capturing
          ? '长截图进行中：点一下停止并保存（已拼好的部分会保留）'
          : cap === 'armed'
            ? `已截一张，${Math.round(CAP_ARM_MS / 1000)} 秒内按 L 开始长截图（过期自动变回灰色）`
            : '单击 = 截一张手机画面；截完 5 秒内按 L 可以继续做长截图',
        onClick: () => (capturing ? stopLong() : onShot()),
      }, capLabel);

      // 设置按钮（用户 2026-10-19：从第二行工具行挪到顶栏，放在画质后面）
      const settingsBtn = h('button', {
        style: { ...S.btn, ...(showSettings ? S.btnOk : null) },
        'data-settings': showSettings ? '1' : '0',
        title: '设置：截图保存地址 / 自动清理 / skill 位置 / 打开 App 候选',
        onClick: () => setShowSettings((v) => !v),
      }, '⚙ 设置');

      // 顶栏（用户 2026-10-17 重排）：连接 / 控制权 / 分辨率 + 画面模式 + 暂停 + 画质
      // 第二行：截图（挪到京东前）+ 打开京东 + 返回 / 桌面 / 多任务
      const rows = [
        h('div', { key: 'dev', style: S.bar },
          linkPill,
          ownerPill,
          resPill,
          online !== 1 ? h('span', { style: { ...S.pill, ...S.pillBad } }, `在线设备 ${online} 台`) : null,
          h('span', { style: { flex: '1 1 0', minWidth: 0 } }, ''),
          h('select', {
            style: S.select, value: view === 'contain' ? 'contain' : 'cover', 'data-view': view,
            title: '画面显示方式：铺满（填满面板）/ 完整（整屏可见）',
            onChange: (e) => setView(e.target.value),
          }, [
            h('option', { key: 'cover', value: 'cover' }, '铺满'),
            h('option', { key: 'contain', value: 'contain' }, '完整'),
          ]),
          h('button', { style: S.btn, 'data-pause': running ? '0' : '1', title: '暂停/继续接收视频流（暂停后手机侧编码也停，省电省带宽）', onClick: () => setRunning((v) => !v) }, running ? '⏸ 暂停' : '▶ 播放'),
          h('select', {
            style: S.select, value: quality, 'data-quality': quality,
            title: '画质档位',
            onChange: (e) => setQuality(e.target.value),
          }, Object.keys(QUALITY).map((k) => h('option', { key: k, value: k, title: QUALITY[k].full }, QUALITY[k].label))),
          settingsBtn,
        ),
        h('div', { key: 'bar1', style: S.bar },
          captureBtn,
          h('select', {
            style: { ...S.select, maxWidth: '9em' },
            value: launchPkg, 'data-launch-pkg': launchPkg,
            title: '要打开的 App（候选在「⚙ 设置 → 打开 App」里增删；想加手机里已有的 App 也在那里选）',
            onChange: async (e) => {
              const pkg = e.target.value;
              setLaunchPkg(pkg);
              await post('/settings', { launchPkg: pkg }, '记住默认 App');
            },
          }, (apps.length ? apps : DEFAULT_APPS).map((a) => h('option', { key: a.pkg, value: a.pkg }, a.label || a.pkg))),
          h('button', {
            style: { ...S.btn, ...S.btnPrimary },
            'data-open-app': '1',
            onClick: () => post('/open', { package: launchPkg, waitMs: 8000, human: true }, '打开 App'),
          }, '▶ 打开'),
          h('button', { style: S.btn, onClick: () => act({ action: 'key', key: 'BACK' }, '返回') }, '◀ 返回'),
          h('button', { style: S.btn, onClick: () => act({ action: 'home' }, '桌面') }, '⌂ 桌面'),
          h('button', { style: S.btn, 'data-recents': '1', onClick: () => act({ action: 'key', key: 'APP_SWITCH' }, '多任务') }, '🗂 多任务'),
        ),
      ];

      const statusLine = h('div', { key: 'st', style: S.status },
        h('span', {}, `画面 ${Math.round(videoStats.fps || 0)} fps`),
        h('span', {}, `${Math.round((videoStats.kbps || 0) / 10) / 100} Mbps`),
        h('span', { style: S.pill }, videoStats.mode === 'video' ? 'H.264' : '快照'),
        h('span', { style: S.pill, 'data-enc': '1', title: '视频编码尺寸（H.264 解码后的像素）' }, status?.video?.width ? `编码 ${status.video.width}×${status.video.height}` : (status?.session?.restarts ? `重启 ${status.session.restarts} 次` : '未起流')),
        videoStats.decodeMs ? h('span', { style: S.pill, 'data-decode': String(Math.round(videoStats.decodeMs)) }, `解码 ${Math.round(videoStats.decodeMs)}ms`) : null,
        fg.package ? h('span', { style: S.pill }, `前台 ${String(fg.package).split('.').pop()}`) : null,
        busy ? h('span', { style: S.pill }, `${busy}…`) : null,
      );

      // Ctrl+滚轮 = 调字号（A− / A+ 按钮按用户要求删了，但这个能力保留；也可以直接点状态栏里的字号提示）
      const onRootWheel = (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        bumpZoom(e.deltaY > 0 ? -0.1 : 0.1);
      };

      // 长截图进度条：进行中才出现，让「点完像卡住」变成「能看见它在拼」
      const longLine = capturing
        ? h('div', { key: 'long', style: S.status, 'data-longshot': '1' },
          h('span', {}, '长截图进行中'),
          h('span', { style: S.pill }, `${Math.round((longInfo && longInfo.height) || 0)}px`),
          h('span', { style: S.pill }, `${Math.round((longInfo && longInfo.frames) || 0)} 帧`),
          h('span', { style: S.pill }, `${Math.round(((longInfo && longInfo.ms) || 0) / 100) / 10}s`),
          h('span', { style: { color: 'var(--dshp-fg-soft, inherit)' } }, '按「⏹ 停止」或再点一次截图按钮结束并保存'),
        )
        : null;

      // 根节点上设字号：下面所有 em 尺寸都跟着走（宽面板自动放大，Ctrl+滚轮手动再调）
      // 同时把调色板铺成 CSS 变量：所有颜色都引用 var(--dshp-*)，深浅主题各自成立（坑 20）
      return h('div', {
        ref: rootRef,
        style: { ...S.root, position: 'relative', fontSize: `${fontPx}px`, ...paletteVars(palette) },
        'data-font': fontPx,
        'data-theme': palette.dark ? 'dark' : 'light',
        tabIndex: 0,
        onWheel: onRootWheel,
        onKeyDown: onPanelKeyDown,
        onMouseDown: focusPanel,
      },
        h('style', null, PANEL_CSS),
        ...rows,
        notice ? h('div', { style: S.notice, 'data-notice': '1' }, notice) : null,
        h('div', { style: { display: showSettings ? 'none' : 'flex', flex: '1 1 auto', minHeight: 0, minWidth: 0 } }, video),
        showSettings ? h(SettingsSheet, { post, onClose: () => setShowSettings(false) }) : null,
        longLine,
        shot ? h('div', { key: 'shot', style: S.status, 'data-shot': '1' },
          h('span', { style: { color: 'var(--dshp-fg-soft, inherit)', wordBreak: 'break-all' } }, shot.path || ''),
          shot.quality && !shot.quality.ok
            ? h('span', { style: { ...S.pill, ...S.pillBad } }, `自检异常×${(shot.quality.repeatGroups || []).length}`)
            : null,
        ) : null,
        statusLine,
      );
    }

    /* ---------------------------------------------------------------- 设置页 */

    // 用户 2026-10-18：①截图保存地址 ②截图目录自动清理 ③skill 位置（只读）④「▶ 打开」的候选 App。
    // 设置落盘在宿主 ~/.dsh/android-phone/settings.json；这里只是编辑界面。
    // embedded=true 给 DSH 插件详情页用（不依赖 better-sidebar）：不显示「关闭」按钮、不做浮层外框。
    function SettingsSheet(props) {
      const { post, onClose, embedded } = props;
      const [dir, setDir] = useState("");
      const [cleanup, setCleanup] = useState("7");
      const [choices, setChoices] = useState(["off", "1", "3", "7", "30"]);
      const [skills, setSkills] = useState(null);
      const [skillDir, setSkillDir] = useState("");
      const [apps, setApps] = useState([]);
      const [launchPkg, setLaunchPkg] = useState("");
      const [defaultApps, setDefaultApps] = useState([]);
      const [installed, setInstalled] = useState([]);      // 手机里已安装的第三方应用（/apps）
      const [instFilter, setInstFilter] = useState("");     // 「从手机添加」的包名筛选
      const [msg, setMsg] = useState("");

      const applySettings = useCallback((st, dirNow) => {
        if (!st) return;
        setDir(String(st.shotsDir || ""));
        setCleanup(String(st.cleanup || "7"));
        setApps(Array.isArray(st.apps) ? st.apps.map((a) => ({ label: String(a.label || ""), pkg: String(a.pkg || "") })) : []);
        setLaunchPkg(String(st.launchPkg || ""));
        if (dirNow) setMsg(`当前生效目录：${dirNow}`);
      }, []);

      // 只在挂载时读一次。post 的引用会随面板重渲染变化（依赖 getJson/api），
      // 若把它写进 load 的 deps，effect 会再跑一次并把用户正在编辑的内容冲掉（实测 gets=2）。
      const postRef = useRef(post);
      postRef.current = post;
      const load = useCallback(async () => {
        const r = await postRef.current("/settings", { action: "get" }, "读设置");
        if (r && r.ok) {
          applySettings(r.settings, r.dir);
          if (Array.isArray(r.choices) && r.choices.length) setChoices(r.choices);
          if (Array.isArray(r.defaultApps) && r.defaultApps.length) setDefaultApps(r.defaultApps);
        } else if (r && r.error) {
          setMsg(`读设置失败：${r.error}`);
        }
        const s = await postRef.current("/skills", {}, "读 skill");
        if (s && s.ok) { setSkills(Array.isArray(s.skills) ? s.skills : []); setSkillDir(String(s.dir || "")); }
        const a = await postRef.current("/apps", {}, "读应用列表");
        if (a && a.ok && Array.isArray(a.packages)) setInstalled(a.packages);
      }, [applySettings]);
      useEffect(() => { load(); }, [load]);

      // 「从手机添加」：把 /apps 里的包名追加成一行（名字先用包名最后一段，用户可改）
      const guessLabel = (pkg) => { const seg = String(pkg || "").split(".").filter(Boolean); return seg.length ? seg[seg.length - 1] : String(pkg || ""); };
      const addInstalled = (pkg) => {
        if (!pkg) return;
        setApps((prev) => (prev.some((a) => a.pkg === pkg) ? prev : [...prev, { label: guessLabel(pkg), pkg }]));
      };
      const instFiltered = installed.filter((pk) => {
        const q = instFilter.trim().toLowerCase();
        return !q || pk.toLowerCase().includes(q);
      });

      const save = async () => {
        const r = await post("/settings", { shotsDir: dir.trim(), cleanup }, "保存设置");
        if (r && r.ok) setMsg(`已保存。当前生效目录：${r.dir || "(默认)"}`);
        else if (r && r.error) setMsg(`保存失败：${r.error}`);
      };
      // 「打开 App」候选单独一个保存按钮（用户 2026-10-18 要求）：改完不点保存不会生效。
      const saveApps = async () => {
        const clean = apps
          .map((a) => ({ label: String(a.label || "").trim(), pkg: String(a.pkg || "").trim() }))
          .filter((a) => a.label && a.pkg);
        const r = await post("/settings", { apps: clean, launchPkg }, "保存 App 列表");
        if (r && r.ok) {
          applySettings(r.settings);
          const n = r.settings && Array.isArray(r.settings.apps) ? r.settings.apps.length : clean.length;
          setMsg(`App 列表已保存：${n} 个`);
        } else if (r && r.error) {
          setMsg(`保存 App 列表失败：${r.error}`);
        }
      };
      const runCleanup = async () => {
        const r = await post("/settings", { action: "cleanup" }, "立即清理");
        if (r && r.ok) setMsg(r.skipped ? "自动清理当前是关闭的（选「关闭」时不会清）" : `清理完成：删除 ${r.removed || 0} 张，保留 ${r.kept || 0} 张`);
      };
      const reveal = async () => {
        const r = await post("/settings", { action: "reveal" }, "打开目录");
        if (r && !r.ok) setMsg("打不开目录（可能还没生成过截图）");
      };
      const setApp = (i, k, v) => setApps((prev) => prev.map((a, j) => (j === i ? { ...a, [k]: v } : a)));
      const delApp = (i) => setApps((prev) => prev.filter((_, j) => j !== i));
      const addApp = () => setApps((prev) => [...prev, { label: "", pkg: "" }]);

      const rowS = { display: "flex", gap: "0.4em", alignItems: "center", flexWrap: "wrap" };
      const bodyS = { fontSize: "0.92em", color: "var(--dshp-fg-soft, inherit)", lineHeight: 1.7 };
      const wrapS = embedded
        ? { display: "flex", flexDirection: "column", gap: "0.7em", padding: "0.2em 0", maxWidth: "48em" }
        : S.settingsWrap;
      return h("div", { style: wrapS, "data-pane": "settings" },
        h("div", { style: rowS },
          h("span", { style: { ...S.hintTitle, flex: "1 1 auto" } }, "⚙ 设置"),
          embedded ? null : h("button", { style: S.btn, onClick: onClose }, "✕ 关闭"),
        ),
        h("div", { style: S.settingsBlock },
          h("div", { style: S.hintTitle }, "① 截图保存地址"),
          h("div", { style: bodyS }, "留空 = 默认（~/.dsh/android-phone/shots）。改完点保存，之后截图/长截图都存这里。"),
          h("input", {
            style: { ...S.input, flex: "0 0 auto", width: "100%", minWidth: 0, boxSizing: "border-box" }, value: dir, spellCheck: false, "data-settings-dir": "1",
            placeholder: "例如 D:/截图/手机",
            onChange: (e) => setDir(e.target.value),
          }),
          h("div", { style: rowS },
            h("button", { style: { ...S.btn, ...S.btnPrimary }, onClick: save, "data-settings-save": "1" }, "💾 保存"),
            h("button", { style: S.btn, onClick: reveal }, "📂 打开目录"),
            h("button", { style: S.btn, onClick: () => setDir("") }, "恢复默认"),
          ),
        ),
        h("div", { style: S.settingsBlock },
          h("div", { style: S.hintTitle }, "② 截图目录自动清理"),
          h("div", { style: bodyS }, "只清理本插件产出的截图（文件名以时间戳开头），别的文件不动。每次截图后会顺手清一次，最多 6 小时一次。"),
          h("div", { style: rowS },
            h("select", {
              style: S.select, value: cleanup, "data-settings-cleanup": "1",
              onChange: (e) => setCleanup(e.target.value),
            }, choices.map((c) => h("option", { key: c, value: c }, c === "off" ? "关闭（不清理）" : `保留 ${c} 天`))),
            h("button", { style: S.btn, onClick: runCleanup }, "🧹 立即清理"),
          ),
        ),
        h("div", { style: S.settingsBlock },
          h("div", { style: S.hintTitle }, "③ Skill 位置（只读）"),
          h("div", { style: bodyS }, skillDir ? `目录：${skillDir}` : "加载中…"),
          skills === null
            ? h("div", { style: bodyS }, "…")
            : (skills.length === 0
              ? h("div", { style: bodyS }, "（插件包里没有 skill）")
              : h("div", { style: S.skillList }, skills.map((s) => h("div", { key: s.id, style: S.skillItem, title: s.dir },
                h("b", {}, s.name || s.id),
                s.description ? h("span", { style: bodyS }, s.description) : null,
              )))),
        ),
        h("div", { style: S.settingsBlock },
          h("div", { style: S.hintTitle }, "④ 打开 App（工具栏「▶ 打开」的候选）"),
          h("div", { style: bodyS }, "这里配的就是工具栏下拉里的候选（只列这些，不灌整台手机）。想加手机里已有的 App：用下面的「从手机添加」挑一个（只列桌面上有图标的 App），名字默认取包名末段、可以改成中文，改完点「💾 保存 App 列表」才生效。"),
          apps.length === 0
            ? h("div", { style: bodyS }, "（空，点下面「＋ 新增」或「恢复默认列表」）")
            : null,
          ...apps.map((a, i) => h("div", { key: `${i}-${a.pkg}`, style: rowS, "data-app-row": String(i) },
            h("input", {
              style: { ...S.input, flex: "0 0 6em", width: "6em", minWidth: 0 }, value: a.label, spellCheck: false,
              placeholder: "名称", "data-app-label": String(i),
              onChange: (e) => setApp(i, "label", e.target.value),
            }),
            h("input", {
              style: { ...S.input, flex: "1 1 12em", minWidth: 0 }, value: a.pkg, spellCheck: false,
              placeholder: "com.example.app", "data-app-pkg": String(i),
              onChange: (e) => setApp(i, "pkg", e.target.value),
            }),
            h("button", { style: S.btn, title: "删掉这一行", onClick: () => delApp(i) }, "✕"),
          )),
          h("div", { style: rowS },
            h("button", { style: S.btn, onClick: addApp, "data-app-add": "1" }, "＋ 新增"),
            h("button", { style: { ...S.btn, ...S.btnPrimary }, onClick: saveApps, "data-app-save": "1" }, "💾 保存 App 列表"),
            h("button", {
              style: S.btn,
              onClick: () => setApps((defaultApps.length ? defaultApps : []).map((a) => ({ label: a.label, pkg: a.pkg }))),
            }, "恢复默认列表"),
          ),
          h("div", { style: rowS },
            h("span", { style: bodyS }, "从手机添加："),
            h("input", {
              style: { ...S.input, flex: "1 1 7em", minWidth: 0 },
              placeholder: "筛选包名", value: instFilter, spellCheck: false, "data-app-filter": "1",
              onChange: (e) => setInstFilter(e.target.value),
            }),
            h("select", {
              style: { ...S.select, flex: "1 1 9em", minWidth: 0 },
              value: "", "data-app-installed": "1",
              onChange: (e) => { addInstalled(e.target.value); e.target.value = ""; },
            },
              h("option", { value: "" }, instFiltered.length ? `选一个桌面应用（${instFiltered.length}）…` : (installed.length ? "没有匹配的包名" : "正在读桌面应用…")),
              instFiltered.slice(0, 300).map((pk) => h("option", { key: pk, value: pk }, pk)),
            ),
          ),
          h("div", { style: rowS },
            h("span", { style: bodyS }, "工具栏默认选中："),
            h("select", {
              style: S.select, value: launchPkg, "data-app-launch": "1",
              onChange: (e) => setLaunchPkg(e.target.value),
            }, apps.filter((a) => a.pkg).map((a) => h("option", { key: a.pkg, value: a.pkg }, a.label || a.pkg))),
          ),
        ),
        msg ? h("div", { style: bodyS, "data-settings-msg": "1" }, msg) : null,
      );
    }

    // 插件详情页用的 post：不依赖 Panel 的 busy/notice 状态，失败时返回 { ok:false, error }。
    function makePagePost(ctx) {
      const base = apiBase(ctx);
      return async (path, body) => {
        try {
          const r = await fetch(`${base}${path}`, {
            method: "POST", cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
          return j;
        } catch (e) {
          return { ok: false, error: e.message };
        }
      };
    }

    // DSH「插件」页 → dsh-android-phone 详情页里的设置区。
    // 用户 2026-10-18：没装 better-sidebar 的用户也要能改设置，所以走 slots 扩展点而不是侧栏 tab。
    function PluginSettings(props) {
      const post = useMemo(() => makePagePost(props.ctx), [props.ctx]);
      return h(SettingsSheet, { post, embedded: true });
    }
    /* ---------------------------------------------------------------- 注册 */

    const name = 'dsh-android-phone';
    // 刻意不把 betterSidebar 声明成必需依赖：没装它的用户，插件页设置区照样要能用。
    const inject = [];

    function apply(ctx) {
      // ① DSH「插件」页 → 本插件详情页里的设置区（slots 扩展点，与 better-sidebar 无关）。
      //    宿主把 plugins.bundle.config 的 key 与本包名对上时才会渲染（key 必须等于包名）。
      try {
        const slots = ctx.slots;
        if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
          slots.inject('plugins.bundle.config', () => slots.register({
            name: 'plugins.bundle.config',
            key: 'dsh-android-phone',
          }, (props) => {
            const view = props && props.view;
            if (view && view !== 'page') return null;   // summary 视图不塞表单
            return h(PluginSettings, { ctx });
          }));
        } else {
          console.warn('[android-phone] 没有 slots 扩展点，插件页设置区未注册');
        }
      } catch (e) {
        console.warn('[android-phone] 插件页设置区注册失败', e);
      }

      // ② 侧栏 tab：只有装了 better-sidebar 才有。用 ctx.inject 等它就绪（激活顺序无关）。
      const registerTab = (c) => {
        const cc = c || ctx;
        const sb = cc.betterSidebar;
        if (!sb || typeof sb.registerTab !== 'function') {
          console.warn('[android-phone] 没有 betterSidebar.registerTab，侧栏 tab 未注册（插件页设置区不受影响）');
          return;
        }
        cc.effect(() => sb.registerTab({
          id: 'dsh-android-phone',
          title: '手机',
          description: '安卓真机：实时画面 + 操作注入 + 截图/长截图',
        icon: h('img', {
          src: `${apiBase(cc)}/icon.png`,
          alt: '',
          width: 16,
          height: 16,
          style: { display: 'block', borderRadius: '50%' },
        }),
          order: 61,
          single: true,
          component: () => h(Panel, { ctx }),
        }), 'android-phone: sidebar tab');
      };
      try {
        if (typeof ctx.inject === 'function') ctx.inject(['betterSidebar'], registerTab);
        else registerTab(ctx);
      } catch (e) {
        console.warn('[android-phone] 侧栏 tab 注册失败', e);
      }
    }

    return { name, inject, apply };
  },
});
