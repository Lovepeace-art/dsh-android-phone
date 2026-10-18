# dsh-android-phone

**把安卓真机搬进 DeepSeek Harness 的侧栏。** 实时画面、亚毫秒控制、截屏与长截图，并把同一套能力作为 `phone_*` 工具交给模型 —— 「AI 自动操作手机」和「人肉看手机」用的是**同一条链路、同一个会话**。

![京东店铺首页长截图示例](assets/longshot-demo.jpg)

> 上图为插件对京东「每日鲜语官方旗舰店」店铺首页的整页长截图：1080×5147，自动滚动拼接，无接缝无重复。

---

## 它是什么 / 不是什么

- **是**：真机屏幕的远程显示与操作。`adb` 把 `scrcpy-server` 推到手机上，画面 H.264 编码回传，输入走 scrcpy 控制通道；截图与长截图是真机像素口径。
- **不是**：模拟器。页面来自你手机上的真实 App（京东/淘宝/拼多多…），所以能拿到 App 内的页面。
- **不需要**：QtScrcpy、Android SDK、任何 npm 依赖。`adb` 与 `scrcpy-server` 都已随包，拷目录即用。

**能力在插件，路径在 skill。** 换平台（京东 → 淘宝 → 抖音）只加 skill，插件不动。

## 能力

- **实时画面**：scrcpy-server 推 H.264，浏览器原生 **WebCodecs** 硬解；没有 WebCodecs 时自动降级为每秒 2 张快照
- **亚毫秒控制**：不走 `adb shell input`，直接注入 `INJECT_TOUCH_EVENT` / `INJECT_KEYCODE` / `INJECT_TEXT` / `INJECT_SCROLL_EVENT`。点按、长按、拖拽、滚轮、双指缩放、中文输入全部可用
- **截屏 / 长截图**：单帧截图，或逐帧采集 + 行剖面运动估计 + 增量拼接的整页长截图（超过 22000px 自动切块成 `-pNN.png`）
- **键盘直通**：点面板即聚焦，按键直接进手机，中文交给手机输入法拼
- **控制权**：AI 优先，人可一键强抢；人静默 90s 自动交还
- **12 个模型工具** + **18 个 HTTP 接口**，模型与外部脚本都能用

## 环境要求

| 需要 | 说明 |
|---|---|
| 操作系统 | Windows 10/11（`install.ps1` 与随包 `adb.exe`） |
| DSH | desktop profile，`>= 0.2.0-rc.2` |
| Node | ≥ 20 |
| 安卓手机 | 打开「开发者选项 → USB 调试」，插 USB，弹窗点「一律允许」；建议 USB 模式选「传输文件」 |
| 可选 | `dsh-better-sidebar ^0.25.0`（侧栏 tab 需要；不装则只有宿主能力，模型工具照常可用） |

插件本身**零 npm 依赖**：adb 走命令行，PNG 编解码用自带的 `src/core/png.js`。

**adb 查找顺序**（`vendor/platform-tools/adb.exe` 已随包，一般不用管）：

```
插件 config 的 adbPath → 环境变量 DSH_ADB → <插件>/vendor/platform-tools/adb.exe
→ <cwd>/vendor/platform-tools/adb.exe → %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe
→ 桌面 / D:\Ruan 等处的 QtScrcpy 目录（按版本号降序）→ Program Files → PATH
```

## 安装

```powershell
# 1. 解压到任意目录，cd 进去
# 2. 装进 DSH desktop profile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1

# 其他用法
... -WhatIfOnly   # 先看要改什么
... -Copy         # 复制成自包含（不用 junction）
... -Uninstall    # 卸载
# 3. 重启 DSH，侧栏出现「📱 手机」tab
```

`install.ps1` 做四件事：把包 junction 到 `<profile>\node_modules\dsh-android-phone`、把名字加进 `dsh.profile.bundles`、在 `dependencies` 里声明 `link:<相对路径>`、把插件内的 `skills/` 并进 profile 的 skill 根（`jd-mall-capture` 会自动出现在技能列表）。

> 官方 `dsh plugin add` 会拒绝 desktop profile（"managed exclusively by the Electron application"），所以安装由脚本自己做。
>
> ⚠️ `install.ps1` 依赖 **UTF-8 BOM**：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解码，中文注释变乱码并报出一堆假的 `Missing closing '}'`。改这个文件请保持 BOM。

