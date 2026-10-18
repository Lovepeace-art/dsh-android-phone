# 进度与交接记录

> **用途**：本文件是跨会话 / 跨模型提供商的唯一交接依据。每次动手前后都要更新。
> 最后更新：2026-10-18（侧栏 UI 多轮打磨之后，把「面板内全屏」换成**弹出桌面独立窗口**；控制通道 tap 的真因与 reverse 隧道见坑 8/坑 9，install.ps1 的 BOM 坑见坑 11）
> 配套文件：`PLAN.md`（完整计划与设计决策）

---

## 0. 给接手的人（或换了个 provider 之后的模型）

1. 先读 `PLAN.md` 全文，再读本文件。
2. 本文件第 2 节是**本机实测**的环境事实，第 3 节是**已经踩过的坑**（别重复踩），第 4 节是改动点坐标，第 5 节是阶段勾选，第 6 节是待用户拍板的问题。
3. 手机必须插着 USB 才能做真机验证；阶段 0.2 是整条路线的单点验证，没过之前不要动功能代码。
4. 用户明确要求：**这一版在 DSH 侧栏内实现**（效果不好才回头考虑原生窗口方案）；**字体发虚这一项跳过**，只留基线测量。

---

## 1. 当前状态

- **阶段**：阶段 0/1/2 主体完成；阶段 3（打包 + 安装接线 + 文档 + **装进真实 desktop profile**）完成；**宿主半边已在真实 DSH 进程里加载并验收通过**（`GET /dsh-android-phone/api/status` 从 404 变 ALIVE）；只剩两件不阻塞的：侧栏**人眼**画质确认、阶段 2.4 基线测量
- **设备**：`ADF0220515005425` 已授权在线（HUAWEI WLZ-AN00 / nova 6 5G / Android 12 / 1080x2400 / 480dpi），手机插着 USB
- **已完成**：`vendor/`（platform-tools 37.0.1 + scrcpy-server v5.0.1，已裁到只留 adb + 2 DLL，9.9MB）；`control.js`（控制协议 23 种消息）+ `session.js`（单会话/控制权/自愈）+ `index.js`/`client.js` 接线；`skills/jd-mall-capture`（SKILL.md + `jd-capture.mjs` 老执行器 + **`jd-shop-longshot.mjs` 一键生产脚本**）随包；`install.ps1` 会把 `<插件目录>\skills` 并进 profile 的 `skill-filesystem.customSkillDirs`；README.md / 安装说明.txt 已按 v0.2.0 重写
- **真机已验证**：单会话 `control=true` + **reverse 隧道**稳活（旧 forward 隧道 ~2-4s 静默停流，见坑 9）；会话启动 **1559ms**（旧实现 9800ms）；控制口 `INJECT_KEYCODE(HOME)`/`START_APP`/`INJECT_TOUCH_EVENT` 全都真落地；控制 tap 宿主耗时 **115µs** vs adb `input tap` **91ms**（791×）
- **坑 8（坐标系）**：控制通道的坐标必须是**视频尺寸**（808x1800），不是设备像素（1080x2400），否则 scrcpy 的 `PositionMapper.map()` 会**静默丢弃每个带坐标的事件**（只打 VERBOSE），现象是 tap/swipe/scroll 全无反应而 keycode/startApp 正常
- **京东端到端全绿**：`PROBE-P1-e2e-jd.json` 20/20；**skill 生产脚本真机跑通 exit 0（10/10 PASS）**，落盘长截图 **1080x5147**（3 接受帧/共 5 帧、15.9s、3.98MB），人眼验收无接缝；产物 `out\jd-shop-1792163742762.png`
- **模型独立路径也已验过**（`PROBE-P1-ai-autostart.json`）：不起侧栏时 `phone_open` 自己把会话拉起来（1477ms），之后 tap / 中文 / 回车全部 `via=control`
- **2026-10-18 侧栏 UI + 大窗口**：字号/对比度/窄面板裁切/按钮边框发虚/下拉三角都已修；**「面板内全屏」已删**（用户 m06676：「全屏的逻辑不太好」——侧栏只有 400 来像素宽，拉高不变宽，还把工具栏藏了），换成顶栏「⤢ 大窗口」：`window.open` 弹一个独立桌面窗口，里面是同一路 `/video` 流 + 同一套点/长按/拖拽/滚轮/键盘，工具行自带截图/长截图/返回/桌面/多任务/铺满/画质/关闭（`client.js` 的 `openPhoneWindow` + `mountPhoneWindow`，弹窗内**不写任何脚本**，由父窗口同一 JS 上下文驱动，绕开 CSP）。开着弹窗时侧栏那一路**自动停**（同一台手机只允许一路视频会话，两路会互抢 socket），关窗后自动恢复；宿主拦掉 `window.open` 时退回面板内全屏并提示
- **回归现状**：`test-plugin-tools` **33/33**（新增 install.ps1 BOM / 默认编码读取两条防回归）· `test-stitch` **35/35** · `test-client` **40/40** · `test-host` **36/36** · `test-session` 11/11 —— 共 155 项全绿（报告在 `recon\reports\`，`test-plugin-tools` 的在项目根 `PROBE-P1-tools.json`）
- **真实宿主验收（2026-10-16 23:4x，走真实 DSH 进程的 `/dsh-android-phone/api`）**：
  - `GET /status` → ALIVE：`ready=true`、`serial=ADF0220515005425`、`adbPath`/`scrcpyServer` 都指向插件自带 `vendor`、`scrcpyServer` 版本 5.0.1、`owner=ai`、11 个工具、`actions` 只有 `jd`(15)
  - `POST /shot {mode:'long'}` 长截图 **1080x5079 / 3,706,242 字节 / 3 接受帧**，`quality.ok=true`（重复块 0、粗差 0、长跑 0），人眼无接缝 —— 就是本插件在真机上产出的店铺首页长图
  - **控制权验收 9/9**（`ACCEPT-live-owner.json`）：人接管后模型写操作 → `HTTP 500`「手机控制权已被人工接管（owner=human）…`phone_takeover`…」；人接管时只读 `/status` 仍 200；`human:true` 的动作不被守门人拦；`/owner {idleMs:1234}` 生效；交还后可写（`via=control`）
  - 设备侧无残留：`ps -A | grep -c app_process` = 0、`adb reverse --list` = 空
- **已装进真实 desktop profile 并且已被用户重启加载（2026-10-16 23:4x）**：`install.ps1` 跑完，profile = `C:\Users\Administrator\.dsh\profiles\desktop`；`dsh.profile.bundles` 已含 `dsh-android-phone`、`dependencies` 已声明 `link:../../../Desktop/DSH/feiniao-android-phone/dsh-android-phone`、junction `profiles\desktop\node_modules\dsh-android-phone` 已建；skill 根已并进 `skill-filesystem.customSkillDirs`（**与 dsh-sanjip-ops 同一个 `- id: skill-filesystem` 条目，sanjip 的路径原样保留，`customSkillDirs:` 只出现 1 次**）；备份 `package.json.bak-android-phone` / `cordis.patch.yml.bak-android-phone` 已在 profile 目录。**但这次安装把 profile 里的中文写坏了，已修（坑 14）**
- **cwd 无关性已证**：从 cwd = `C:\Users\Administrator\Desktop\DSH` / `D:\` / `C:\Windows` 三处分别 import 插件，`resolveAdb()` 与 `resolveServerJar()` 都稳定返回 `...\dsh-android-phone\vendor\...`（所以 DSH 宿主进程 cwd 在哪都不影响）
- **安装后清洁检查又抓到一个真 bug（坑 13）**：`adb reverse --remove` 用 `tcp:PORT` 是**删不掉的**（exit 1，`listener not found`），要按 `localabstract:scrcpy_xxx` 删；本机因此攒了 **22 条**残留映射。已加 `sweepScrcpyReverseSync()`（起会话前 + 进程退出时扫，只动 `scrcpy_*`），修后 `test-host` 36/36 且跑完 `reverse --list` 残留 **0**
- **画质发糊的另一半原因已修（坑 15）**：模型起会话时用的是包内 `video.maxSize: 760`（→ 340x760，手机原图的 1/3），
  侧栏挂载时还会再 `POST /session` 一次导致「起一路再重启一路」；自适应档 `autoMaxSize()` 还只按长边算、
  在窄长侧栏里会要得偏小。已改成：`max(高×dpr, 宽×dpr/0.45)` 两个方向取大、删掉挂载时的 `POST /session`
  （只留 `GET /video` 单入口，它才知道画布真实像素）、config 默认 760 → 1024。
  **生效方式：`client.js` 改完硬刷新侧栏即可；`cordis.patch.yml`（1024）要重启 DSH 才生效。**
- **未做**：侧栏**人眼**画质确认（建议顺手看：手机画面字是否变清楚、点选是否跟手、控制权胶囊是否显示正确）；阶段 2.4「平台糊 vs 插件糊」基线测量。回滚 = `install.ps1 -Uninstall`（会摘掉 bundles/依赖/junction/skill 根）

### 1b. 第二轮（2026-10-16 23:5x，用户重启后反馈「界面看不清」+ 侧栏显示未连接）

- **用户反馈**（m01847 截图）：侧栏「未连接 / 未发现设备 / 会话未启动 / 在线设备 0 台」、`动作失败：没有检测到设备`、`快照也失败：快照 HTTP 500`、控制权显示「人」；整页字小、浅色主题下几乎看不清。
- **两个真问题**：
  1. **adb server 起不来**（坑 16）→ 设备列表空。用户重启 DSH 后，原来那个 adb server 没了；新 server 由沙箱里的 adb 自己 fork 出来，写 `%TEMP%\adb.log` 被拒。**已修**：`adb.js` 自举 `nodaemon server`（见坑 16，探针 PASS）。
  2. **侧栏 UI 可读性**（坑 17）：字号写死 13px、深色主题配色在浅色主题下对比度极低、窄面板裁掉按钮、没画面时一片空白。**已修**：字号自适应 + A−/A+ 手动倍率 + em 尺寸 + 中性灰配色与彩色描边 + 没设备/没起流的占位提示（见坑 17；`test-client` 40/40 仍全绿）。
- **控制权被留成 `human`**：用户点过「✋ 接管」，已 `POST /owner {owner:'ai'}` 交还。
- **真机复验**：修好后走真实宿主 `POST /shot {mode:'screen'}` → **1080x2400 / 1,461,025 字节 / 1421ms**（`~\.dsh\android-phone\shots\2026-10-16T23-59-18-ui-check.png`）。
- **用户侧要做的**：`client.js` 的 UI 改动**硬刷新侧栏**即可；`adb.js` 的自举要**重启 DSH** 才生效（重启前我已在进程树外用 WMI 起了一个常驻 server，所以现在就能用）。

### 1c. 第三轮（2026-10-17 00:0x，用户：「看不清是主题（换深色就好），但延迟依然存在，鼠标点完一会手机才动」）

- **「看不清」定性**：用户用的是**浅色主题**，原来的配色（写死 `rgba(255,255,255,x)`）对比度极低 → 换成深色主题就好。
  坑 17 的改法（中性灰 + 彩色描边 + 字号自适应）对浅色主题同样可读，已用离屏出图人眼确认（坑 19，`recon/ui-preview/*.png`）。
- **延迟定位（坑 18）**：`POST /action` 的**固定开销 520~580ms**，且**不随动作内容变**（`wait` 动作也 540ms）——
  全是动作之前的 adb 往返：`pickDevice` 57ms + `screenMetrics` 190ms + `currentFocus` 150ms。
  **已修**：模块级设备缓存 + 控制通道直接用 `ctl.screen` 当 metrics（一个 adb 都不跑）+ 人的动作不回读前台 + 人已是 owner 时不重复 `POST /takeover`。
  假宿主复验：固定开销 **~270ms → ~20ms**（见坑 18 的表）。
- **生效方式**：`index.js` / `src/**` / `adb.js` 改了 ⇒ **重启 DSH**；`client.js` ⇒ **硬刷新侧栏**。

### 1d. 第四轮（2026-10-17 08:4x，用户：「浅色主题下还是不太对，主要是字体发灰。延迟还是有，能被明显感觉到，不如 qtscrcpy 那么流畅」）

- **浅色发灰的真因（坑 20）**：`S.root.color` 原来写的是 `var(--vscode-foreground, #d4d4d4)` —— DSH **根本没有** `--vscode-foreground` 这个变量
  ⇒ 直接落到兜底的**浅灰 `#d4d4d4`**，在白底上就是「发灰」。已改成从**宿主容器的实际文字色**派生整套 `--dshp-*` 调色板（见坑 20）。
- **离屏预览又踩三个坑（坑 21）**，修好后两套主题终于真的不同：light `--dshp-fg: rgb(31,31,31)` / dark `rgb(212,212,212)`；
  `recon/ui-preview/*.png` 人眼确认：浅色下按钮/胶囊/提示文字都是深色高对比，输入框不再被裁（挪到独立一行）。
- **延迟（真机，真实宿主里测的）**：坑 18 的修复生效后，`POST /action {action:'wait'}` 从 **533~583ms → 4~5ms**（`key WAKEUP` 1ms）
  ⇒ **动作路径已经不是瓶颈**，剩下的"不跟手"全在**画面链路**（采集→编码→adbd→宿主→解码→绘制）。
- **画面链路第一层测量已就位**：`client.js` 底栏新增 **`解码 Nms`**（把帧交给 decoder 到 output 的时间，EWMA）+ `frameAgeMs`（距上一张解出画面多久）。
  这是为阶段 2.6 准备的分层尺子：能分清"手机/网络慢"还是"浏览器慢"。
- **同时落地**：`maxFps` 30 → **60**（`client.js` 的 QUALITY 四档 + `src/android/video.js` DEFAULT_VIDEO + `cordis.patch.yml`）；
  canvas 后备存储按面板设备像素（只缩不放，原来是 1080×2400 全量栅格化）；`getContext('2d',{desynchronized:true})`；
  宿主 `res.socket.setNoDelay(true)` + 每条 socket 都 `setNoDelay`（Nagle 会给回执加 ~40ms）。
- **生效方式**：本轮改了 `index.js`/`video.js`/`cordis.patch.yml` ⇒ **重启 DSH**；`client.js` ⇒ **硬刷新侧栏**。

### 1e. 第五轮（2026-10-17 09:0x，用户：「鼠标拖拽逻辑也修下，一次拖拽的比较少，使用不流畅，滚轮逻辑也可以优化下，可参考 qtscrcpy」）

- **旧拖拽为什么会「一次拖拽的比较少」（坑 22）**：`client.js` 的 pointermove 里，只要位移超过 0.05 屏就**发一次固定的 `swipe ms:260`，然后 `g.done = true` 闭锁**
  ⇒ 鼠标继续移动也不再发任何事件。手机收到的是"按下→一瞬间滑过去→抬起"，不是手指跟着鼠标走。
  新模型改成**逐事件回放**：pointerdown 立刻发 `touch down`、pointermove 按 **8ms 合并**后发 `touch move`（不闭锁）、pointerup 必发 `touch up`；
  轻点/长按/拖拽三种手势**自然从同一条流里长出来**（Android 对"原地 down+up"就判点击），不再靠宿主猜。
- **旧滚轮为什么怪（坑 23）**：`pages = clamp(|acc|/240, 0.2, 1.2)`，即**一格滚轮至少 0.2 屏**、最多 1.2 屏，且把整屏量交给 `adb` 时代的 swipe 时长去模拟。
  现在 **1 格 = `WHEEL_PER_DETENT`(100) 个 deltaY 单位**（真机标定 = 192px ≈ 0.08 屏，见坑 25），余数存进 `carryRef` 下次接着攒；≥1 格才发一次（一格一条 `INJECT_SCROLL_EVENT`，量程 ±16）。
- **协议侧**：`control.js` 新增 `touchEvent(phase,x,y)` 与 `scroll(x,y,{notchesV,notchesH})`（一条消息 = 一格，±16 夹取）；
  **宿主不猜手势**：`touch`/`wheel` 都是独立动作类型（`actions.js` 的 `ACTION_TYPES` 加了这两个），`by==='human'` 时**跳过 settle**（不为了"看起来生效"白等 120ms）。
- **侧栏还修了两个体验问题**：输入事件改成**单飞有序队列**（保证 down→move→up 顺序，move 按最新位置合并、上限 32 条），
  以及 `client.js` 的 `TAP_MAX_MS`/`TAP_MAX_MOVE` 两个常量在新模型下已**不再使用**。
- **自测**：`scripts/test-client.mjs` 按新语义重写断言（轻点 = down+up、拖拽 = down+move*+up、滚轮 = 一格 → `notches`）⇒ **40/40 全绿**；
  四个文件 `node --check` 全 0 错。
- **真机验收探针**（新）`scripts/probe-drag-wheel.mjs`：用假宿主 `serve-api.mjs --port 19399` 验「touch 落地 / 滚轮方向 / 一格多少像素 / 拖拽跟手」，报告 `PROBE-P4-drag-wheel.json`。
- **生效方式**：`control.js`/`actions.js`/`index.js` ⇒ **重启 DSH**；`client.js` ⇒ **硬刷新侧栏**。

### 1f. 第六轮（2026-10-17 09:1x–10:1x，真机标定拖拽/滚轮 + 白查半小时的「僵尸 serve-api」）

- **拖拽（已真机验过）**：18 个事件（down + 16×move + up）**466ms** 发完，全程 `via=control`；
  手指从 0.70 拖到 0.40（上滑）⇒ 页面内容 **dy=+901px**（期望 ≈720px，比值 1.25 —— 惯性会放大，判据取 0.6~2.0）；
  再拖回来 ⇒ **回到出发位置（净差 0px）**。⇒ 「一次拖拽的比较少」确实治好了。
- **滚轮（代码已改，等一次干净复跑）**：真机标定 **1 格 = 192 设备像素 = 0.08 屏**（1080x2400），3 格 = 576px 线性；
  宿主侧发出耗时 **0~1ms**（`step.ms`）—— 消息本身零成本，慢的一直是截图/渲染那一侧。
- **滚轮方向搞反了（坑 25，已修）**：协议里 **vScroll 负 = 内容前进**，与"notches 正 = 前进"的对外约定相反
  ⇒ 在 `control.js` 的 `scroll()` 里**取负**（唯一真源，客户端与模型都不用改）。
- **僵尸 serve-api（坑 24，最费时间）**：`serve-api.mjs --port 19399` 的**旧实例没死**，新实例启动即 `EADDRINUSE` 退出，
  而探针照常拿到响应 —— 于是**三轮"改完重跑"全被旧进程用旧代码回答**，数据一模一样、加日志也不出现。
  现在 `serve-api.mjs` 会打印 `SERVE_API_PORT=<port>`，并在 `EADDRINUSE` 时大声报错退出；跑探针一律 `--port 0` + 读这个变量。
- **待办**：手机当时被人使用（探针在京东首页点搜索框，落地到了`com.tencent.mm`聊天页）⇒ 探针已加保护：
  落地前台不是京东就**立刻抛错退出**并提示"等手机空着再跑"，不会对着别人的屏幕继续点。

### 1g. 第七轮（2026-10-17 09:3x，手机空着后重跑：拖拽/滚轮 **16/16 PASS**）

- **结论：拖拽/滚轮的宿主 + 客户端改造真机成立**。报告 `PROBE-P4-drag-wheel.json`（假宿主 + 真机，`--port 0`）。
- 数字（京东搜索结果页，列表区 618..2265，滚轮打在 (0.5,0.55)）：
  - 会话 `808x1800 reverse control`；打开京东自愈（1 次 BACK）；`touch down+up` 点开搜索页 1864ms（`via=control`）。
  - **滚轮线性**：`+1/+1/+3/+2/+6` → **192 / 192 / 576 / 384 / 1152 px** ⇒ **1 格 = 192 设备像素 = 0.08 屏**。
  - 线上取值 `vScroll = -notches`（符号约定断言 PASS）。
  - 列表顶部往回滚 = `no-motion`（被夹住）✓
  - **往返不变量**：`+3` 前进 576px，再 `-3` → **净差 0px** ⇒ 往回滚真能滚回去 ✓
  - **拖拽**：`down + 14×move + up` 共 16 个事件 **481ms**；手指 0.70→0.40（上滑 720px）⇒ 内容 **+902px**（1.25×，惯性放大）；
    再拖回来 ⇒ **净差 24px**（回到出发位置）✓
  - 滚轮消息宿主侧 **0~1ms**（`step.ms`）。
- **这一轮的真收获是「尺子」错了两次**（坑 26）：先做了 A/B 对照（滚轮前后截图 1.39MB→1.25MB、`tap` 落到 `ProductDetailActivity`）
  才确认「注入一直是好的，是探针量错了」。
- 遗留（不影响功能）：`sent.hScroll` 在 HTTP 响应里是 `null`（内部算出 0，只是序列化表现）；`client.js` 的 `TAP_MAX_MS`/`TAP_MAX_MOVE` 已无人引用（可删）。
- **用户侧**：宿主代码（`index.js`/`src/**`）改动 ⇒ **重启 DSH**；`client.js` ⇒ **硬刷新侧栏**。然后试手感（拖拽是否跟手、滚轮一格是否合适）。

---

## 2. 环境事实（本机实测，2026-10-16）

| 项 | 值 |
|---|---|
| 工作区 | `C:\Users\Administrator\Desktop\DSH` |
| 项目根 | `C:\Users\Administrator\Desktop\DSH\feiniao-android-phone` |
| 插件目录 | `C:\Users\Administrator\Desktop\DSH\feiniao-android-phone\dsh-android-phone` |
| node | `D:\Xin\node.exe` |
| adb | `...\dsh-android-phone\vendor\platform-tools\adb.exe`<br>报告版本：`Android Debug Bridge version 1.0.41` / `Version 37.0.1-15733141` |
| scrcpy-server | `...\dsh-android-phone\vendor\scrcpy-server`，733,930 字节<br>取自 GitHub `Genymobile/scrcpy` release `v5.0.1` 的 `scrcpy-server-v5.0.1` 资产 |
| 手机序列号 | `ADF0220515005425`（基线报告记录为 HUAWEI WLZ-AN00 / nova 6 5G / Android 12 / 1080x2400 / density 480） |
| 手机 adb 状态 | **authorized，设备一直在线**（`ADF0220515005425 device`；2026-10-16 21:53 那次 unauthorized 早已确认过） |
| 本机原有 Android 工具链 | **无**：没 QtScrcpy、没 platform-tools、没 Android SDK、`~\.dsh\android-phone` 不存在（插件从未在本机跑过） |
| 其他 adb | `D:\Xin\MuMu Player 12\...\adb.exe`（MuMu 模拟器自带，**不使用**） |
| 插件基线 | 35 文件 / 325,542 字节（与用户给的 zip 一致） |
| node_modules | 无（插件是零 npm 依赖设计） |

### 本机临时目录重定向

adb 相关命令建议把 TEMP 指向工作区内目录（见坑 2）：

```powershell
$env:TEMP = 'C:\Users\Administrator\Desktop\DSH\feiniao-android-phone\.tmp'
$env:TMP  = $env:TEMP
```

---

## 3. 已踩过的坑

### 坑 1：pwsh 在受限沙箱下完全无法启动

- 现象：`exit 3221225794` = `0xC0000142 STATUS_DLL_INIT_FAILED`，连 `echo ok` 都失败。
- 原因：DSH 文件沙箱处于受限模式时 pwsh 起不来。
- 现状：策略已切到 `danger-full-access`，正常。
- **注意**：本会话 approval policy = `never`，**不要设置 `sandbox_permissions`**，会被自动拒绝。

### 坑 2：adb daemon 起不来 —— `cannot open %TEMP%\adb.log: Permission denied`

- 现象：
  ```
  10-16 21:48:09.218 20340  5424 F adb     : main.cpp:54 cannot open C:\Users\Administrator\AppData\Local\Temp\adb.log: Permission denied
  could not read ok from ADB Server
  * failed to start daemon
  adb.exe: failed to check server version: cannot connect to daemon
  ```
- 排查结果：该文件 ACL 完全正常（Owner=`BUILTIN\Administrators`，当前用户 SID `...-500` 与 `Administrators` 均为 FullControl），pwsh 对它能 `OpenWrite`、能 `Remove-Item`。所以不是 ACL 问题，怀疑是 detached daemon 进程拿到的 token/沙箱上下文与 shell 不同。
- **已验证有效的解法**：把 TEMP/TMP 重定向到工作区目录后起 daemon：
  ```powershell
  $env:TEMP = 'C:\Users\Administrator\Desktop\DSH\feiniao-android-phone\.tmp'; $env:TMP = $env:TEMP
  & $adb start-server
  ```
  起来后 5037 端口常驻，后续调用不必再重定向。
- **未定论**：到底是"删掉陈旧 adb.log"起作用还是"重定向 TEMP"起作用。重定向是已验证有效的路径。
- **对插件的影响**：插件在 DSH 进程内起 adb，若遇到同一报错，按此处理（把 `adb.log` 的落点挪到插件自己的目录）。

### 坑 3：GitHub API tree 接口输出巨大

`api.github.com/repos/.../git/trees/<ref>?recursive=1` 会返回整个仓库索引（输出溢出到临时文件、浪费约 50KB 上下文）。
**换成直接 fetch 具体源文件**：`raw.githubusercontent.com/<repo>/<ref>/<path>`。

### 坑 4：`scid` 必须 ≤ 0x7fffffff（十六进制字符串）

server 侧是 `Integer.parseInt(value, 16)`。用 `aa000001`（> 0x7fffffff）会抛
`NumberFormatException`，日志只有一句 `Server.java:215`，现象是 server 活 ~400ms 就死且没有 socket。
**规则**：`1 ~ 0x7fffffff` 的十六进制，或像插件那样用 `padStart(8,'0')` 的 8 位小写 hex。另外 socket 名是
`String.format("_%08x", scid)` ⇒ `/proc/net/unix` 里是 `scrcpy_00001a2b`，**用 `scrcpy_1a2b` 去 grep 永远查不到**。

### 坑 5：推上去的 jar 会被 CleanUp 删掉（`unlinkSelf`）

`CleanUp.main()` 第一句就是 `unlinkSelf() = new File(Server.SERVER_PATH).delete()`，而
`SERVER_PATH = System.getProperty("java.class.path")` **就是我们传的 `CLASSPATH`**。
它还是 `Os.setsid()` 的独立进程，server 死了它还活着。
⇒ 每次起流前后都要 `ensureJar()`（比对远端字节数，不一致就重推）；传 `cleanup=false` 可省掉这个进程（**已验证 jar 会保留**）。

### 坑 6：server 自己的日志不在 stdout，在 logcat（tag `scrcpy`）

`internalMain` 在 `Options.parse` 之后调用 `Ln.disableSystemStreams()`，stdout 只剩最早的
`[server] INFO: Device: [...]` 一行。要看 scrcpy 侧判断（如 `Screen streaming stopped` /
`Controller stopped` / `Using video encoder: 'OMX.hisi.video.encoder.avc'`）必须抓 `adb logcat`，
而且**过滤器里要有 `[server]` 或 tag `scrcpy`，并且不要 `slice(-N)` 截断开头**（我就是这么漏掉真因的）。

### 坑 7：~~探针 `spawnSync` 轮询会把 server 弄死~~（**已推翻，见坑 9**）

原是照着 `PROBE-0.2i-poll-ab.json` 的初判（认为观察期里 `spawnSync(adb, …)` 阻塞事件循环导致停流）。
后续对照实验证明**不成立**：A 组「什么都不做只读 TCP」同样在 ~3.9s 死，三组形态一致。
真正的变量是**隧道方向**，见坑 9。
（仍然成立的一条经验：写探针时观察期别用同步子进程阻塞事件循环，存活检测优先用 `child.on('exit')` 或"有没有新帧"。）

### 坑 8：控制通道的坐标空间是**视频尺寸**，不是设备像素 ★最坑的一个

- 现象：`INJECT_KEYCODE`（HOME/BACK）、`START_APP` 都真生效，但 `INJECT_TOUCH_EVENT`（tap/long_press/swipe/scroll）
  **完全没反应**——手机不动、宿主无报错、`log_level=warn` 的 logcat 里**一行日志都没有**、控制 socket 也没断。
- 真因（源码级，`ref/scrcpy-5.0.1/control__PositionMapper.java:34-40`）：
  ```java
  public Point map(Position position) {
      Size clientVideoSize = position.getScreenSize();
      if (!videoSize.equals(clientVideoSize)) {
          // The client sends a click relative to a video with wrong dimensions ... ignore the event
          return null;
      }
      ...
  }
  ```
  `Controller.getEventPointAndDisplayId()` 拿到 `null` 就 `return null` → `injectTouch` 直接 `return false`，
  且只在 `Ln.isEnabled(VERBOSE)` 时打一行 `Ignore positional event generated for size ... (current size is ...)`
  ⇒ **warn 级别下完全静默**。我们原来在 `session.js` 里把 `wm size` 的设备尺寸（1080x2400）塞给控制通道，
  而 `videoSize` 是编码器输出尺寸（真机实测 **808x1800**，`max_size=1800` 缩放 + 4px 对齐而来），两者不等 ⇒ 每个带坐标的事件全被丢掉。
- **规则**：`Position.screenWidth/screenHeight` 必须等于**流头带回来的宽高**，坐标也必须按这个空间的像素给。
  `actions.js` 里现在分两套坐标系：控制通道用 `ctl.screen`（视频尺寸），`adb shell input` 用 `metrics`（设备像素），
  两者都从动作表里的 0~1 归一化坐标换算。`control.js` 加了 `checkPoint()` 越界告警（前 3 次会打日志）。
- 验证：`scripts/probe-tap-verdict.mjs` —— 同一个坐标（设置页 WLAN 条目 289,1179），
  修前 control tap 无任何变化；修后 control tap ⇒ `Settings$WifiSettingsActivity`（36 个新节点）✓

### 坑 9：`adb forward`（tunnel_forward=true）会让 server ~2-4s 静默停流；改 **reverse** 后 3/3 稳活

- 现象：forward 模式下 server 起来、出几帧、然后 `MediaCodec stop` → `destroyDisplay` →
  `Screen streaming stopped` → `VM exiting with result code 0`，**全程零异常**，时间不稳定（2.0s / 3.3s / 3.9s），偶尔能活 20s+。
- 对照：同一台手机、同一份 server、同一套参数，只把隧道换成
  `宿主 createServer()` + `adb reverse localabstract:scrcpy_<scid> tcp:PORT` + `tunnel_forward=false` + `send_dummy_byte=false`，
  **3 轮 × 20s 全部稳活、每秒都有帧**（`PROBE-0.2e-reverse.json`）。
- 附带发现：reverse 模式**没有那个 dummy 字节**，流头从 0 开始，`dataStart=80`；
  `parseStreamHeader` 必须支持 `base=0`（已实现，返回 `layout:'v5-noDummy'`）。
- 现状：`startVideoStream` 默认 `tunnel:'auto'`（先 reverse，失败回落 forward）。

### 京东落点小抄（2026-10-16 真机实测，1080x2400 / 视频 808x1800）

> 结论先放这：**京东首页的 uiautomator 树不能全信**（节点坐标常和画面对不上、dump 有时只有 77 个节点且不变），
> 但**搜索框那一个节点是准的**，直接用它就行。别去猜 y 坐标。

| 步骤 | 落点 | 实测 |
|---|---|---|
| 开京东 | `phone_open`（控制通道 `START_APP`） | 406~420ms，前台变 `com.jingdong.app.mall`（首次会停 ~6s 等首页） |
| 关开屏广告 | 落到 `ProductDetailActivity`（国补广告页）就 `key BACK` | 首页那次 e2e 按了 1 次 BACK |
| 点搜索框 | 首页 `desc="搜索"` 且 `clickable=true` 的节点，中心 **979,317**（设备像素）→ `nx=0.906 ny=0.132` | 走控制通道后**一次就进** `com.jd.lib.search.view.Activity.ProductListActivity` |
| 输关键字 | `phone_keyboard {text:'牛奶'}`（控制通道 `INJECT_TEXT`，中文直接进） | 宿主 1~57ms，`chunks:1` |
| 提交 | `phone_action {action:'key', key:'ENTER'}` | 127ms，结果页文字含「牛奶」 |
| 切店铺 tab | 结果页节点文字形如 **`"店铺,,未选中"`**（在 `text` 或 `desc` 里，取决于机型/版本） | 匹配要用 `/^店铺/` 或 `/店铺[,，]/`，**不要**用 `=== '店铺'`；节点约 (761,336) |
| 进店 | 店铺列表里文字含 `旗舰店`/`专营店`/`专卖店` 的节点（如「每日鲜语官方旗舰店」405,484） | 点击后进店铺首页 |
| 店铺首页长截图 | `phone_longshot {name:'…', maxSteps:6}` | **1080x5148**、3 帧接受（dy 1494/1505）、2 帧 `too-few-matched-rows` 正确收尾、用时 16480ms |

- 搜索框那个 hint（「订鲜牛奶」/「鲜奶次日达」/「纯牛奶」）是**京东自己在轮播**，不是我们输入的内容，别拿它当证据。
- 模型路径（没有侧栏）已单独验过：`scripts/probe-ai-autostart.mjs` 全绿——`phone_open` 自己把会话拉起来（1477ms），随后 tap/中文/回车全部 `via=control`。

### 坑 10：`resolveAdb()` 原来依赖进程 cwd ⇒ DSH 宿主进程里找不到 adb ★会被忽略的那种

- 原实现（`src/android/adb.js:82`）：`path.join(process.cwd(), 'vendor', 'platform-tools', 'adb.exe')`。
  自测脚本都是 `cd dsh-android-phone` 之后再跑，所以一直没暴露；但 **DSH 宿主进程的 cwd 是 DSH 安装目录**，
  那条候选永远不命中（本机也没有 Android SDK / QtScrcpy 目录，PATH 里也没有 adb）⇒
  `/status` 返回 `devices: []`、`adbPath: null`、`ready: false`，插件所有工具全线不可用。
- 修法：`resolveAdb()` / `adbCandidates()` 增加**插件相对**候选
  `PLUGIN_ROOT/vendor/platform-tools/adb.exe`（`PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))/../..`），
  cwd 相对那条降级为兜底。和 `resolveServerJar()` 的 vendor 优先保持同一口径。
- 教训：**插件里任何「相对路径」都不能用 `process.cwd()`**（宿主 cwd 不可控），要用 `import.meta.url` 推。

### 坑 11：`.ps1` 不带 UTF-8 BOM ⇒ Windows PowerShell 5.1 报一堆假的「Missing closing '}'」★排查了半天

- 现象：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1`（**PS 5.1**）报
  `Missing closing '}' in statement block or type definition.` 指向 `if ($idx -ge 0) {`、`function Update-SkillRoot {`，
  以及一串 `Unexpected token ...`；而**同一个文件用 PowerShell 7 的解析器（`[Parser]::ParseFile`）= 0 错误**。
- 真因：install.ps1 里有中文注释而文件**没有 BOM**，PS 5.1 会按 ANSI（本机 CP936）解码 → UTF-8 中文字节变乱码 →
  其中某些字节序列被当成引号/括号，解析器从此错位。
- 修法/纪律：**脚本带中文就必须是 UTF-8 with BOM**（`[System.IO.File]::WriteAllText($p, $text, [System.Text.UTF8Encoding]::new($true))`）。
  验证方式（别猜）：`$b=[IO.File]::ReadAllBytes($p); $b[0..2]` 应为 `EF BB BF`；再用 PS 5.1 读一遍解析器错误数。
- 顺带教训：4 字节的 BOM 之争不值得花时间「猜哪一行语法有问题」，**先验证编码**。

### 坑 12：在 pwsh 里用管道接长跑 node 脚本会「看起来挂死」

- `node scripts/test-stitch.mjs 2>&1 | Select-Object -Last 6` 在 pwsh 工具里 **5 分钟没有任何输出**（其实脚本 1 秒就跑完了）。
- 可靠写法：`Start-Process -FilePath node -ArgumentList 'scripts/x.mjs' -WorkingDirectory $wd -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -NoNewWindow`，
  再 `$p.WaitForExit(60000)` + 读文件。这样既能设超时，也能在杀进程后**照旧读到已产出的 stdout**。

### 坑 13：`adb reverse --remove` 只认**设备侧** spec；拿 `tcp:PORT` 删不掉（也不报错到你能看见的地方）

- 现象：装完插件做清洁检查时，`adb reverse --list` 里**攒了 22 条** `localabstract:scrcpy_*` 映射（探针崩溃 / 宿主被强杀时 `--remove` 没跑到）。
- 实测：`adb reverse --remove tcp:3522` → `adb.exe: error: listener 'tcp:3522' not found`，exit **1**，**一条都没删**；`adb reverse --remove localabstract:scrcpy_70a97f04` → exit 0，删掉。
  （`adb forward` 是反的：`--remove tcp:PORT` 才对。reverse 的「remote」是设备侧那个抽象 socket。）
- 修法：`src/android/video.js` 新增 `sweepScrcpyReverseSync({adbPath, serial, keepPort})` —— 读 `reverse --list`、只挑 `localabstract:scrcpy_*`、**按 spec 删并检查 exit 0 才计入**、绝不碰用户自己的映射；
  - 起会话建映射**之前**先 sweep（`openSession` 里），进程退出兜底（`index.js` 的 `onExit`）也 sweep；
  - `cleanup()` 里两种 spec 都试（`localabstract:<name>` 与 `tcp:<port>`）。
- 验证：造一条假残留 → sweep 返回 `[19999]` 且列表归 0；`test-host` 36/36 通过后 `reverse --list` **残留 0**（修之前每跑一次就漏一条）。

### 坑 14：`install.ps1` 把用户 profile 里的中文写成了乱码（我们自己的脚本，最该警惕的一类）★

- **现象（肉眼）**：装完之后 `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml` 里
  `docBase: 'C:\Users\Administrator\Desktop\ecommerce-ops-assistant\运营资料库'` 变成
  `docBase: '...\杩愯惴璧勬枡搴` —— 不只乱码，**行尾那个 `'` 被 GBK 双字节吞掉了**（`E5 BA 93 27` = 运 + `'`），
  于是 YAML 里那个字符串**没有结束引号**，文件只剩 14 个非 ASCII 字符（正常 10 个）。
- **根因**：PowerShell 5.1 的 `Get-Content` / `Set-Content` **默认不是 UTF-8**（中文机器上是 CP936/GBK）；
  BOM-less 的 UTF-8 文件被它按 GBK 解码，再按 GBK 写回 → 中文全毁。我们脚本里读/写
  `package.json`、`cordis.patch.yml` 时就是这么干的。
- **修法**（`dsh-android-phone/scripts/install.ps1`）：
  - 读：`[System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)` 并去掉尾部空行（写回前统一）；
  - 写：`[System.IO.File]::WriteAllText($File, $text, (New-Object System.Text.UTF8Encoding($false)))`
    —— **不写 BOM**（保持文件原样，profile 那个文件本来没有 BOM）；
  - 自查：`node -e` 逐行比 `*.bak-android-phone` 的非 ASCII 行，必须逐字节相同（`装前=2 行 / 装后=2 行 / 完全相同=true`）。
- **附带发现（.ps1 自己的 BOM）**：`edit`/`write` 工具写文件**不会带 BOM**，而没有 BOM 的 `.ps1` 在 PS 5.1 下
  会因为中文注释被 GBK 解码而**报假语法错**（`Missing closing '}' in statement block…`，我为此绕了半天）。
  → 改完 `install.ps1` **必须确认首三字节是 `EF BB BF`**（`test-plugin-tools` 已经加了这条断言）。
- **修完的验证**：scratch profile（`%TEMP%\dshtest2\profiles\desktop`，用真实 profile 的备份当输入）
  跑「装 → 幂等重跑 → 卸载」三轮，中文**逐字节不变**、`customSkillDirs` 只出现 1 次、
  sanjip 的技能根全程保留、`dsh.profile.bundles` 不重复。

### 坑 15：模型起的会话按 760 起、侧栏一打开又重启一次；自适应档算错了方向

- **现象**：`GET /status` 看到 `session 340x760 maxSize=760 subscribers=0` —— 手机是 1080x2400，
  760 的长边只有原图 1/3，**侧栏看到的手机画面必然是糊的**（这就是「画面发虚」的另一半原因）。
- **根因 A**：`dsh-android-phone/cordis.patch.yml` 的 `video.maxSize: 760`（**包自己的 bundle patch 里带的 config**，
  不是 profile 里的）→ 模型那条 `ensureSessionForAi` 路径没有指定尺寸时就用它起会话。
- **根因 B**：`client.js` 面板挂载时还会 `POST /session`（不带尺寸 / 带旧档位），而 `Screen` 的 `GET /video`
  会按画布算一个尺寸 —— 两个尺寸不一致就**重启一次会话**（1.5s），人一打开侧栏就抖一下。
- **根因 C**：`autoMaxSize()` 原来按 `max(cssW, cssH) × dpr` 算。真机是 9:20 竖屏，编码出来的
  **宽度只有长边的 0.45 倍**；窄长侧栏（如 400x700）会被「高」那一项压住 → 只要到 720 → 编码 324x720，
  横向比画布还窄，被浏览器放大就糊。
- **修法**：① `autoMaxSize` 改成 `max(cssH*dpr, cssW*dpr/0.45)`（两个方向都要够）；② 删掉面板挂载时的
  `POST /session`，**让 `GET /video` 当唯一入口**（它才知道画布真实像素），换画质档也由它带参数重启；
  ③ `cordis.patch.yml` 的 `maxSize` 760 → **1024**（460x1024，比画布像素略多；并在注释里写明
  「别调到 1024 以下，否则人打开侧栏时会因为尺寸不一致多重启一次」）。
- **注意**：`cordis.patch.yml` 是 **bundle patch**，改了要**重启 DSH** 才生效；
  `client.js` 改完**硬刷新侧栏**就生效（本次两处都改了，所以用户端要做一次「刷新 + 重启」）。

### 坑 16：DSH 宿主里 `adb` 起不来自己的常驻 daemon（设备列表空、截图全 500）★2026-10-16 深夜，用户重启后暴露

- **现象**：用户重启 DSH 后侧栏显示「未连接 / 未发现设备 / 在线设备 0 台」，动作失败、`快照 HTTP 500`。
  `GET /dsh-android-phone/api/status` 返回 `ready:false, devices:[]`，但手机明明插着。
- **原文**（宿主进程里跑 adb 的输出）：
  ```
  * daemon not running; starting now at tcp:5037
  F adb : main.cpp:54 cannot open C:\Users\Administrator\AppData\Local\Temp\adb.log: Permission denied
  could not read ok from ADB Server
  * failed to start daemon
  adb.exe: failed to check server version: cannot connect to daemon
  ```
- **不是 ACL、不是 TEMP 不可写**：`ADB_TRACE` 是空的、`%TEMP%\adb.log` 根本不存在、pwsh 对 `%TEMP%` 能写能删。
  手动 `New-Item adb.log` 也没用；把 `TEMP` 换成一个全新目录也没用；
  用 WMI 在**进程树外**跑 `adb start-server` 同样失败。
- **根因范围**：DSH 的进程沙箱让 adb **fork 出去的 daemon 子进程**丧失写权限；而
  **同一个 adb.exe 用 `nodaemon server` 前台跑（就在本进程树里）完全正常**，设备立刻列出来。
  已实测的对照：`adb -L tcp:5037 nodaemon server` 起得来，`adb start-server` 起不来。
- **修法**（`dsh-android-phone/src/android/adb.js`）：新增
  - `ensureAdbServer({adbPath, port})`：端口没在听就 `spawn(adb, ['-L','tcp:<port>','nodaemon','server'], {stdio:'ignore'})`，
    每 250ms 探一次端口，最多 12s；**单飞**（并发只引导一次），`already:true` 表示有人在听。
  - `looksLikeDaemonDown(r)` + `adbRun()` 包装：**任何** adb 命令的输出命中
    `could not read ok from ADB Server | cannot connect to daemon | failed to start daemon | cannot open .*adb.log`
    就先自举再重试一次（`opts.ensureServer === false` 可关）。这样所有 20 多处 adb 调用点一行都不用改。
  - server 是插件的**前台子进程**：DSH 退出它一起走，不留残留（实测：探针进程退出后 server 也消失，符合预期）。
- **探针**：`scripts/probe-adb-bootstrap.mjs`（报告 `PROBE-P2-adb-bootstrap.json`，**PASS**）：
  先 `taskkill /F /IM adb.exe` 造冷启动 → 裸 adb 确认 `daemonDown:true` → 走插件 adb 层 **5.3s 自举成功、拿到设备** →
  第二次 `ensureAdbServer` 返回 `already:true`（1ms，不重复起进程）。
- **兼容性**：若电脑上本来就有能用的 adb server（例如用户自己开过 QtScrcpy），`ensureAdbServer` 直接
  `already:true`，不会去抢端口。
- **注意**：`adb.js` 是宿主编译期加载的，**改完要重启 DSH 才生效**；重启前的临时救法是
  在进程树外起一个常驻 server：
  `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='"<vendor>\adb.exe" -L tcp:5037 nodaemon server'}`
  （父进程是 `WmiPrvSE`，不受 DSH 沙箱影响，重启 DSH 也不会被带走）。

### 坑 17：侧栏 UI 「看不清」——字太小、浅色主题下颜色几乎看不见、窄面板把按钮挤掉

- **现象**（用户截图）：整页 13px 小字、状态胶囊是淡粉/淡灰几乎看不见；窄面板里「输入 / 提交」被挤到看不见；
  没画面时是一大片空白，只有底下一行小字说失败。
- **根因**：① 字号写死 13px，面板宽也不放大；② 颜色写死深色主题的 `rgba(255,255,255,x)` 与
  `#9ff0b8/#ffb3b3/#ffd28a`，在 DSH 的浅色主题下对比度极低；③ 按钮没写 `flexShrink:0/nowrap`，
  窄面板下被压扁裁掉；④ 没画面时没有任何占位提示。
- **修法**（全在 `dsh-android-phone/client.js`）：
  - `autoFont(panelWidth, zoom)`：`clamp(13, 面板宽/34, 20)` × 手动倍率；`ResizeObserver` 量面板宽度，
    根节点上设 `fontSize`，**其余尺寸全部改成 em**（padding/gap/borderRadius/胶囊字号）→ 一起缩放。
  - 新增 **A− / A+** 两个按钮（`data-zoom="out|in"`），倍率存 `localStorage['dsh-android-phone.zoom']`（0.8~2.0）。
  - 配色改成中性灰半透明 + 彩色描边 + `fontWeight:600`（深浅主题都能看清），文字一律 `color: inherit`。
  - 按钮 `flexShrink:0 + whiteSpace:nowrap`，输入框 `flex:1 1 7em / minWidth:4.5em`，行 `flexWrap` → 窄面板换行而不是裁掉。
  - 舞台新增占位层（`data-overlay="no-device" | "no-stream"`）：没设备时写清「① 数据线 ② USB 调试 ③ 手机上点允许」
    并给「↻ 重新检测」；连上了但没起流时给「▶ 起流」。
- **回归**：`scripts/test-client.mjs` **40/40 全绿**（含坐标换算、滚轮合并、铺满/完整口径）。
- **生效方式**：`client.js` 改完**硬刷新侧栏**即可，不需要重启 DSH。
- **补充（用户 2026-10-16 深夜反馈）**：用户说「看不清是因为主题的原因，我界面本来是白色的，字体颜色浅，换成深色就好了」
  ⇒ 确认根因就是**浅色主题对比度**（深色主题下原来的配色也能看）。坑 17 的改法（中性灰 + 彩色描边 + 字号自适应）
  让浅色主题同样可读，已用离屏渲染出光/暗两套图人眼确认（`recon/ui-preview/*.png`，见坑 19）。

---

### 坑 18：「鼠标点完一会手机才会动」——99% 的延迟花在动作**之前**的 adb 往返上 ★2026-10-16 深夜

- **现象**（用户）：侧栏里用鼠标点一下手机画面，要等「一会」手机才动。
- **实测（真实宿主 19387，控制通道已就绪 `via=control`）**：
  - `POST /action {action:'wait', ms:1, human:true}` → **533 / 521 / 564 / 583 / 534 ms**。
    `wait` 动作**根本不碰手机** ⇒ 这 520~580ms 全是动作之前的固定开销。
  - 拆开量（`%TEMP%\fx-parts.mjs`）：`pickDevice`(adb devices) **~57ms** + `screenMetrics`(wm size/wm density/dumpsys window)
    **~190ms** + 动作后 `currentFocus`(dumpsys) **~150ms** ≈ 400ms，加上 HTTP 与动作本身 ≈ 540ms。
  - 而控制通道写一条 INJECT_TOUCH_EVENT 只要 **~115µs**（P1 时实测）⇒ **99% 的延迟花在「问手机自己是谁」上**。
- **修法**（`dsh-android-phone/index.js` + `src/android/actions.js` + `client.js`）：
  1. `index.js` 模块级 `MODULE_DEVICE_CACHE`（`DEVICE_TTL_MS = 20_000`、`DEVICES_TTL_MS = 1_500`）+ `invalidateDevice()`：
     `resolveSerial` 改成 **explicit → 会话里的 serial → 缓存 → 才问 adb**；新增 `metricsFor()`（缓存设备像素尺寸）
     与 `listDevicesCached()`（给每 5s 轮询的 `/status` 省 adb）。
  2. `doAction`：**有控制通道就用 `ctl.screen`（video 尺寸，坑 8）当 metrics，一个 adb 都不跑**；
     `settleMs = by === 'human' ? 0 : (args.settleMs || 120)`；**人的动作不回读 `currentFocus`**（省 ~150ms，侧栏不读这个字段）；
     `runAction` 抛错时 `invalidateDevice()` 再抛。
  3. `actions.js` 的 `runAction`：`const m = vp || metrics || (await screenMetrics(...))` —— 有控制通道时**不再现场量屏幕**。
  4. `client.js`：`ownerRef` 记录当前控制权，`claimHuman()` **已经是人就跳过 `POST /takeover`**（以前每点一下都多一个往返）。
- **⚠️ 踩坑记录**：第一版把 `deviceCache` 写在 `buildToolDefs` 函数体里 —— 而 `buildToolDefs` 是
  **每个 HTTP 请求现场调一次**（`const buildToolset = () => buildToolDefs(...)`，index.js:838/857/913），
  等于每请求一个空缓存。实测「修复后」仍然是稳定 270ms 没变，才回头发现。**缓存一律放模块级**。
- **复验（假宿主 `scripts/serve-api.mjs` :19399，动作全用 `wait`，不碰手机）**：

  | 请求 | 修复前 | 修复后（模块级缓存） |
  |---|---|---|
  | 纯 HTTP 地板（`POST /takeover`，不碰 adb） | 8~15ms | 5~15ms |
  | `POST /action {wait, ms:1, human}` 固定开销 | **~270ms** | **~9~31ms**（首次冷 75ms） |
  | `POST /action {wait, ms:300}` | ~570ms | ~311~325ms（= 300 + ~20ms 固定） |
  | `POST /action {key:'WAKEUP'}`（无控制通道，走 adb） | 373ms | 129ms（剩下的是 adb keyevent 本身） |
  | `GET /status`（缓存后，仍含 deviceProps + currentFocus） | ~380ms | ~220ms |

  ⇒ 控制通道路径上，**人的一次点击从 ~540ms 固定开销降到 ~20ms**（20~25 倍），剩下的是视频回传本身的延迟。
- **生效方式**：改的是 `index.js` / `src/**` ⇒ **必须重启 DSH**；`client.js` 那部分**硬刷新侧栏**即可。

---

### 坑 19：改侧栏 UI 看不见效果 —— 用 jsdom + 本机 Chrome 离屏出图（`scripts/preview-panel.mjs`）

- **为什么需要**：侧栏 UI 的改动要「人眼验收」，但每次改动都让用户重启 DSH / 硬刷新侧栏再看，反馈太慢；
  而 `test-client.mjs` 只验行为（DOM 结构 + fetch body），**验不了「看不清」**。
- **做法**（零新依赖，复用 `.client-test/node_modules` 里已有的 jsdom + react + 本机 Chrome）：
  `client.js` 用 `react-dom/client` 真挂载到 jsdom，`ResizeObserver` 打桩喂面板宽度，
  再把 DOM 序列化成 HTML；调本机 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`）
  `--headless --screenshot --window-size=Wx2H --force-device-scale-factor=2` 出图。
  三种场景（`no-device` / `ready-idle` / `streaming`）× 光亮两套主题 = 6 张 PNG，落 `recon/ui-preview/`。
- **踩坑**：① `new JSDOM(html, {pretendToBeVisual:true})` 不给 `url` 时是 opaque origin，
  `localStorage` 直接抛 `SecurityError: localStorage is not available for opaque origins` → 要传 `url:'http://localhost/preview'`；
  ② react/react-dom 是 19.3.1，**没有 UMD 包**，只能用 ESM `react-dom/client`。
- **用途**：以后任何侧栏 UI 改动都先跑它出图，人眼确认后再让用户刷新。参考实现见 `scripts/preview-panel.mjs`。

### 坑 20：浅色主题下「字体发灰」= 用了 DSH 并不存在的 `--vscode-foreground` ★2026-10-17

- **症状**：用户（浅色主题）说侧栏「看不清、字体发灰」，深色主题下正常。
- **真因**：`client.js` 的 `S.root.color` 是 `var(--vscode-foreground, #d4d4d4)`。DSH 侧栏**没有** `--vscode-foreground`
  （那是 VS Code Webview 的变量名），于是所有继承 `color` 的元素都落到兜底的**浅灰 `#d4d4d4`** → 白底上对比度 ≈ 1.6:1。
- **修法**：不再猜变量名，**直接问宿主**——`getComputedStyle(rootEl.parentElement).color` 就是这个主题下"正文该是什么色"，
  由它派生一套 CSS 变量：`--dshp-fg` / `-soft` / `-faint` / `--dshp-line` / `-line-strong` / `--dshp-fill` / `-fill-strong`
  （半透明描边/填充的 alpha 按亮度分深浅两套）。宿主换主题时用 `MutationObserver` 盯
  `documentElement`/`body` 的 `class/style/data-theme/data-color-mode/data-mode` + `matchMedia('(prefers-color-scheme: dark)')` 立即重取。
- **配套**：`parseColor()` 认 `rgb()/rgba()` 与 `#rgb/#rrggbb/#rrggbbaa`；`fade()` 从该色派生弱化色；全屏时钉死浅色文字（画面是黑的）。
- **教训**：**不要用别的宿主的 CSS 变量名猜颜色**，能读计算样式就读。

### 坑 21：离屏预览（坑 19 的 harness）三连坑 —— 图上永远看不出主题差别 ★2026-10-17

- ① jsdom 的 `getComputedStyle` **不解析 `<style>` 样式表**（也不做继承），只对**自己身上有内联色**的元素给得出 `color`
  ⇒ 预览里必须把宿主色写成内联样式，并在桩里兜底回落。
- ② `client.js` 里 `getComputedStyle` 是**无前缀调用**，在 `new Function('window','document',…)` 沙箱里会一路找到 **Node 的 globalThis**，
  那里**没有**这个函数 ⇒ 抛 ReferenceError 被 `themePalette` 的 try 吞掉 → 静默走兜底色。预览里必须 `global.getComputedStyle = …` 补上。
- ③ 补的时候**不能**写 `w.getComputedStyle = global.getComputedStyle` 然后在桩里又调 `w.getComputedStyle(...)` —— 自递归，
  报 `Maximum call stack size exceeded`（同样被 try 吞掉，表现还是"颜色没变"）。
  必须先 `const origGCS = w.getComputedStyle.bind(w)` 抓住原件再覆盖。
- **诊断经验**：这类"改了没效果"的问题，先在关键函数里挂受开关控制的日志（`window.__dshpDebug`）看**它到底有没有被调用**；
  我这次先怀疑配色、再怀疑选择器，最后才发现是调用根本没进来。

---

### 坑 22：拖拽「一次拖拽的比较少」= 客户端发一次 swipe 就闭锁，不是 scrcpy 慢 ★2026-10-17

- **旧实现（`client.js` 的 `Screen`）**：pointerdown 记起点 → pointermove 累计位移 > `0.05` 屏就**只发一次** `POST /action {action:'swipe', ms:260}`，紧接着
  `g.done = true`；之后鼠标再动，`if (!g || g.done) return;` 直接丢掉。⇒ **鼠标动 300px 和动 1000px，手机收到的都是同一次 260ms 的闪现**，
  观感就是"拖一下，手机才挪一点点"。旧的 `TAP_MAX_MS=380`/`TAP_MAX_MOVE=14` 就是为这套"宿主猜手势"服务的。
- **新模型（逐事件回放，跟手机触摸屏一样）**：
  - `pointerdown` → 立即 `touch down`；`pointermove` → **8ms 合并**后 `touch move`（只送最新位置，永不闭锁）；`pointerup/cancel` → **必发** `touch up`；
  - 轻点 = 原地 down+up、长按 = down 后停留再 up、拖拽 = down+move*+up —— Android 自己按时间/位移判定，**宿主不再猜**；
  - 位移阈值只用来决定"要不要发 move"（`MOVE_EPS = 0.0015` 屏，防抖动刷屏），不参与手势语义。
  - 客户端新增常量：`MOVE_MERGE_MS = 8`、`MOVE_EPS = 0.0015`、`DRAG_EPS = 0.006`。
- **顺序不能乱**：新增**单飞有序队列**（`queueRef = {busy, q}` + `pump()`），保证 `down → move → up` 严格按序发；
  move 塞进队列时如果队尾还是未发的 move 就**替换**它（只保留最新位置），队列总长上限 32 条，防鼠标狂扫时堆成延迟。
- **宿主侧**：`actions.js` 新增动作类型 `touch`，用 `pendingTouch`（key = `<serial>|<by>`）维护一次手势的起点：
  `phase:'down'` 记起点并发 DOWN；`'move'` 只发 MOVE（**不落 pending，纯位移**）；`'up'` 发 UP 后清 pending；
  **没有控制通道（adb 回落）时，宿主把整条事件流攒成一次 `adb input tap/swipe`**（位移 < 1.2% 屏 → tap，否则 swipe，时长按实际耗时估）
  ⇒ 客户端逻辑统一，不需要自己判断走哪条后端。
- **坐标坑（老坑 8 的延续）**：控制通道吃的是**视频尺寸**下的坐标，客户端送的是面板归一化值（0~1），宿主乘 `ctl.screen`；探针里用 `/status` 的**设备像素**除，两者只差一个等比缩放。

### 坑 23：滚轮一格 = 0.2 屏 ⇒ 一滚就飞；改成按 deltaY 累积、每格 100 单位 ★2026-10-17

- **旧实现**：`wheel` 在 16ms 窗口里累加 `deltaY`，`pages = clamp(|acc| / 240, 0.2, 1.2)`，然后走 `scroll` 动作（`adb` 时代是 swipe 模拟）。
  ⇒ ① **下限 0.2 屏**让最小的滚轮动作也翻天覆地；② 一格（Windows 上 `deltaY = 100`）刚好落在 0.42 屏，和鼠标"一格滚一点"的直觉不符；
  ③ 上限 1.2 屏在大滚动时又太慢；④ 余数直接丢掉，慢速微调全被"最小 0.2 屏"吃掉。
- **新实现**：`WHEEL_PER_DETENT = 100`（deltaY 单位/格）、`WHEEL_MAX_NOTCHES = 12`（一次最多 12 格）；
  `deltaMode === 1`（按行）时 ×16 折算；差值先累进 `carryRef`，凑够 ≥1 格才发 `POST /action {action:'wheel', notches}`，余数留到下次；
  **1 格 ≈ 0.08 屏**（真机实测 192px，见坑 25；回归测试里 8 格 ↔ `notches≈8`）。
- **协议侧**：`control.js` 的 `scroll(x, y, {notchesV, notchesH})` = **一格发一条** `INJECT_SCROLL_EVENT`（`hScroll`/`vScroll` 定点值 = `round(v*2048)`，量程 ±`SCROLL_MAX_UNITS=16` 夹取），
  不再拿"整屏/秒"去凑 swipe 时长；`wheel()` 保留为按格数循环的语法糖。
- **为什么必须一格一条**：Android 的滚轮是**离散步进**（list fling 逐格累加），一次送 5 格和分 5 次各送 1 格在部分列表上观感不同；分开送还能让"滚一点停一点"立刻响应。

### 坑 24：固定端口的旧 `serve-api` 僵尸进程 ⇒ 所有"改完重跑"都被旧代码回答 ★2026-10-17，最费时间的一个

- **现象**：给 `step` 加字段、加 `console.log`、甚至把赋值改成无条件的临时补丁，**HTTP 返回里始终看不到**
  （`step.sent` 一直是 `null`，`detail` 恒为 `↑ 3.00 格`），而服务本身一切正常；
  连续三轮"修完重跑"数据**一模一样**，让人以为是模块缓存/对象复用/序列化问题，查了半天。
- **根因**：`node scripts/serve-api.mjs --port 19399` 的**旧实例一直在监听 19399**（pid 19200，早先启动的）；
  后面每次 `Start-Process` 起的新实例都在 `listen` 时 **`EADDRINUSE` 直接退出**（stderr 里有，但我只看探针输出没看这个文件），
  于是所有请求都被**旧进程**用**旧代码**回答。
- **怎么发现的**：`netstat -ano | findstr :19399` 显示 `LISTENING 19200`，`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`
  里有 `"D:\Xin\node.exe" scripts/serve-api.mjs --port 19399`；而 `%TEMP%\fx-s*-err.txt` 里躺着 `code: 'EADDRINUSE'`。
- **纪律**：
  1. 起假宿主**一律 `--port 0`**（系统分配），从 stdout 的 `SERVE_API_PORT=<port>` 读实际端口，别写死；
  2. 跑之前先确认没有僵尸：`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*serve-api.mjs*' }`；
  3. `serve-api.mjs` 已加 `server.on('error')`：`EADDRINUSE` 时打印「端口 X 已被占用：很可能有旧的 serve-api 还在跑（那是旧代码！）」并 `exit 1`。
  4. 更一般的教训：**改了代码却"完全没生效"时，先证明"跑的是不是新代码"**（加一行只有新代码才有的输出/字段），别在语义层硬猜。

### 坑 25：`INJECT_SCROLL_EVENT` 的方向是「负 = 前进」，跟直觉相反 ★2026-10-17 真机实测

- 对外/对内约定：**`notches` 正 = 内容前进（= 鼠标滚轮往下滚）**；线上协议里则相反。
- 最终标定（`PROBE-P4-drag-wheel.json`，京东结果页列表，滚轮打在 (0.5,0.55)，屏幕 1080x2400）：
  | 对外 `notches` | 线上 `vScroll` | 实测内容位移 |
  |---|---|---|
  | +1 | -1 | **+192 px**（前进） |
  | +2 | -2 | +384 px |
  | +3 | -3 | +576 px |
  | +6 | -6 | +1152 px |
  | -1（列表顶部） | +1 | **0（被夹住）** |
  | +3 再 -3 | +3 再 -3 | **净差 0 px**（回到出发位置） |
- ⇒ `src/android/control.js` 的 `scroll()` 里**把 `notches` 取负再写进协议**（唯一真源；`client.js` 与模型的 `notches` 语义都不用动）。
- 标定值：**1 格 ≈ 192 设备像素 ≈ 0.08 屏**（1080x2400）。旧实现"一格 0.2~0.42 屏"粗了 3~5 倍。
- 教训：**方向别靠读源码猜**（scrcpy 的 `control_msg.h` 只说 `/16` 定点，没说正负对应页面哪边），要么真机量、要么找官方客户端的调用点对照。

### 坑 26：验证「滚动到底有没有动」——测量方法连错两次 ★2026-10-17

- **错法 1（文本锚点优先）**：用 uiautomator 节点的 `y` 位移当尺子，但锚点集合里混进了**静态页头**
  （搜索框、筛选条、"京东热搜" banner）⇒ 中位数被拉成 **0**，明明滚了也判成"没动"（一度以为滚轮全废）。
  - 修：锚点**只取列表区域内的节点**（`y >= 最大 scrollable 的 bounds.y1`），且只在像素法不可信时兜底。
- **错法 2（像素法单帧判负方向）**：京东结果页是**重复商品卡**，行剖面估计器会周期性混叠 ——
  往回滚 192px 被估成 **+244px**，或被判 `too-few-matched-rows` / `no-motion`。
  - 修：往回滚改用**往返不变量**：`+3` 前进 576px → `-3` 后两张图必须一致（净差 < 60px）。
    既躲开混叠，又正好等于用户关心的"能不能滚回去"。
- 判据优先级固定为：`accepted===true` 的像素法 > 文本锚点 > `null`（测不出，**不计入断言**）。
- 一般教训：**"功能好像没动" 先怀疑尺子**。本次靠一个 5 分钟的 A/B 对照（滚轮前后截图字节 1.39MB→1.25MB、
  `tap` 落到 `ProductDetailActivity`）才定位到"注入一直是好的"。

---

## 4. 改动点坐标（工作区副本的行号，逐步补全）

| 文件 | 行号（**改前**的基线行号） | 内容 | 现状 |
|---|---|---|---|
| `src/android/video.js` | `:201` | `control=false` → `control=true` | ✅ 已改（并且隧道改 reverse，见坑 9） |
| `src/android/video.js` | `:40-41` | 硬编码 `C:\Users\30716\...` / `D:\Ruan\...` | ✅ 已清（vendor 优先 + 动态扫描） |
| `index.js` | `:597-625` | 写帧无背压（`backpressure` 建了又 `void`） | ✅ 已改：`writableLength > 512KB` 只丢**非关键帧**（关键帧/config 必投） |
| `index.js` | `:692-698` | `/snapshot?scale=` 纯 JS 逐像素三重循环 | ✅ 已改：最邻近抽样，只取目标像素（不再逐源像素） |
| `client.js` | `:231` | `decodeQueueSize > 12` 才丢帧 | ✅ 已改：阈值 **2** |
| `client.js` | `:249` | `while (decodeQueueSize > 10) await sleep(4)` | ✅ 已改：阈值 **2** |
| `client.js` | `:28-32` | `QUALITY` 分辨率档拍脑袋 | ✅ 已改：新增 `auto` 档（按面板 DPR + 竖屏 0.45 宽高比取桶），maxFps 60 |
| `client.js` | `:142-160` | 快照兜底"每秒 2 张"更贵 | ✅ 已改：手动「快照」按钮（静音一次）+ 仅出错时出图，不再定时轮询 |
| `client.js` | pointermove 分支 | 拖拽发一次 swipe 就 `done=true` 闭锁 | ✅ 已改：逐事件 `touch down/move/up`（坑 22） |
| `client.js` | wheel 合并 | 一格 = 0.2~1.2 屏 | ✅ 已改：`WHEEL_PER_DETENT=100` deltaY/格（真机 192px ≈ 0.08 屏；方向在宿主取负，坑 23/25） |
| `client.js` | `S.root.color` | `var(--vscode-foreground, #d4d4d4)`（DSH 没这个变量 → 浅色下发灰） | ✅ 已改：从宿主容器文字色派生 `--dshp-*` 调色板（坑 20） |
| `src/android/actions.js` | `:413-419`（`adb.js`） | `typeText` 中文直接抛错 | ✅ 控制通道 `INJECT_TEXT` 已支持中文；adb 回落仍只支持 ASCII |

---

## 5. 阶段进度

- [x] **阶段 0.1** 定位/安装运行环境：vendor platform-tools 37.0.1 + scrcpy-server v5.0.1；设备已识别
- [x] **阶段 0.2** 单会话起流：`control=false` 时只连 video 就能出帧（插件路径已验证 21s 连续出帧）；
      `control=true` 时**必须先连 video 再连 control**，否则 server 卡在 `accept()` 不吐流头（实测只收到 1 字节 dummy）
- [x] **阶段 0.2b** 控制通道可用性：`control=true` + 控制口连上后 server 正常出流并打印 `Controller stopped`（生命周期完整）
- [x] **阶段 0.2c** `INJECT_KEYCODE(HOME)`/`START_APP` 真落地；`INJECT_TOUCH_EVENT` 曾全无反应 → **真因已定位并修好（坑 8）**
- [x] **阶段 0.3** 核对 `ControlMessage.java` 的 type 常量值（0..22，与 `control_msg.h` 顺序一致）
- [ ] **阶段 0.4** `clipboard_autosync=false` 被 server 接受 —— **没直接实测，也不再需要**：我们不传这个选项；控制口对未知设备消息本来就只计数不猜（`stats.unknownDeviceMsg`）。真要传，起流第一次就会因参数非法而失败。
- [ ] **阶段 0.5** `writeDisableStream` 的 `code[3]=0/1` —— **未实现**（若设备侧因编码器故障送 4 字节 disable 消息，表现会是流头解析失败并重试一条新会话；至今真机没遇到过）。原计划里这条曾被误标为已完成。
- [x] **阶段 0.6** 隧道方向：forward 会 ~2-4s 静默停流，改 **reverse** 后 3/3 稳活 20s（坑 9）
- [x] **阶段 1.1** `control.js` 编解码器写完（字节数与 `ControlMessageReader` 逐字段对齐；`wheel()` 的推进 bug 已修）
- [x] **阶段 1.2** `session.js` + `video.js` 改单会话（video+control 一个 server 进程）+ 崩溃自愈 + 空闲停流
- [x] **阶段 1.3** `actions.js` 切后端（控制优先、adb 回落、返回 `via`）—— **坐标系已修正**（坑 8）
- [x] **阶段 1.4** 控制权状态机（AI 优先/人可强抢/租约）+ `phone_takeover` + `/takeover` `/owner` `/session` 路由
- [x] **阶段 1.5** 真机延迟对照：控制 tap 宿主 **115µs**（max 149µs）vs adb `input tap` **91ms** ⇒ **791×**
- [x] **阶段 1.6** 京东端到端回归 —— **20 项全绿**（`PROBE-P1-e2e-jd.json`）：控制权→单会话(reverse)→开京东(406ms)→点搜索框(979,317)→中文「牛奶」→ENTER→结果页含关键词→店铺 tab→进「每日鲜语官方旗舰店」→**长截图 1080x5148 / 3 帧 / 16.5s**
- [x] **阶段 1.7** 模型独立路径（没有侧栏）：`phone_open` 自己把会话拉起来（1477ms），之后 tap/中文/回车全 `via=control`（`PROBE-P1-ai-autostart.json` 全绿）
- [x] **阶段 1.8** skill 生产脚本 `skills/jd-mall-capture/scripts/jd-shop-longshot.mjs` 真机跑通：**exit 0、10/10 PASS、长截图 1080x5147**；同时改 `SKILL.md`（落点小抄 + activity 判据 + 排错表）
- [x] **阶段 2.1-2.3** 宿主丢帧（`writableLength > 4MB` 丢帧）/ 客户端队列压到 2 帧 / `maxSize` 按 DPR 自适应 —— 代码已落地，待真机画质对比
- [ ] **阶段 2.4** "平台糊 vs 插件糊"基线测量
- [x] **阶段 3.1** `vendor/` 打包 + 查找顺序提前（`resolveServerJar`/`resolveAdb` 都优先 vendor）；裁掉 fastboot/sqlite3 等无关二进制（vendor 9.9MB）
- [x] **阶段 3.2** 清掉硬编码用户路径（`grep 30716` 已为空）
- [x] **阶段 3.3** `install.ps1` 增加 skill 根注册（`Update-SkillRoot`，并进已有 `customSkillDirs`、卸载时摘除）；用 scratch profile 跑通「装 / 幂等重跑 / 卸载」三轮，**dsh-sanjip-ops 的技能根始终保留、`customSkillDirs` 不重复**
- [x] **阶段 3.4** 回归全绿（35+40+36+30）＋ `README.md`/`安装说明.txt` 按 v0.2.0 重写
- [x] **阶段 3.6** 安装后清洁检查：设备无残留 `app_process`；`adb reverse` 泄漏（22 条）已修（坑 13）并回归验证
- [x] **阶段 3.5** 装进**真实** desktop profile + 用户重启后**已在真实宿主里加载**：`GET /dsh-android-phone/api/status` 由 404 变 ALIVE；走真实宿主跑 `POST /shot {mode:'long'}` → **1080x5079 / 3.7MB / quality.ok**；控制权验收 **9/9**（`ACCEPT-live-owner.json`）；设备侧无残留进程与 reverse 映射。**只剩人眼画质确认**
- [x] **阶段 3.7** 修掉「模型起会话按 760 起 + 侧栏挂载重复起会话 + 自适应档算错方向」（坑 15）：`autoMaxSize` 两个方向取大、删掉挂载时的 `POST /session`、`cordis.patch.yml` 默认 1024
- [x] **阶段 3.8** 修掉 `install.ps1` 用默认编码读写 profile 导致中文被写坏（坑 14）+ 中文逐字节回归（scratch profile 三轮）+ `test-plugin-tools` 加 BOM/编码两条断言 → **33/33**
- [x] **阶段 2.5**（第三轮，坑 18）修「鼠标点完一会手机才动」：模块级设备缓存 + 控制通道用 `ctl.screen` 当 metrics（动作前的 adb 往返清零）+ 人的动作不回读前台 + 已是 owner 时不重复 `/takeover`。假宿主复验固定开销 **~270ms → ~20ms**；**真实宿主复验 `POST /action wait` = 4~5ms**（原来是 533~583ms）；`test-client` 40/40 仍全绿
- [ ] **阶段 2.6** 视频回传本身的延迟（编码器 + adbd + 解码渲染）**尚未测完** —— 坑 18 修完后剩下的就是这一块；
      第四轮已加了一把尺子（侧栏底栏 `解码 Nms` + `frameAgeMs`，见 §1d），重启后读它就能分清是手机/网络慢还是浏览器慢
- [x] **阶段 2.7**（第四轮，坑 20/21）侧栏浅色主题可读性：调色板改为从宿主文字色派生（不再用不存在的 `--vscode-foreground`）；
      宿主换主题时自动重取；输入框挪到独立一行（窄面板不再被裁）；`maxFps` 30→60、canvas 后备存储按面板设备像素、`desynchronized`、
      宿主与 socket 全开 `setNoDelay`。离屏预览两套主题均已人眼确认（`recon/ui-preview/`），`test-client` 40/40 全绿
- [x] **阶段 2.8**（第五/七轮，坑 22/23/25/26）鼠标手势重做：拖拽改**逐事件回放**（down/move/up，8ms 合并、单飞有序队列、永不闭锁）；
  滚轮改**按格**（`WHEEL_PER_DETENT=100` deltaY 单位/格，真机标定 **1 格 = 192px = 0.08 屏**，余数 carry；方向在宿主取负，见坑 25）；
  宿主新增 `touch`/`wheel` 两个动作类型，adb 回落时把事件流攒成一次 tap/swipe。
  `test-client` 40/40 全绿；**真机 16/16 PASS**（`PROBE-P4-drag-wheel.json`，2026-10-17 09:3x 手机空着时跑的）：
  滚轮 `+1/+1/+3/+2/+6` → 192/192/576/384/1152px（线性）+ 顶部夹住 + `+3→-3` 往返净差 **0px**；
  拖拽 `down+14move+up` 16 事件 **481ms**、位移 **+902px**（期望 720，1.25×）、拖回净差 **24px**；滚轮消息宿主侧 **0~1ms**
- [ ] **阶段 2.9**（承接用户 2026-10-17「经常有弹窗，比较复杂」）**弹窗/前台被抢的自愈目前只在探针里，还没进插件**：
  需要 `phone_open` 与 skill 生产脚本在「落地页不是预期 Activity」时自动 BACK 重试几轮（探针 `probe-drag-wheel.mjs` 的
  `settleJd()` 就是可复用的 5 轮循环：`/open` → 等 1.5s → 查 `/status.foreground.activity` → 不是 `/MainFrameActivity/` 就 BACK）

### 探针清单（`dsh-android-phone/scripts/`，都在真机上跑过）

| 脚本 | 作用 | 报告 |
|---|---|---|
| `probe-session-matrix.mjs` | A/B/C/D 四场景：control 关/开、控制口连/不连/迟连 | `PROBE-0.2c-session-matrix.json` |
| `probe-server-lifetime.mjs` | 无客户端 vs 只读 video 的 server 存活 | `PROBE-0.2d-*.json` |
| `probe-plugin-stream.mjs` | **走插件真实 `startVideoStream`**，观察 20s | `PROBE-0.2d-*.json` |
| `probe-cleanup-kill.mjs` | `pkill` 与 jar 的关系（证实 CleanUp 删 jar） | — |
| `probe-bisect.mjs` | 5 变体二分（因 codecOptions / remotePath 名称） | `PROBE-0.2f-bisect.json` |
| `probe-stop-reason.mjs` | `cleanup=false` 是否治 3.8s 退出 + 抓 logcat | `PROBE-0.2g-stopreason.json` |
| `probe-server-logcat.mjs` | **捞出 scrcpy 自己的日志**（logcat tag `scrcpy`） | `PROBE-0.2h-serverlog.json` |
| `probe-poll-ab.mjs` | A 不轮询 / B spawnSync 轮询 / C spawn 异步轮询（**推翻坑 7**） | `PROBE-0.2i-poll-ab.json` |
| `probe-stop-trace.mjs` | 全量异步 logcat + 空闲 vs 抖屏两阶段（抖屏救不了） | `PROBE-0.2j-stop-trace.json` |
| `probe-reverse.mjs` | **reverse 隧道 3/3 稳活 20s** + 原始字节 hex 转储（坑 9 的证据） | `PROBE-0.2e-reverse.json` |
| `test-plugin-tools.mjs` | 离线自测 33 项：编码器字节数、坐标、工具注册、控制权模型、`install.ps1` BOM/编码断言 | `PROBE-P1-tools.json`（33/33 PASS） |
| `probe-drag-wheel.mjs` | **鼠标手势真机验收**（坑 22/23/25/26）：`touch down+up` 落地 → 滚轮方向/一格多少像素/往返不变量 → 拖拽 16 事件跟手位移与回位。**起假宿主必须 `--port 0` 并读 stdout 的 `SERVE_API_PORT`（坑 24）**；前台不是京东会立刻退出（手机被人用着时不乱点）。2026-10-17 手机空着时 **16/16 PASS** | `PROBE-P4-drag-wheel.json` |
| `test-session.mjs` | 阶段 1 验收：单会话长跑 / 控制口 / HOME 真落地 / 延迟对照 | `PROBE-P1-session.json`（11/11 PASS） |
| `test-e2e-jd.mjs` | 京东端到端：会话→开京东→点搜索框→中文输入→回车→结果页 | `PROBE-P1-e2e-jd.json` |
| `probe-tap-capability.mjs` | 设置页 + 京东首页 y 扫描，判定 tap 是否生效 | `PROBE-P1-tap.json` |
| `probe-tap-verdict.mjs` | **裁决 tap**：同坐标 control vs adb 对照（坑 8 的证据） | `PROBE-P1-tapverdict.json` |
| `probe-touch-matrix.mjs` | 8 种触摸写法矩阵（finger/mouse/pressure/坐标系） | `PROBE-P1-touchmatrix.json` |
| `probe-jd-search.mjs` / `probe-jd-tap.mjs` | 京东落点诊断（结论：uiautomator 在京东首页不可靠） | `PROBE-P1-jd-search.json` |
| `probe-jd-entry.mjs` | **京东搜索入口**：找 `desc=搜索` 节点→点→输字→回车（坑 8 修好后的第一次真机成功） | `PROBE-P1-jd-entry.json` |
| `probe-ai-autostart.mjs` | **模型独立路径**：不起侧栏，验证动作自动拉会话 + 全走控制通道 | `PROBE-P1-ai-autostart.json`（全绿） |
| `probe-adb-bootstrap.mjs` | **adb server 自举**（坑 16）：杀光 adb 后走插件 adb 层，5.3s 自举成功 | `PROBE-P2-adb-bootstrap.json`（PASS） |
| `probe-live-latency.mjs` | **画面链路分帧计时**：订真实宿主的 `/video`，按 13 字节帧头记 pts/大小，量稳态 fps/kbps + 「动作→画面变化」延迟（`--size/--fps/--both`） | `PROBE-P3-live-latency.json` |
| `preview-panel.mjs` | **侧栏 UI 离屏出图**（坑 19）：jsdom 真挂载 + 本机 Chrome 截图，3 场景 × 光亮两套主题 | `recon/ui-preview/*.png` + `preview-report.json` |
| `serve-api.mjs` | 假宿主 HTTP harness（`--port 19399`），给 skill 脚本/手工联调用 | — |
| `test-stitch.mjs` | 逐帧拼接器逐像素回归（纯离线，不需要真机） | `recon/reports/android-stitch-report.json`（35/35） |
| `test-client.mjs` | 侧栏半边（假 window + jsdom）：协议/坐标/滚轮合并/接管 | `recon/reports/android-client-report.json`（40/40） |
| `test-host.mjs` | 宿主半边 + HTTP 接口 + 真机取流/截图/长截图 | `recon/reports/android-host-report.json`（36/36） |
| `skills/jd-mall-capture/scripts/jd-shop-longshot.mjs` | **生产脚本**：驱动插件 HTTP 接口跑完京东搜索→进店→长截图 | 每次都写 sidecar JSON；实测 exit 0 / 10 PASS |

---

## 6. 待用户拍板的问题

1. **重启 DSH 的时机**：插件已能装进真实 desktop profile（`install.ps1` 会先备份 profile 的
   `package.json` / `cordis.patch.yml` 为 `*.bak-android-phone`），但**宿主半边只有重启 DSH 才会加载**，
   重启会打断当前会话 —— 由用户决定什么时候重启。回滚 = 再跑一次 `install.ps1 -Uninstall`。
2. **侧栏眼验清单**（重启后逐条看）：画面清不清、点按/拖拽/滚轮跟不跟手、控制权胶囊与
   「✋ 接管 / ↩ 交还模型」是否好按、画质「自适应」档是否合适、长截图按钮是否正常。
   （「字体发虚」按拍板跳过，只记录现象。）
3. 若侧栏观感仍不满意，再决定要不要走「原生窗口」路线（代价：侧栏里看不到手机）。

---

## 7. 已确认的决策（勿再讨论）

| 项 | 决定 | 来源 |
|---|---|---|
| 落地形态 | 先在 **DSH 侧栏内**实现，效果不好再考虑原生窗口方案 | 用户 m00115 |
| 会话数 | **单会话**（video + control 同一个 server 进程） | 用户 m00125 |
| 会话生命周期 | **跟随侧边栏**打开/关闭 | 用户 m00125 |
| 控制权 | AI 优先、AI 跑时人只观、AI 空闲时人可操作、**人可强制抢占** | 用户 m00125 |
| 字体发虚 | **跳过**，只留基线测量 | 用户 m00115/m00125 |
| 中文注入 | 按 UTF-8 边界分段，每段 ≤300 字节，间隔 100ms | 用户 m00125「其他按你的来」 |
| 控制不可用 | 静默回落 `adb shell input`，返回值带 `via:'adb'` | 同上 |
| adb 版本 | platform-tools **37.0.1**（已落地） | 同上 |
| 弹窗播放 | 不进这一版 | 同上 |
| 接管入口 | 侧栏按钮「✋ 接管 / ↩ 交还模型」+ `phone_takeover` 工具都做；人静默 90s 自动交还（`humanHoldMs`） | 用户 m00125 + 本实现 |
| skill 归属 | 技能**随插件包走**（`<插件目录>\skills`），由 `install.ps1` 并进 profile 的 `skill-filesystem.customSkillDirs` | 本实现（不许再加第二条 `- id: skill-filesystem`） |
| 连接方向 | `tunnel_forward=false` + `adb reverse` 为主，forward 兜底 | 坑 9 实测 |
| 接口 | `phone_*` 工具名/参数、`jd.json`、`SKILL.md` **零变更** | PLAN |


## §1h 第八轮：侧栏 UI 14 项改版（2026-10-17 深夜）

用户三条输入：m02957（14 条 UI 意见）+ m02983（5 条拍板）+ m03071（暂停/画面挪顶栏、Esc 退出全屏）。

### 宿主侧改动（要重启 DSH 才生效）
- `src/android/longshot.js`：主循环加 `opts.shouldStop()` 中断点；每帧 `opts.onStep(step)` 回调（原来 index.js 传了但被忽略）。
- `src/android/adb.js`：KEYCODES 补 `volumeup/volumedown/mute/dpad*/center/movehome/moveend/pagedown/pageup`；新增 `normKey()`（小写 + 去掉非字母数字）⇒ 修掉「任务按钮报未知按键」。
- `src/android/actions.js`：`case 'key'` 用同一套归一化。
- `index.js`：模块级 `MODULE_LONGSHOT` 状态机 + `startLongshot()/stopLongshot()/longshotInfo()`；`POST /shot {mode:'long', op:'start'|'stop'}`；新增 `GET /longshot`；`/status` 新增 `link:{state:'ok'|'none'|'error', code, message, hint}`（连接三色的唯一数据源）。

### 侧栏改动（client.js，硬刷新即可）
- 顶栏只剩三颗胶囊：**● 连接**（绿/灰/红，点一下弹出原因与办法）、**控制权**（模型持有=绿 / 人在操作=灰，点一下切换）、**1080×2400**（hover 出机型/Android/编码参数）。
- 工具行：`🛍 打开京东 / ◀ 返回 / ⌂ 桌面 / 🗂 多任务` + `📷 截图 / 画面▾ / ⏸ 暂停 / 画质▾ / ⌨ 键盘`。
- 截图机：单击截图 → 绿色待命 5s → 按 **L** 开始长截图（界面实时显示已拼高度/帧数/耗时）→ 再点「⏹ 停止」保存。
- 键盘直通（默认开，localStorage 记住）：点画面后电脑键盘直接打进手机；可打印字符攒 30ms 批量走 INJECT_TEXT（中文走输入法 composition），Enter/退格/Tab/Esc/方向键映射成 keycode。
- 删除：唤醒、接管/交还、刷新、反向连接、A−/A+、底部「输入/提交」整行、画面右下角浮动按钮。
- 画面模式改成顶栏下拉（铺满默认 / 完整 / 全屏），全屏按 **Esc** 退出；Ctrl+滚轮调字号。

### 验证
- `node --check` client.js / index.js / actions.js / adb.js / longshot.js 全绿。
- `node scripts/test-client.mjs` → **ALL PASS 58/58**（新增：截图机状态机、L 键、画面下拉与 Esc、暂停、键盘直通 Enter 与批量文本、控制权切换、旧按钮已删）。
- `node scripts/preview-panel.mjs` → 6 张离屏图（`recon/ui-preview/*.png`），HTML 断言新标签齐全。
- 真机未跑（避免打断用户正在用的手机）。

### 坑 27：截图待命态的 L 键必须挂 window
点完「截图」后焦点在按钮上（既不在画面也不在隐藏输入框），只把 keydown 挂在输入框上收不到 L ⇒ 改成 window 级监听 + 排除输入框来源（输入框里的 L 由 onKbdKeyDown 处理，避免双触发）。

### 仍未做
- 应用下拉（用户 m02983：以后做成插件设置页让用户自己填，现在先保留「打开京东」）。
- 底部状态行/截图信息行（用户 m03071：「最下方等会再说」）。

## §1f 第五轮（2026-10-18 上午）：侧栏 UI 按用户 7 条反馈改完

用户 m06300 的 7 条 + m06387 的 3 条澄清，逐条落地（全部在 `dsh-android-phone/client.js`，只有长截图那条在 `index.js`）：

1. **悬停精简**：分辨率胶囊 hover 只剩「型号 · Android 版本」；编码尺寸挪到底部状态行（新胶囊 `data-enc`「编码 648×1440」）。
2. **长截图 `startLongshot is not defined`（真 bug，`index.js`）**：`longshotInfo/startLongshot/stopLongshot` 定义在 `buildToolDefs()` 内部，`POST /shot` 路由在另一作用域引用 → 必然 ReferenceError，且外层 catch 把异常吞成 `{ok:false}`。修法：模块级桥接 `LONG_SHOT_API`（`index.js:297/328/335`），异常带栈写日志。**需重启 DSH 生效。**
3. **控制权胶囊**：文案固定「🤖 模型持有」，颜色随持有者 —— `owner==='ai'` 绿，否则默认灰；不再可点。
4. **画面模式**：默认铺满不变；画质标签改全称 `自动/省流/标准/高清`。
5. **键盘直通重做（对齐 QtScrcpy）**：删掉隐藏 input 与「⌨ 键盘」开关；面板根节点 `tabIndex=0` + `onKeyDown`，点面板即聚焦；字母/符号走 `INJECT_TEXT` 逐键送进手机，**中文由手机自己的输入法拼**（打 pinyin → 手机弹候选）；Enter/退格/Tab/Esc/方向键映射 keycode；Ctrl/Cmd 组合键放行。攒批窗口 **30ms → 8ms**（`KEY_BATCH_MS`），用户反馈「和手机实时延迟有点大」。
6. **截图结果行**：只显示保存路径，自检真异常才补红胶囊。
7. **顶栏重排**：第一行 `连接 / 模型持有 / 分辨率 / 铺满-完整-全屏 / 暂停 / 画质`；第二行 `📷 截图 → 🛍 打开京东 → 返回/桌面/多任务`。键盘按钮、输入框、提交按钮全部删除（键盘直通替代）。

### 坑 28：切换画面模式后按钮「框线没了」—— 真因是 React 的「简写 ↔ 长写」混用（我先前的两个诊断都是错的）
- 现象（用户 2026-10-18）：铺满/完整/全屏互相切换后，工具栏按钮与下拉框的边框消失。
- **第一次误判**：以为是 CSS 变量没写上去 → 加了 `setProperty` 双保险（无害，但没治本）。
- **第二次误判**：以为是 Chromium 的 UA select 自绘边框 → 给 select 加 `appearance:none`（结果把原生下拉三角弄没了，被用户否掉）。
- **真因**（React 自己在 stderr 里报了）：
  ```
  Removing a style property during rerender (border) when a conflicting property is set (borderColor)
  can lead to styling bugs. ... don't mix shorthand and non-shorthand properties for the same value
  ```
  `S.btn` 写的是 `border: '1px solid …'`（简写），而 `S.btnPrimary` 等叠加项里也各自写了 `border`；两者在不同渲染里出现的键不一致时，React 会**删除简写 `border`**，而删简写会把它包含的 `border-style/width/color` 一并清空 ⇒ 边框整条消失。切换画面模式正好触发一次这样的重渲染。
- **修法**：`S` 里**所有**边框一律写成 `borderStyle` + `borderWidth` + `borderColor` 三个长写属性，全文件 `border:` 简写数量 = **0**（只剩 `kbdSink` 的 `borderStyle:'none'`）。副作用是白赚一层健壮性：万一 CSS 变量解析失败，只有颜色退回 `currentColor`，边框不会整条消失。
- 回归：`test-client.mjs` 断言 —— 按钮/下拉必须带 `border-style`/`border-color` 且**不得**出现 `border:` 简写；切换模式后仍在。**63/63 全绿，且 stderr 里 React 的 conflicting-property 警告从 3 条降到 0 条**（这条警告本身就是回归信号，以后见一次查一次）。

### 坑 29：下拉三角用原生，别自己画
- 用户 m06592：「三角按钮没有回来，而且不应该是自己渲染的，应该是一个默认的东西，避免过度占用系统资源」。
- 结论：`<select>` **不要加 `appearance:none`**，让 Chromium 画原生三角（`color` 会带过去，浅色主题下自动是深色）；自己用 SVG data-uri 画三角是多余的，多一层光栅化。
- 代价：作者写的 `border` 在 select 上会被 UA 样式部分覆盖 —— 所以用**长写属性**（坑 28 的修法）就能既保住边框、又保住原生三角。面板里那段 `<style>` 现在只剩 `@keyframes dshPhoneRipple`。

### 本轮验证
- `node --check client.js` / `index.js` / `src/android/video.js` 全 0 错。
- `node scripts/test-client.mjs` → **ALL PASS 63 项**（报告 `recon/reports/android-client-report.json`；含新增的「边框必须是长写属性」「下拉必须保留原生三角」两项）。
- 未验证：长截图修复要等重启 DSH 后真机跑一次；键盘 8ms 攒批的体感要用户硬刷新后确认。


## 2026-10-18 晚：大窗口改成「宿主真开窗」+ 离屏验收 harness（承接用户 m06865）

### 用户这次的两条
「你这个大窗口还是原来的逻辑，做了一个全屏出来，并没有新弹出来一个窗口，另外，按钮不应该是独立的，和铺满/完整放在一起。可借鉴的部分也做一下，我们看看效果」

### 为什么以前弹不出来
旧实现是渲染进程里 `window.open()`：Electron 的渲染进程默认**把 window.open 变成受控子窗口**（或直接返回 null），
返回 null 时旧代码静默退回「面板内全屏」⇒ 用户看到的就是「还是全屏」。反查 DSH asar（`D:\Xin\DSharness\resources\app.asar`）确认：
preload 暴露的 API 里**没有任何开窗能力**（只有 onboarding / 目录选择 / 平台信息），所以必须由**宿主进程**开 BrowserWindow。

### 落地
1. `src/live.html`（新文件，16KB 自包含页面）：自己连 `/video`、自己用 WebCodecs 解码、自己用 **WebGL 纹理一次采样**上屏
   （同侧栏的 `createPresenter`），自带工具条（返回/主页/画质/铺满-完整/快照/转向）、键盘直通、**右键=返回**、滚轮走 INJECT_SCROLL_EVENT。
   它不依赖侧栏渲染进程 ⇒ 侧栏收起/关掉都不影响这个窗口（和 QtScrcpy 的独立窗口一个意思）。
2. `index.js`：`GET /live` 吐这个页面；`GET /window?op=open|state|close|focus|rotate` 由宿主 `new BrowserWindow({width,height,...})` 打开
   `http://<host>/dsh-android-phone/api/live`，窗口标题「手机 · 大窗口」；`loadElectron()` 三条路都试（`import('electron')` /
   `createRequire()('electron')` / `process.mainModule.require('electron')`），拿不到就老实 `ok:false` + 原因。
3. `client.js`：下拉从「铺满/完整/全屏」改成「铺满/完整/大窗口 ⤢」——**不再有独立按钮**；选「大窗口」只是触发开窗、显示口径不变
   （下拉会自己弹回原值）。开窗顺序：宿主 BrowserWindow → Document PiP → window.open → 都不行就报错 + 给兜底地址，**不再偷偷全屏**。
   侧栏这一路在窗口开着时自动暂停（同一台手机只允许一路视频会话）。
4. 可借鉴部分（QtScrcpy 的思路）：WebGL 一次采样上屏（侧栏 + 大窗口都做了）、**右键 = 返回**、键盘直通、滚轮送格数。

### 坑 30：client.js 的测试桩必须打在 `global.fetch` 上，`w.fetch` 打不中
- `scripts/test-client.mjs` 用 `new Function('window','document',...,src)` 载入 client.js ⇒ 模块里裸写的 `fetch` 解析到
  **Node 的 global.fetch**，不是 jsdom window 上的 `w.fetch`。我先前的桩打在 `w.fetch` 上，等于没生效：
  于是 `/window?op=open` 落到默认桩返回 `{ok:true}`，面板以为宿主真开了窗，`popupOpen` 变 true ⇒ 画面被替换成
  「画面已弹到桌面上的独立窗口里」的提示条 ⇒ 后面依赖 canvas 的滚轮用例全部拿到 0 个事件。
- 教训：**测试桩要打在模块真正解析到的那个对象上**；顺带把「canvas 是否还在 DOM 里」当断言写进用例。

### 离屏真机验收 harness：`scripts/preview-live.mjs`（新）
- 为什么：`/live` 平时要宿主 BrowserWindow 打开，改一次就得重启 DSH 才能看，反馈太慢。
- 做法：把插件 webServer 路由挂到一个普通 http server（桩同 test-host）→ 本机 Chrome `--headless=new` + `--remote-debugging-port`
  → 手写 CDP 客户端（Node 24 自带 WebSocket，零依赖）→ 真等 N 秒 → `Runtime.evaluate` 读页面状态行 / `Page.captureScreenshot` 出 PNG
  → **用插件自带的 `src/core/png.js` 解码截图算亮度均值/标准差/颜色数**，客观判断「画面上真有内容」而不是靠肉眼看。
- 踩坑：`chrome --screenshot --virtual-time-budget` 会把定时器快进而视频帧是真实时间到达的 ⇒ 永远「0 fps」。必须 CDP 真等。
- 实测（真机 ADF0220515005425）：状态行 **26 fps · 484×1080**、WebGL 上下文正常、截图 lumaMean≈220 / std≈66 / 颜色数≈7100 ⇒ PASS。
  加 `--click=250,400` 还能验点击链路（控制权与 /action 都正常，控制台 0 报错）。

### 本轮验证
- `test-client` **65/65**（新增「右键 = 返回」）、`test-host` **40/40**（新增 /live 页面骨架、/window?op=state、纯 Node 下开窗老实失败 3 项）、
  `test-plugin-tools` 33/33、`test-session` PASS（真机 18s 长跑）、`test-stitch` 35/35。
- `preview-live` 真机 PASS（26~27 fps，画面非黑）。
- **未验证：宿主 Electron 里真的弹出 BrowserWindow** —— 这一条必须重启 DSH 才会加载新 `index.js`。

## 2026-10-18 深夜（第二轮）：大窗口整条删掉 + 画质真相测量（承接用户 m07268）

### 用户 m07268（逐字）
「还是不行，我要的大窗口，是基于当前侧边栏的这个手机的画面，去开一个更大的窗口，大窗口弹出后，侧边栏里的手机画面要隐藏，关闭大窗口后，侧边栏里的手机画面恢复。
现在是直接在界面上全屏了，这不是我想要的，就是直接没做出来。先把这个功能去掉，全屏也去掉，回退画质，还有参考qtscrcpy做的部分，改完后和我们之前的对比给我列下，还有没有其他需要优化的地方」

### 做了什么
1. **「全屏」「大窗口」两条路整条删掉**（`recon/strip-window.cjs` 锚点式删段，改完自检残留引用 = 0）：
   - `client.js`：删 `view === 'fullscreen'` 分支、`S.fullscreen`、Esc 退出全屏、`openPopup`/`mountPhoneWindow`/`POPUP_*`/`popupOpen`/`popupRef`、
     下拉第三项、`/window?op=open` 轮询；画面模式只剩 **铺满 / 完整**。
   - `index.js`：删 `GET /live`、`GET /window`、`POST /live`、`openPhoneWindow`/`phoneWindowOp`/`loadElectron`/`LIVE`/`PHONE_WINDOW`/`ELECTRON_MOD`/`LIVE_HTML`。
   - 删文件 `dsh-android-phone/src/live.html`、`scripts/preview-live.mjs`。
   - 测试：`test-client` 62/62、`test-host` 36/36（回落到删功能前的项数）。
2. **画质口径统一**：`index.js` 的 `VIDEO_PRESETS` 三档 `maxFps` 由 30 改成 **60**，与 `client.js` 的 `QUALITY` 对齐
   （以前 `/status` 报 30、实际跑 60，两套口径）。
3. 顺手清掉 `client.js` 里已经没人用的 `PROFILE` 常量与 `?profile=` 查询参数（那是给 `/live` 用的，随功能一起消失）。

### 真机实测画质表（`scripts/probe-quality.mjs`，设备 ADF0220515005425 / 1080x2400）
| 档位 | 编码尺寸 | 实测 fps | 码率 | 平均帧 |
|---|---|---|---|---|
| 自动（侧栏 400px 级） | 460x1024 | 64.0 | 2961 kbps | 9.0 KB |
| 省流 | 540x1200 | 30.0 | 2071 kbps | — |
| 标准 | 808x1800 | 29.8 | 3539 kbps | 18.8 KB |
| 标准@60 | 808x1800 | **56.4** | 4095 kbps | 12.4 KB |
| 高清 | 1080x2400 | 29.4 | 5251 kbps | 27.4 KB |
| 高清@60 | 1080x2400 | **58.5** | 6934 kbps | 20.7 KB |
⇒ 结论：**档位是真的生效的**（尺寸/码率都跟着变），60fps 也确实跑得动；换档只影响**带宽与放大后的清晰度**。

### 坑 31：`window.open` 在 DSH 桌面宿主里必被拒 —— 大窗口只能宿主自己开
反查 asar：全库 7 处 `setWindowOpenHandler` 全是 `{action:'deny'}`，且主窗口是 `BaseWindow + WebContentsView` 结构
⇒ 渲染进程 `window.open` 直接拿不到窗口。`dshPlatform.open` 也不行（页名白名单只有 `usage`/`top-up`，且是主窗口内浮层）。
宿主进程 `import('electron')` 开 `BrowserWindow` 这条路是通的，但**用户明确否掉了这个方向**（他要的是"侧栏画面搬到更大窗口"，
不是"另开一个页面"）⇒ 本轮已全部删除，别再往回捡。

### 坑 32：`QUALITY` 与 `VIDEO_PRESETS` 两张画质表并存 ⇒ 口径打架、会话被反复重启
侧栏按自己的表算 `maxSize/maxFps/bitRate` 传给 `/video`，宿主又有一张 `VIDEO_PRESETS` 给模型工具和 `/status` 用。
两张表不同步时会出现「`/status` 说 30fps、实际 60fps」「换档后会话重启两次」这类怪现象。
⇒ 修法：两处数值必须一致；改一处就得改另一处（本轮已对齐到 60）。

### 坑 33：窄侧栏里换画质档位**看不出差别**是物理必然，不是 bug
侧栏 canvas 只有 ~400 CSS px 宽，460x1024 / 808x1800 / 1080x2400 最后都被缩到同一个显示尺寸 ⇒ 视觉几乎无差。
画质档位的真实意义只有两个：① 带宽 ② 放大（面板拉宽 / 全屏显示器）后的清晰度。
⇒ 以后要「侧栏里更清楚」，正确做法是让 `自动` 档**超采样**（按面板像素 ×1.5 取尺寸），而不是提高档位名。

### 本轮验证
- `test-client` **62/62**、`test-host` **36/36**、`test-plugin-tools` **33/33**、`test-stitch` **35/35**、
  `test-session` **PASS**（真机 18s 长跑：控制通道 tap avg 107µs / max 143µs vs `adb input tap` 61ms = **570×**）。
- `probe-quality` 六档全量真机实测（上表）。
- **仍需重启 DSH** 才能让宿主侧 `/live`、`/window` 路由彻底消失（旧 index.js 还在进程里）。

---

## 2026-10-18 下午：m07459 施工单落地（截图/滚轮 / 剪贴板 / 右键双指 / adb 自愈）

### 坑 34：设备消息枚举写错 ⇒ 剪贴板"读不回来"（真因，源码级）
`src/android/control.js` 原来写 `DEVICE_MSG = { CLIPBOARD: 1, ACK_CLIPBOARD: 2, ... }`，
**实际 scrcpy v5.0.1 `app/src/device_msg.h` 是 `CLIPBOARD=0 / ACK_CLIPBOARD=1 / UHID_OUTPUT=2`**。
现象：探针里 `SET_CLIPBOARD` 成功（179µs），但读回为空，日志刷 `收到未知设备消息 type=0，丢弃 N 字节缓冲`。
⇒ 已按头文件改正，并补上 `UHID_OUTPUT` 的跳过逻辑（type(1)+u16 id+u16 size+data）。
报文格式：`CLIPBOARD = type(1)+u32 len+UTF-8`；`ACK_CLIPBOARD = type(1)+u64 seq`。

### 坑 35：`GET_CLIPBOARD` 在 autosync 开着时**根本不回包**（服务端源码如此）
`server/.../control/Controller.java` 的 `getClipboard(copyKey)`：只有 `if (!clipboardAutosync)` 才把剪贴板
当成 `DeviceMessage.createClipboard()` 推给客户端。scrcpy 默认 `clipboard_autosync=true`，
所以「主动读」拿不到东西 —— 但此时**手机剪贴板一变就会主动推**给我们（这才是可用方向）。
⇒ 设计改成：宿主缓存推送值（`/status.clipboard = {text, at}`），面板轮询发现 `at` 变了就写进系统剪贴板；
`phone_clipboard get` 加 `copy:true` 参数（先注入 KEYCODE_COPY 再等推送），并在返回里给出 `hint` 说明原因。

### 剪贴板同步（用户要求：只加功能、不加按钮）
- 电脑 → 手机：**面板有焦点时 Ctrl+V** ⇒ `navigator.clipboard.readText()` → `POST /clipboard {op:set, paste:true, human:true}`。
  这是把**中文**送进手机输入框最稳的一条路（`INJECT_TEXT` 只能 ASCII）。已确认 DSH 渲染进程里 `navigator.clipboard` 可用
  （asar 里宿主自己就在用 `readText/writeText`）。
- 手机 → 电脑：`/status.clipboard` 变化 ⇒ 面板 `writeText` 写进系统剪贴板 + 顶部提示。
- 刻意用 `function` 声明而不是 `const useCallback`：`refresh` 在文本上先定义，函数声明会提升，避开 const 的 TDZ。

### 右键 = 双指缩放（用户拍板「不绑功能的话当双指，滚轮放大」）
- 走 `control.js` 新加的 `touchRaw(action,x,y,{pointerId,...})`：双指必须用**原始 MotionEvent action 码**
  （0 ACTION_DOWN / 1 ACTION_UP / 2 ACTION_MOVE / 5 ACTION_POINTER_DOWN / 6 ACTION_POINTER_UP），
  只用 down/up 发第二根手指服务端会当新手势。
- 右键按下 = 摆出两根手指（id 11/12，沿竖直方向对称，半距 5% 视频高）；上下拖 = 张开/收拢；
  按住右键滚轮 = 步进缩放（`PINCH_WHEEL_STEP=0.012`）；没拖动就松手 = 手机「返回」。
- 真机探针 `scripts/probe-clipboard-pinch.mjs`：双指 12 条事件全部写入成功、`outOfRange=0`、
  抬手后单指 tap 仍正常 ⇒ **6/6 全绿**（报告 `PROBE-clipboard-pinch.json`）。

### ⑨ adb 掉线自愈
- `src/android/adb.js` 新增 `healAdb({adbPath})`：`kill-server` → 后台 `start-server`（不带 `--nodaemon`）→ 轮询设备；
  `phone_status {heal:true}` 与 `POST /status {heal:true}` 可手动触发；会话启动失败时自动试一次。
- **真机验证（真实掉线，不是模拟）**：本轮手机被拔掉后 `adb devices` 为空，
  `healAdb` 返回 `{"ok":false,"reason":"server 起来了但设备没回来（拔插数据线 / 手机上重新允许 USB 调试）",
  "steps":[{"step":"kill-server","ok":true},{"step":"nodaemon server","ok":true,"ms":256}]}`
  ⇒ 自愈逻辑正确（server 救活、设备没插回来就老实说设备没回来，不假报成功）。

### ③ 截图 / 滚轮（上一条指令已做，此处只记结论）
- 截图文件现在带 `.png` 后缀；单击截图后 5 秒内按 L 做长截图时，**短图会被宿主删掉**（`/shot {drop}`），不再成对产出垃圾。
- 滚轮：`WHEEL_MAX_NOTCHES` 由 12 收到 **3**，超出的直接丢（不再攒着补发）——"过一会再滚就滚多了"的真因是补发；
  传输层实测线性（1 格 = 192 设备像素 = 0.08 屏，N 格 = N×192，连发/单发一致）。

### 本轮验证
- `test-client` **66/66**（新增 2 条剪贴板断言：Ctrl+V 送手机、/status.clipboard 自动写系统剪贴板）
- `test-stitch` **35/35**、`test-plugin-tools` **33/33**
- `probe-clipboard-pinch` **6/6**（真机，协议层）
- `test-host` / `test-session` **本轮没能跑**：手机被拔掉（`adb devices` 为空）—— 刚好当成 ⑨ 的真实演练
- **仍需重启 DSH**：`index.js` / `src/android/*.js` 是宿主侧代码；`client.js` 只需 Ctrl+Shift+R

---

## 2026-10-18 收尾：双指缩放真机定性（坑 36）

**结论：多指必须「每根手指都发 ACTION_DOWN(0)/ACTION_UP(1)」，不能自己发 POINTER_DOWN(5)/POINTER_UP(6)。**

依据 scrcpy v5.0.1 `server/.../control/Controller.java` 的 `injectTouch()`：

```java
int pointerCount = pointersState.update(pointerProperties, pointerCoords);
if (pointerCount == 1) {
    if (action == MotionEvent.ACTION_DOWN) lastTouchDown = now;
} else {
    // secondary pointers must use ACTION_POINTER_* ORed with the pointerIndex
    if (action == MotionEvent.ACTION_UP)        action = MotionEvent.ACTION_POINTER_UP   | (pointerIndex << ACTION_POINTER_INDEX_SHIFT);
    else if (action == MotionEvent.ACTION_DOWN) action = MotionEvent.ACTION_POINTER_DOWN | (pointerIndex << ACTION_POINTER_INDEX_SHIFT);
}
```

即 POINTER_* 由**服务端**改写并补 pointerIndex。客户端直接发 5/6 会被原样透传，
Android 认为「pointerIndex 0 又按了一次」⇒ 整条事件丢弃，且 `log_level=warn` 下**没有任何日志**。

- 真机证据（`scripts/probe-pinch-gallery.mjs`，报告 `PROBE-pinch-gallery.json`）：
  相册（`com.android.gallery3d`）打开一张 1080x2400 等高色带图（每条 200px），
  用控制通道发双指张开 120→432（视频坐标），色带间距 **400px → 600px（×1.50）**、可见色带 6→4 条 ⇒ 真的放大了。
  同一张图用 5/6 序列发，间距 400→400 **毫无变化**。
- 修改：`client.js` 的 `pinchSend` 不再发 5/6（右键双指 = A down 0 / B down 0 / MOVE 2 / B up 1 / A up 1）；
  `src/android/control.js` 的 `touchRaw` 文档改写为上述契约；`scripts/test-client.mjs` 断言同步（raws 不含 5/6）。
- 顺带记录两个测试床教训：
  1. **Huawei 浏览器不能当缩放靶子** —— 它的「适合屏幕」模式会吃掉 pinch；且缩放按站点持久化，force-stop 也清不掉，
     导致 `127.0.0.1` 一直是上次的 4.7x，量出来的「间距 720」是假信号。
  2. 量位移/缩放**不能用 `estimateOffset`**（自带拒帧：`maxMotionRatio` / `minOverlapRatio`，位移一大就整帧拒绝）。

回归：`test-client` **66/66**、`test-host` **36/36**、`test-session` PASS（真机 18s、控制 tap 94µs）。双指缩放至此**真机验收通过**。

## 2026-10-18（本轮：画面冻住 / 设置页 / FPS）

### 坑 37：侧栏画面「冻住」= 客户端没有重连
`client.js` 的 `consume()` 在流**正常结束**时直接 resolve（宿主重启会话、换画质、自愈重启、被别的消费者抢），
只有异常才 `startPoll` ⇒ 画面停在最后一帧、底栏 `0 fps`，人怎么点手机都不动（用户 m25129 截图）。
修：`runLoop()` 退避重连（250ms×n，上限 2s，连续 8 次才降级快照），稳定跑过 3s 重置计数。
真机复现：探针重启会话后侧栏冻住；重启 DSH 后宿主日志确认 `sweepScrcpyReverseSync` 清掉 1 条残留。

### 设置页（用户 m25121 拍板的三块）
- 宿主：落盘 `~/.dsh/android-phone/settings.json`；
  新增 `readSettings / writeSettings / shotsRoot(认设置) / cleanupShots / maybeCleanupShots / listSkills / revealDir`
- 路由：`POST /settings {action:get|cleanup|reveal}`、保存 `{shotsDir,cleanup}`、`POST /skills`
- 清理只删「文件名时间戳开头 + .png 或无扩展名」的自家产物；每次截图后最多 6 小时清一次；`.json` 等旁注不动
- 侧栏：工具行末尾「⚙ 设置」；三块 UI + 保存/打开目录/恢复默认/立即清理；
  设置页盖住舞台但**不卸载 Screen**（视频流不中断）
- 假宿主（19399，全程不碰设备）验证：get / save / cleanup / skills 全部通过；
  cleanup 在 3 天口径下 `removed 0 / kept 236`（236 张都新于 3 天，行为正确）
- 离屏预览：`recon/ui-preview/settings-{light,dark}.png`

### FPS
- 编码上限本来就是 60：`QUALITY` 四档、`DEFAULT_VIDEO.maxFps`、`cordis.patch.yml` 全是 60
- WebGL / canvas2D 两条上屏路径的 canvas 后备存储**本来就是按面板 devicePixel 算的**（不是 1080×2400 全尺寸）
- 本轮改动：WebGL 加 `desynchronized:true`；丢帧阈值 `decodeQueueSize>2` → `>4`
  （60fps 下 2 帧只有 33ms，稍有抖动就丢，而 H.264 丢一帧 delta 要等到下个关键帧才恢复 ⇒ 肉眼「糊一下」）
- 真机实测：静止 6.1fps / 0.23Mbps、滚轮 26.6fps、连续拖拽峰值 56fps
  ⇒ 已在 60 上限附近；「静止时 fps 低」是手机屏幕没新帧的物理事实，不是插件丢帧

---

## 2026-10-19 代码清理（「避免留下太多垃圾，简洁高效一点」）

用户原话（m25227）：「删掉吧，我觉得现在我们可能需要重新看下所有代码了，避免留下太多垃圾，简洁高效一点」

### 删掉的东西

| 对象 | 体量 | 为什么 |
|---|---|---|
| `client.js.bak-pinch` / `client.js.bak-strip` / `index.js.bak-strip` | 238KB | 我自己改代码时的中间备份，内容已被正式代码取代 |
| `scripts/probe-*.mjs` 共 33 个 | 258KB | 一次性诊断探针；结论都已在 §3 坑表 / §5 阶段清单里（**§探针表里引用的脚本已删，结论仍有效**） |
| `dsh-android-phone/recon/`（wheel 实验截图） | 5MB | 滚轮标定的一次性截图 |
| 8 个未使用导出 | — | `adbCandidates`/`killServer`(adb.js)、`getVideo`/`ensureFromSidebar`/`assertAlive`(session.js)、`codecStringFromSps`/`codecCandidates`(video.js)、`stitchShot`(stitch.js) |
| `client.js` 的 `giveBack()` | 12 行 | 「↩ 交还模型」按钮早已删掉，函数没人调（死代码） |
| `recon/ui-preview/.chrome-live/` | 21.7MB | 预览 harness 跑 Chrome 留下的用户数据目录 |
| `recon/android-shots/`、`recon/pinch/`、旧 ui-preview | 34MB | 历史截图，结论已在报告 JSON 里 |
| `验证报告/`（原 zip 带来的 6 个） | 29KB | 描述的是**旧实现**（control=false 那版），已被 `recon/reports/` 取代 |
| `UI-PLAN.md` | 6KB | 14 项 UI 改版计划，已全部落地 |
| `.tmp/`、项目根 8 个 `PROBE-*.log`、21 个 `PROBE-*.json`、`out-skill-run.json` | — | 运行残留；报告类归档到 `recon/reports/probes/` |

### 顺手修掉的真问题（不是「垃圾」但会一直制造垃圾）

1. **`stitchShot` 是引用不存在模块的死代码**：`src/core/stitch.js:548` 里 `await import('./input.js')` —— 这个文件根本不存在（那是早期「浏览器里滚页面截图」方案的遗留），调用必抛。
2. **测试报告到处乱落**：`test-plugin-tools` / `test-session` / `test-e2e-jd` 原来把 `PROBE-*.json` 写进项目根，现在统一写 `<项目根>/recon/reports/`；`test-session` 里还写死了别人的绝对路径，已改成相对 `import.meta.url` 计算。
3. **过时文档**：
   - README 的「控制权」段落还在讲「点 ✋ 接管按钮 / ↩ 交还模型」（按钮早删了，现在是**人一碰画面就自动接管**，胶囊只显示）
   - README 状态行描述、`phone_action` 动作类型（写的是 `swipe/type/wake/home`，实际是 `drag/wheel/text`）、工具数 11→**12**
   - `SKILL.md` 硬编码 `127.0.0.1:19387`（DSH 每次启动端口都变）→ 改成 `<当前DSH端口>`，脚本走 `--base` / `DSH_ANDROID_PHONE_API`
   - `package.json` 的 `npm test` 只跑一个套件 → 现在跑 4 个离线套件
4. **加了 `.gitignore`**（项目根）：忽略 `.client-test/`、`recon/`、`out/`、`.tmp/`、`node_modules/`、`*.log`；`ref/` 与 `vendor/` 保留可提交。

### 有意**没**做的事

- **`index.js`(1418 行) / `client.js`(1468 行) 没有拆**。`client.js` 受 DSH 的 `__ModuleLoader__` 单文件约束，拆不了；`index.js` 拆分是纯重构、收益低风险高，等上 GitHub、有 CI 之后再做。
- `sleep()` 在 10 个文件里各有一份。`skills/jd-mall-capture/scripts/jd-shop-longshot.mjs` **必须保持零依赖独立可跑**，所以不抽公共 util；其余几份是模块内自用，抽出去收益不抵改动风险。

### 清理后体量

- 插件包（不含 `vendor/`）：**32 个文件 / 509KB**，`index.js` 1418 行、`client.js` 1468 行、`src/` 3593 行
- `vendor/` 10MB（adb platform-tools + scrcpy-server v5.0.1，可复现，删了就得重新下）
- `recon/` 从 57MB → **0.35MB**（只剩报告 JSON）
- 回归：`test-plugin-tools` 33/33、`test-stitch` 35/35、`test-client` 66/66 全绿（`test-host`/`test-session`/`test-e2e-jd` 需真机，改动未触及它们的断言）