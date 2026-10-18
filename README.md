# dsh-android-phone

**把安卓真机搬进 DeepSeek Harness 的侧栏。** 实时画面、亚毫秒控制、截屏与长截图，同一套能力也作为 `phone_*` 工具交给模型 ——「AI 自动操作手机」和「人肉看手机」共用**同一条链路、同一个会话**。

- **是**：真机屏幕的远程显示与操作。`adb` 把 `scrcpy-server` 推到手机，画面 H.264 回传，输入走 scrcpy 控制通道；截图与长截图是真机像素口径。
- **不是**：模拟器。页面来自你手机上的真实 App（京东 / 淘宝 / 拼多多…），所以能拿到 App 内的页面。
- **不需要**：QtScrcpy、Android SDK、任何 npm 依赖。`adb` 与 `scrcpy-server` 已随包，拷目录即用。

**能力在插件，路径在 skill。** 换平台（京东 → 淘宝 → 抖音）只加 skill，插件不动。

## 能力

- **实时画面**：scrcpy-server 推 H.264，浏览器原生 WebCodecs 硬解；无 WebCodecs 时降级为每秒 2 张快照
- **亚毫秒控制**：不走 `adb shell input`，直接注入 `INJECT_TOUCH_EVENT` / `INJECT_KEYCODE` / `INJECT_TEXT` / `INJECT_SCROLL_EVENT` —— 点按、长按、拖拽、滚轮、双指缩放、中文输入
- **截屏 / 长截图**：单帧截图，或逐帧采集 + 行剖面运动估计 + 增量拼接的整页长截图（超 22000px 自动切块 `-pNN.png`）
- **键盘直通**：点面板即聚焦，按键直接进手机（含 Backspace/方向键），中文交给手机输入法；焦点在面板自己的输入框里时自动让路，不抢输入
- **控制权**：AI 优先，人一碰画面即接管，静默 90s 自动交还
- **12 个模型工具 + 18 个 HTTP 接口**，模型与外部脚本都能用

## 环境要求

| 需要 | 说明 |
|---|---|
| Windows 10/11 | `install.ps1` 与随包 `adb.exe` |
| DSH | desktop profile，`>= 0.2.0-rc.2` |
| Node | ≥ 20（插件运行时零 npm 依赖：adb 走命令行，PNG 编解码用自带 `src/core/png.js`） |
| 安卓手机 | 「开发者选项 → USB 调试」打开，插 USB，弹窗点「一律允许」；建议 USB 模式选「传输文件」 |
| 可选 | `dsh-better-sidebar ^0.25.0` —— 只有「侧栏 tab」需要它；没装则没有侧栏面板，但**设置项在 DSH「插件」页里照样能用**，模型工具也照常可用 |

**adb 查找顺序**（`vendor/platform-tools/adb.exe` 已随包，一般不用管）：
插件 config `adbPath` → `DSH_ADB` → `<插件>/vendor/platform-tools/` → `<cwd>/vendor/platform-tools/` → `%LOCALAPPDATA%\Android\Sdk\platform-tools\` → QtScrcpy 目录（版本号降序）→ Program Files → PATH

## 安装

```powershell
# 解压到任意目录，cd 进去，然后：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
# 重启 DSH → 装了 better-sidebar 时侧栏出现「📱 手机」tab；设置项始终在「插件」页 → dsh-android-phone