**改动生效规则**：宿主半边（`index.js` + `src/`）**必须重启 DSH**；侧栏（`client.js`）只要 **Ctrl+Shift+R 硬刷新**。

## 侧栏怎么用

- **画面**：实时 H.264。点画面 = 点击手机；按住 = 长按；拖动 = 滑动（真拖拽：DOWN + 连续 MOVE + UP）；滚轮 = `INJECT_SCROLL_EVENT`（实测 1 格 = 192 设备像素 ≈ 0.08 屏）；双指 = 缩放
- **清晰度**：`自适应`（按面板 DPR 倒推 `maxSize`）/ 省流 / 标准 / 高清，改完重新拉流
- **截图 / 长截图**：落盘到 `<shotsDir>`（默认 `~/.dsh/android-phone/shots`），可在设置页改路径与自动清理天数
- **设置页**：截图目录、自动清理（关闭/1/3/7/30 天）、插件自带 skill 索引
- **状态行**：`画面 N fps` · `M Mbps` · `编码 W×H` · `前台 <包名>`

## 会话与控制权

- **单会话**：只起一个 `scrcpy-server` 进程，**video 与 control 是同一个会话的两条 socket**（`adb reverse` + `tunnel_forward=false`，启动约 1.5s）。侧栏打开自动起会话；没人订阅也没人操作超过 `idleStopMs`（45s）才停，所以模型在后台也能操作手机
- **连接方向**：以**反向**为主，`forward` 兜底。实测 `adb forward` 路径上 server 会在 2~4 秒内静默停止采集（无异常、干净退出），反向路径稳定
- **控制权**：默认 `owner=ai`。人一碰画面就自动接管（侧栏先 `POST /takeover`），此后模型动作被拒（`手机控制权已被人工接管`）；人静默 90s 自动交还，模型也可用 `phone_takeover {owner:'ai'}` 立刻要回
- **画面是给模型的监视窗**：模型跑流程时人能实时看到每一步；人接管时会记录 `by:'human'`，与模型操作区分

## 模型能用什么（`phone_*`，共 12 个）

| 工具 | 用途 |
|---|---|
| `phone_status` | adb 路径/版本、在线设备、机型与 Android 版本、分辨率、前台 App、会话状态、控制权 |
| `phone_apps` | 列包名（默认只看第三方 App，可按关键字过滤） |
| `phone_open` | 把某个 App 切到前台（默认京东）；模型调用时**自动起会话** |
| `phone_screenshot` | 单帧截图 |
| `phone_longshot` | 长截图（自动滚动拼接，可切块） |
| `phone_inspect` | 读当前界面控件树（text/desc/id/clickable/bounds） |
| `phone_action` | `tap` / `long_press` / `drag` / `scroll` / `wheel` / `key` / `text` / `wait` / `launch` |
| `phone_keyboard` | 输入文本（中文走手机输入法） |
| `phone_clipboard` | 读写手机剪贴板 |
| `phone_stream` | 起停会话、切画质 |
| `phone_preset` | 执行预置动作序列（`actions/*.json`） |
| `phone_takeover` | 交还 / 抢占控制权 |

坐标一律用 **0~1 相对值**，宿主换算成视频像素。

## HTTP API

前缀 `/dsh-android-phone/api`：

```
GET  /status  /video  /snapshot
POST /session /owner /takeover /action /open /keyboard /inspect
     /shot /longshot /stream /settings /skills /clipboard /apps /close
```

`GET /video` 返回 `application/octet-stream` 流：每帧 `4B 长度 + 1B flag + 8B pts + Annex-B 负载`，响应头带 `X-Video-Width` / `X-Video-Height` / `X-Scrcpy-Version`。

## 附带 skill

`skills/jd-mall-capture` —— 京东搜索关键字 → 切「店铺」tab → 进目标店铺 → 店铺首页长截图。安装时自动注册到 profile 的 skill 根，模型可直接调用；也可以脱离插件单独跑：

```bash
node skills/jd-mall-capture/scripts/jd-shop-longshot.mjs --keyword 牛奶 --shop 每日鲜语
```

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

几个关键设计（都是踩坑换来的，改代码前值得先看）：