... -WhatIfOnly   # 只预览要改什么
... -Copy         # 复制成自包含（不用 junction）
... -Uninstall    # 卸载
```

脚本做四件事：包 junction 到 `<profile>\node_modules\dsh-android-phone`、名字加进 `dsh.profile.bundles`、`dependencies` 声明 `link:<相对路径>`、把 `skills/` **同步一份**到 `<profile>\vendor\dsh-android-phone\skills` 并登记成 skill 根。

- 官方 `dsh plugin add` 会拒绝 desktop profile（"managed exclusively by the Electron application"），所以安装由脚本自己做。
- ⚠️ `install.ps1` 必须保持 **UTF-8 BOM**：Windows PowerShell 5.1 读无 BOM 的 `.ps1` 会按 ANSI 解码，中文变乱码并报一堆假的 `Missing closing '}'`。
- 装好后 profile 里是**链接**（junction），直接改仓库文件就生效，不用重装。
- 装完想确认环境是否齐备：`npm run doctor`。

## 侧栏

- **画面**：点 = 点击手机，按住 = 长按，拖动 = 真拖拽（DOWN + 连续 MOVE + UP），滚轮 = `INJECT_SCROLL_EVENT`（实测 1 格 = 192 设备像素 ≈ 0.08 屏），双指 = 缩放
- **清晰度**：自适应（按面板 DPR 倒推 `maxSize`）/ 省流 / 标准 / 高清，改完重新拉流
- **截图 / 长截图**：落盘 `<shotsDir>`（默认 `~/.dsh/android-phone/shots`）
- **⚙ 设置**：截图保存地址、自动清理天数（关闭 / 1 / 3 / 7 / 30 天）、Skill 位置（只读）、「▶ 打开」的候选 App。入口有两个：侧栏**顶栏画质右边的「⚙ 设置」**，以及 **DSH「插件」页 → `dsh-android-phone` 详情页**（不装 better-sidebar 就在这里改）
- **打开 App**：工具栏下拉选 App 再点「▶ 打开」。下拉**只列设置里保存过的候选**（默认京东/淘宝/拼多多/抖音/微信/QQ）；想加手机里已装的 App，去「⚙ 设置 → ④ 打开 App → 从手机添加」挑一个再保存（那里只列**桌面上有图标的 App**，名字默认包名末段、可以改成中文）。包名非法会被丢掉，全部非法则保留原列表
- **状态行**：`画面 N fps` · `M Mbps` · `编码 W×H` · `前台 <包名>`

## 会话与控制权

- **单会话**：只起一个 `scrcpy-server`，**video 与 control 是同一会话的两条 socket**（`adb reverse` + `tunnel_forward=false`，启动约 1.5s）。侧栏打开即起会话；无人订阅也无人操作超 45s 才停，所以模型能在后台操作手机
- **控制权**：默认 `owner=ai`。人一碰画面自动接管（`POST /takeover`），此后模型动作被拒；人静默 90s 自动交还，模型也可 `phone_takeover {owner:'ai'}` 立刻要回
- **画面是给模型的监视窗**：模型跑流程时人能实时看到每一步；人操作标记 `by:'human'`，与模型区分

## 模型工具（`phone_*`，12 个）

| 工具 | 用途 |
|---|---|
| `phone_status` | adb 路径/版本、在线设备、机型与 Android 版本、分辨率、前台 App、会话状态、控制权 |
| `phone_apps` | 列包名（默认第三方 App，可按关键字过滤，可只列桌面上有图标的） |
| `phone_open` | 把 App 切到前台（默认京东）；模型调用时**自动起会话** |
| `phone_screenshot` | 单帧截图 |
| `phone_longshot` | 长截图（自动滚动拼接，可切块） |
| `phone_inspect` | 读当前界面控件树（text / desc / id / clickable / bounds） |
| `phone_action` | `tap` / `long_press` / `drag` / `scroll` / `wheel` / `key` / `text` / `wait` / `launch` |
| `phone_keyboard` | 输入文本（中文走手机输入法） |
| `phone_clipboard` | 读写手机剪贴板 |
| `phone_stream` | 起停会话、切画质 |
| `phone_preset` | 执行预置动作序列（`actions/*.json`） |
| `phone_takeover` | 交还 / 抢占控制权 |

坐标一律 **0~1 相对值**，宿主换算成视频像素。

## HTTP API

前缀 `/dsh-android-phone/api`：

```
GET  /status  /video  /snapshot
POST /session /owner /takeover /action /open /keyboard /inspect
     /shot /longshot /stream /settings /skills /clipboard /apps /close
```

`GET /video` 返回 `application/octet-stream`：每帧 `4B 长度 + 1B flag + 8B pts + Annex-B 负载`，响应头带 `X-Video-Width` / `X-Video-Height` / `X-Scrcpy-Version`。

## 附带 skill（可选）

`skills/jd-shop-longshot` —— 京东搜索关键字 → 切「店铺」tab → 进目标店铺 → 店铺首页长截图。安装时自动注册到 profile，也可脱离插件单独跑：

```bash
node skills/jd-shop-longshot/scripts/jd-shop-longshot.mjs --keyword 牛奶 --shop 每日鲜语
```

`skills/` 只是约定位置：插件能力不依赖任何 skill。删掉自带的 skill（只留 `skills/README.md`）安装照样成功，只是不注册 skill 根。

> 注册的是 **profile 里的副本**，不是仓库路径 —— 所以仓库搬家/删除都不会让技能静默消失。
> 代价：改完 `skills/` 里的东西要重跑一次 `npm run install:profile`，再重启 DSH。
> 跟别的 skill 根重名时会自动改名成 `<name>-2`（同时改 `SKILL.md` 的 `name:`），不会互相覆盖。

## 工作原理

```
┌─ DSH 宿主进程（Node） ─────────────────┐
│  session.js  单会话管理 / 自愈 / 控制权  │      ┌─ 手机 ─┐
│  video.js    adb reverse + 帧解析       │ ───► │scrcpy- │
│  control.js  控制消息编码                │ ◄─── │server  │
│  longshot.js 逐帧拼接                    │      └────────┘
│  index.js    12 工具 + 18 HTTP 路由      │
└───────────────┬────────────────────────┘
                │ HTTP（视频流 + 控制）
┌───────────────▼────────────────────────┐
│  DSH 侧栏（浏览器）                      │
│  client.js  WebCodecs 解码 → canvas 上屏 │
└────────────────────────────────────────┘
```

关键设计（都是踩坑换来的，改代码前值得先看）：

1. **一个会话承载两个 socket**：server 按 `video → audio → control` 顺序建连，全部建完才发流头。所以控制通道必须和视频一起连，不能「先看画面再决定要不要控制」。
2. **走 `adb reverse` 而不是 `adb forward`**：forward 路径实测 2~4 秒后静默停流（server 自己 `destroyDisplay` 干净退出，无任何报错）。
3. **必须传 `cleanup=false`**：server 的 `CleanUp` 子进程第一件事就是删掉推上去的 jar（`unlinkSelf()`），不关会导致下次启动 `Aborted`。
4. **坐标用视频尺寸，不是设备像素**：服务端 `PositionMapper.map()` 要求 `Position.screenSize` 严格等于编码尺寸，不等就直接丢弃，只在 VERBOSE 日志里说一句。
5. **指针 DOWN/UP 每根手指都要发**：`POINTER_DOWN/UP` 由服务端改写并补 `pointerIndex`，客户端发 5/6 会让 Android 判定「index 0 又按了一次」而整条丢弃。

## 项目结构

| 路径 | 说明 |
|---|---|
| `index.js` | **宿主插件入口**：12 个 `phone_*` 工具、18 个 HTTP 路由、设置读写、截图目录清理、skill 索引 |
| `client.js` | **侧栏面板**（浏览器侧单文件；受 DSH `__ModuleLoader__` 约束，禁 JSX/TS/`import`） |
| `src/android/` | 与手机打交道：`adb.js` adb 封装、`video.js` 取流与帧解析、`control.js` 控制消息编码、`session.js` 单会话与自愈、`actions.js` 动作执行、`longshot.js` 长截图、`overlay.js` 固定栏蒙版 |
| `src/core/` | 与手机无关的纯逻辑：`stitch.js` 拼接算法、`png.js` PNG 编解码、`quality.js` 画质档、`attach.js` 附件落盘、`preview.js` 预览缩图 |
| `actions/` | 预置动作序列（`phone_preset` 读取） |
| `skills/` | 附带 skill（可选，安装时同步到 profile） |
| `test/` | `test-stitch` / `test-client` 离线；`test-plugin-tools` / `test-session` / `test-host` / `test-e2e-jd` 需真机 |
| `scripts/` | `install.ps1` 装进 profile、`doctor.mjs` 环境自检、`check.mjs` 静态校验（CI 与 git 钩子用） |
| `vendor/` | 随包的 `adb.exe`（platform-tools 37.0.1）与 `scrcpy-server`（v5.0.1） |
| `cordis.patch.yml` | 插件默认配置（adb 路径、起流参数等） |

## 开发

改哪里、怎么生效：

| 改动 | 生效方式 |
|---|---|
| `client.js` | **Ctrl+Shift+R** 硬刷新侧栏 |
| `index.js` / `src/**` / `cordis.patch.yml` | **重启 DSH** |
| `skills/**` / `actions/**` | `npm run install:profile` 后重启 DSH |
| `README` / `test/**` / `AGENTS.md` | 不用管 |
| `scripts/install.ps1` | 重跑安装脚本（并保持 UTF-8 BOM + LF） |

常用命令：

| 命令 | 作用 |
|---|---|
| `npm install` | 只装离线测试依赖（react / react-dom / jsdom）；插件运行时零 npm 依赖 |
| `npm test` | 离线回归：拼接 35 项 + 侧栏 UI 86 项，不需要手机、DSH、浏览器 |
| `npm run test:device` | 真机回归：工具与协议编码 + 单会话长跑 + HTTP 接口 + 京东全链路（**会占用手机**） |
| `npm run ci` | 提 PR 前跑这个：`node --check` 全量 + `install.ps1` 编码校验 + 离线回归 |
| `npm run doctor` | 本机环境自检（Node、adb、设备、profile 里的 junction 等） |
| `npm run hooks` | 启用 `.githooks`（一次性，仅本机生效） |
| `npm run install:profile` | 重新装进 DSH profile（换机器 / 挪仓库 / 改名后需要） |

- 报告写到 `test/reports/`（已 gitignore）。
- 跑测试需要 **Node ≥ 22.15**（`jsdom` 依赖的 `undici` 用到 `zlib.createZstdDecompress`）；插件运行时仍只需 Node ≥ 20。
- CI（`.github/workflows/test.yml`）：push / PR 时在 **windows × node 22/24** 跑 `npm run ci`。只跑 Windows 是因为 `package.json` 声明了 `os: ["win32"]`，linux runner 上 `npm install` 会直接 `EBADPLATFORM` 退出。

开发约定（硬约定、常见陷阱、改完要检查什么）集中在 **[AGENTS.md](AGENTS.md)**；协作流程见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。

## 已知限制

- 仅 Windows
- 中文输入依赖手机自带输入法（插件只负责把按键送进手机）
- 静止画面出帧率低（5~6fps）：scrcpy 虚拟显示只在内容变化时出帧，属正常现象
- 长截图对无限流 / 懒加载 / 倒计时页面可能有少量错位
- 部分机型 `input swipe` 会触发系统手势（控制通道路径不受影响）

## 常见问题

| 现象 | 处理 |
|---|---|
| 侧栏「未发现设备」 | 手机解锁、USB 调试已授权、换「传输文件」模式；仍不行跑一次 `<插件>\vendor\platform-tools\adb.exe devices` 看状态 |
| 画面不动 | 静止页面本来只有 5~6fps；若 fps 为 0 且手机前台在变，硬刷新侧栏（流结束会自动重连） |
| 点了没反应 | 多半是控制权在人手上（顶栏「✋ 人在操作」），点「↩ 交还模型」 |
| 长截图重复或接缝 | 吸顶 / 懒加载 / 倒计时动画会少量错位，先滚到顶再触发 |
| 安装脚本报假的语法错误 | `install.ps1` 的 BOM 丢了，`git checkout -- scripts/install.ps1` 还原 |

## 参与贡献

欢迎 Issue 与 PR。提 PR 前请跑一遍 `npm run ci`，并按 PR 模板填写测试情况（UI 改动附截图、协议层改动注明依据）。详细流程与代码约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本项目未使用 CLA：按 Apache-2.0 提交 PR 即视为同意以同一许可证授权你的贡献。

## 许可与致谢

本项目代码以 **Apache License 2.0** 授权，全文见 [LICENSE](LICENSE)，第三方组件声明见 [NOTICE](NOTICE)。

- [scrcpy](https://github.com/Genymobile/scrcpy)（Apache-2.0）—— `vendor/scrcpy-server` 原样分发；视频流协议与控制通道依据其公开源码独立实现
- [QtScrcpy](https://github.com/barry-ran/QtScrcpy)（Apache-2.0）—— 产品交互形态参考，未复制其代码
- [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)（Google）—— `vendor/platform-tools/` 原样分发，仅作运行依赖
- 长截图拼接思路参考 [SnowShot](https://github.com/CHENXCHEN/SnowShot)（逐帧采集 + 运动估计 + 增量拼接 + 置信度拒帧），纯 JS 实现，不依赖 OpenCV