1. **一个会话承载两个 socket**：server 按 `video → audio → control` 顺序建连，全部建完才发流头。所以控制通道必须和视频一起连，不能「先看画面再决定要不要控制」。
2. **走 `adb reverse` 而不是 `adb forward`**：forward 路径实测 2~4 秒后静默停流（server 自己 `destroyDisplay` 干净退出，无任何报错）。
3. **必须传 `cleanup=false`**：server 的 `CleanUp` 子进程第一件事就是删掉推上去的 jar（`unlinkSelf()`），不关会导致下次启动 `Aborted`。
4. **坐标用视频尺寸，不是设备像素**：服务端 `PositionMapper.map()` 要求 `Position.screenSize` 严格等于编码尺寸，不等就直接丢弃，只在 VERBOSE 日志里说一句。
5. **指针 DOWN/UP 每根手指都要发**：`POINTER_DOWN/UP` 由服务端改写并补 `pointerIndex`，客户端发 5/6 会让 Android 判定「index 0 又按了一次」而整条丢弃。

## 测试

仓库自带两套测试，**改代码请先跑离线那套**（CI 也是跑它）：

```bash
npm install      # 只装离线测试依赖（react / react-dom / jsdom），插件运行时零 npm 依赖
npm test         # 离线回归：不需要手机、不需要 DSH、不需要浏览器
```

| 命令 | 覆盖 | 需要真机 |
|---|---|---|
| `npm test` | `test-stitch`（35 项，长截图拼接逐像素）+ `test-client`（66 项，侧栏逻辑/交互/键盘/剪贴板） | 否 |
| `npm run test:device` | `test-plugin-tools`（工具与协议编码）+ `test-session`（单会话长跑）+ `test-host`（HTTP 接口）+ `test-e2e-jd`（京东全链路） | **是** |

- 报告写到 `test/reports/`（已 gitignore）。
- 真机测试会占用手机：`test-e2e-jd` 会打开京东、搜索、进店铺、跑长截图；跑之前请把手机放一边。
- 跑测试需要 **Node ≥ 22.15**：`jsdom` 依赖的 `undici` 用到 `zlib.createZstdDecompress`，Node 20 上加载即失败。插件运行时本身零 npm 依赖，Node ≥ 20 即可。
- CI 见 `.github/workflows/test.yml`：push / PR 时在 **windows × node 22/24** 上跑 `npm test`。只跑 Windows 是因为 `package.json` 声明了 `os: ["win32"]`（插件靠 `install.ps1` + `adb.exe` 装进 DSH desktop profile），linux runner 上 `npm install` 会直接 `EBADPLATFORM` 退出。

## 已知限制

- 仅 Windows
- 中文输入依赖手机自带输入法（插件只负责把按键送进手机）
- 静止画面出帧率低（5~6fps）：scrcpy 虚拟显示只在内容变化时出帧，属正常现象
- 长截图对无限流 / 懒加载 / 倒计时页面可能有少量错位
- 部分机型 `input swipe` 会触发系统手势（控制通道路径不受影响）

## 常见问题

**侧栏说「未发现设备」**
手机解锁、USB 调试已授权、换「传输文件」模式。仍不行就手动跑一次 `<插件>\vendor\platform-tools\adb.exe devices` 看状态。

**画面不动**
先看底栏 fps：静止页面本来就只有 5~6fps。若 fps 为 0 且手机前台在变，硬刷新侧栏（流正常结束会自动重连）。

**点了没反应**
多半是控制权在人手上（顶栏「✋ 人在操作」），点「↩ 交还模型」。

**长截图有重复或接缝**
页面有吸顶/懒加载/倒计时动画时会少量错位，可先滚到顶再触发。

## 许可与致谢

本项目代码以 **Apache License 2.0** 授权，全文见 [LICENSE](LICENSE)，第三方组件声明见 [NOTICE](NOTICE)。

- [scrcpy](https://github.com/Genymobile/scrcpy)（Apache-2.0）—— `vendor/scrcpy-server` 原样分发；视频流协议与控制通道依据其公开源码独立实现
- [QtScrcpy](https://github.com/barry-ran/QtScrcpy)（Apache-2.0）—— 产品交互形态参考，未复制其代码
- [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)（Google）—— `vendor/platform-tools/` 原样分发，仅作运行依赖
- 长截图拼接思路参考 [SnowShot](https://github.com/CHENXCHEN/SnowShot)（逐帧采集 + 运动估计 + 增量拼接 + 置信度拒帧），纯 JS 实现，不依赖 OpenCV
