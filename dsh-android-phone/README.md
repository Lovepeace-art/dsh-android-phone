# dsh-android-phone

在 DSH 侧栏里放一台**安卓真机**：实时画面（scrcpy H.264 流）、点按/滑动/系统键注入、单屏截图与「一页一屏到底」的长截图，并且把同一套能力作为 `phone_*` 工具交给模型 —— 「AI 自动操作手机页面」和「人肉看手机」用的是**同一条链路、同一个会话**。

> 血统：视频流与控制协议对齐 [scrcpy v5.0.1](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1) 的 `scrcpy-server`（Apache-2.0），桌面端用法参考 [QtScrcpy](https://github.com/barry-ran/QtScrcpy)；长截图拼接参考 [SnowShot](https://github.com/CHENXCHEN/SnowShot) 的思路（逐帧采集 + 运动估计 + 增量拼接 + 分块画布 + 置信度拒帧），本工程用纯 JS 重写，不依赖 OpenCV。

## 它是什么 / 不是什么

- **是**：真机屏幕的远程显示与操作（`adb` 推 `scrcpy-server` 到手机上，画面 H.264 编码回传，输入走 scrcpy 控制通道），真机像素口径的截图与长截图。
- **不是**：模拟器。页面来自你手机上的真实 App（京东/拼多多/淘宝…），因此能拿到 App 内的页面。

## 依赖

| 需要 | 说明 |
| --- | --- |
| 安卓手机 | 打开「开发者选项 → USB 调试」，插 USB，弹窗点「一律允许」；建议 USB 模式选「传输文件」 |
| `adb.exe` | **已随插件打包**（`vendor/platform-tools/adb.exe`，platform-tools 37.0.1）。查找顺序：插件 config `adbPath` → `DSH_ADB` → `<插件目录>/vendor/platform-tools/adb.exe` → `<插件目录>/vendor/adb.exe` → `<cwd>/vendor/platform-tools/adb.exe` → `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` → 桌面/`D:\Ruan` 等处的 QtScrcpy 目录（按版本号降序）→ Program Files → PATH |
| `scrcpy-server` | **已随插件打包**（`vendor/scrcpy-server`，scrcpy v5.0.1，733930B）。也可用 QtScrcpy 目录里自带的那个 |
| 系统 | Windows，Node ≥ 20 |

插件本身**零 npm 依赖**（adb 走命令行，PNG 编解码用自带的 `src/core/png.js`）。侧栏画面用浏览器原生 **WebCodecs `VideoDecoder`**（硬解优先）；没有 WebCodecs 时降级成「每秒 2 张快照」。

## 安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1             # junction 挂载（改代码方便）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -WhatIfOnly # 先看要改什么
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Copy       # 复制成自包含
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall  # 卸载
```

脚本做四件事：把包装到 loader 能解析的位置（`<profile>\node_modules\<name>` junction）、把名字加进 `dsh.profile.bundles`、在 `dependencies` 里声明 `link:<相对路径>`、把 `<插件目录>\skills` **并进** profile `cordis.patch.yml` 里 `skill-filesystem` 的 `customSkillDirs`（技能随插件走，`jd-mall-capture` 会自动出现在技能列表里）。官方 CLI（`dsh plugin add`）会拒绝 `desktop` profile（"managed exclusively by the Electron application"），所以用这个脚本。

> `install.ps1` 依赖 **UTF-8 BOM**：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解码，中文注释会变成乱码并让解析器报出一堆假的 `Missing closing '}'`。改这个文件请保持 BOM。

**改动生效规则**：宿主半边（`index.js` + `src/`）**必须重启 DSH** 才会载入新代码；侧栏（`client.js`）只要 **Ctrl+Shift+R 硬刷新**（前提是 `pnpm run dev:web` 在跑，否则也要重启）。

## 会话与控制权

- **单会话**：`scrcpy-server` 只起一个进程，**video 与 control 是同一个会话的两条 socket**（`tunnel_forward=false` + `adb reverse`，启动约 1.5s）。侧栏打开时自动起会话；关掉侧栏后，如果既没人订阅也没人操作，超过 `idleStopMs`（默认 45s）才停，所以模型在后台也能操作手机。
- **连接方向**：以**反向**（server 连回宿主，`adb reverse localabstract:scrcpy_<scid>`）为主，`forward` 作兜底。实测同一台机器同一台手机，`adb forward` 路径上 server 会在 2–4s 内静默停止采集（无异常、干净退出），反向路径 3/3 稳定跑满 20s。
- **控制权**：默认 `owner=ai`（模型持有）。**人一碰画面就自动接管**（侧栏自己先 `POST /takeover`），此后模型的动作会被拒（`HTTP 500 ... 手机控制权已被人工接管`）；人静默 `humanHoldMs`（默认 90s）后自动交还，模型也可以用 `phone_takeover {owner:'ai'}` 立刻要回来。顶栏那颗胶囊只做显示（绿=模型持有，灰=人在操作），不再有「交还」按钮。
- **画面是给模型的监视窗**：模型跑流程时人能实时看到手机的每一步；人接管时会记录 `by: 'human'`，和模型的操作区分得开。

## 侧栏怎么用

- **打开京东**：把 `com.jingdong.app.mall` 切到前台（有控制通道时走 `START_APP`，约 0.4s；已在前台就不重启）。
- **画面**：实时 H.264。点画面 = 点击手机；按住 = 长按；拖动 = 滑动（走真拖拽：DOWN + 连续 MOVE + UP）；滚轮 = `INJECT_SCROLL_EVENT`（实测 1 格 = 192 设备像素 ≈ 0.08 屏，正数向下）。
- **清晰度**：`自适应`（按面板 DPR 倒推 `maxSize`，默认）/ 省流 / 标准 / 高清。改完会重新拉流。
- **截图 / 长截图**：落盘到 `<shotsDir>`（默认 `~/.dsh/android-phone/shots`）。
- **文字**：有控制通道时**中文直接能输**（scrcpy `INJECT_TEXT`，按 UTF-8 边界切段，每段 ≤300 字节）；回落 adb 时才只支持 ASCII。
- **状态行**：`画面 N fps` · `M Mbps` · `编码 W×H` · `前台 <包名>`；没起流时显示「未起流」，会话重启过则显示重启次数。

## 模型能用什么（`phone_*` 工具，共 12 个）

| 工具 | 用途 |
| --- | --- |
| `phone_status` | adb 路径/版本、在线设备、机型与 Android 版本、屏幕分辨率、前台 App、会话状态（尺寸/帧数/重启次数/订阅者）、控制权 |
| `phone_apps` | 列包名（默认只看第三方 App，`filter` 可按关键字过滤） |
| `phone_open` | 把某个 App 切到前台（默认京东）；模型调用时会**自动起会话** |
| `phone_screenshot` | 单屏截图（真机像素），落盘 + 作为图片附件返回，模型能直接看图 |
| `phone_longshot` | 长截图（逐帧滚动拼接 + 固定栏遮罩 + 重复贴段自检），返回图片附件 |
| `phone_inspect` | uiautomator 控件树：文字/描述/包名/中心坐标（注意：京东首页这类自绘页面的树经常不可靠，用 `phone_status` 的 `foreground.activity` 判页面更稳） |
| `phone_action` | tap / long_press / drag / scroll / wheel / touch / key / text / launch / wait（坐标一律 **0~1 相对值**，宿主换算像素）；返回值带 `via: 'control' \| 'adb'` |
| `phone_keyboard` | 输入文字（走控制通道时中文可用），可 `submit` 回车 |
| `phone_stream` | 起/停/查侧栏视频流 |
| `phone_preset` | 跑命名动作序列（动作表来自 `actions/<app>.json`，京东是 `actions/jd.json`） |
| `phone_takeover` | 在「模型 / 人」之间切换控制权（`{owner:'ai'\|'human', reason}`） |

**坐标口径（最容易踩的坑）**：控制通道的坐标是**视频尺寸**（如 808x1800）的坐标系，不是设备物理像素（1080x2400）。模型给的是 0~1 相对值，宿主负责换算；`phone_action` 返回的 `screen` 是设备尺寸，别拿它去算控制通道的像素坐标。

设计约定：**能力在宿主，插件只做眼睛和手**；业务流程属于 **skill**（`<插件目录>/skills/jd-mall-capture`），换平台只加 skill，插件不动。

## HTTP 接口（侧栏与外部脚本共用）

前缀 `/dsh-android-phone/api`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 同 `phone_status`（可 `?serial=`） |
| GET | `/session` | 当前会话状态（尺寸/帧数/连接方向/重启次数/订阅者） |
| GET | `/owner` | 控制权、接管时长、`humanHoldMs` |
| GET | `/video?maxSize=&maxFps=&bitRate=` | **H.264 帧流**，`application/octet-stream`，每帧 `4B 大端长度 + 1B flag(1=config,2=key) + 8B pts + 负载(Annex-B)`；响应头带 `X-Video-Width/Height`、`X-Scrcpy-Version`、`X-Session-Owner` |
| GET | `/snapshot?scale=0.5` | 单张 PNG（可缩放，响应头带实际宽高） |
| POST | `/open` | `{package, waitMs}` |
| POST | `/action` | `{action, nx, ny, toNx, toNy, ms, key, dir, pages, text, package, human}` |
| POST | `/keyboard` | `{text, submit, human}` |
| POST | `/apps` | `{filter, system}` |
| POST | `/inspect` | `{max}` |
| POST | `/shot` | `{mode:'screen'\|'long', name, maxSteps, maskTop, maskBottom}` |
| POST | `/stream` | `{op:'stop'\|'start', maxSize, maxFps}` |
| POST | `/takeover` | `{owner, reason}` → 等价 `phone_takeover` |
| POST | `/owner` | `{owner, idleMs}` |
| POST | `/session` | `{op:'start'\|'stop'}` |
| POST | `/close` | 停会话 |

## 自测

```powershell
node scripts\test-plugin-tools.mjs   # 33 项：工具/路由/编码器字节数/控制权模型（假宿主，不需要真机）
node scripts\test-stitch.mjs         # 35 项：逐帧拼接器逐像素回归（纯离线）
node scripts\test-client.mjs         # 66 项：侧栏半边（假 window + jsdom；依赖 <仓库>\.client-test\node_modules 里的 react/react-dom/jsdom）
node scripts\test-host.mjs           # 36 项：宿主半边 + HTTP 接口 + 真机（需要手机连着）
node scripts\test-host.mjs --no-device       # 只验装配，不碰真机
node scripts\test-session.mjs 18     # 单会话长跑 + 控制注入落地 + 控制/adb 延迟对照（真机）
node scripts\test-e2e-jd.mjs         # 端到端：京东 → 搜索 → 进店 → 长截图（真机，会操作手机）
node scripts\serve-api.mjs --port 19399      # 假宿主起一个 HTTP 服务，方便联调/跑 skill 脚本
```

报告落在 `recon/reports/*.json`。当前实测：33/33、35/35、66/66、36/36 全绿，e2e 京东链路全绿（长截图 1080x5147）。

## 长截图是怎么做的

1. `screencap` 抓一帧 → 2) 用「每行分箱平均亮度」的行剖面 + 抽样行原始像素复核，估出帧间位移 dy（候选平局整体复核，位移差 <8px 视作等价）→ 3) 只把**新增的 dy 行**贴进分块画布（固定栏永远不贴，避免底栏在长图里反复出现）→ 4) 固定栏高度：先用**控件树**（底部一排等宽可点节点 = tab 栏）量，再用像素法兜底 → 5) 滚动用 `input swipe` 但把时长按距离算（约 1.5 屏/秒，避免 fling 飞过头导致两帧没有重叠）→ 6) 收工后自检：精确重复块 / 粗粒度重复 / 连续同签名行，任一超标就报出来。

没滚动的页面（一屏到底）不会硬拼；超过 `maxHeight`（22000px）自动切块成 `<name>-pNN.png`。

## 已知限制

- 有别人（QtScrcpy 桌面窗口）正在用同一台手机时，scrcpy 会话会抢编码器：**同一时刻只能有一个消费者**。插件会报错并可能降级成快照模式。
- `INJECT_TEXT` 单条上限 300 字节（中文约 100 字），更长的会被切段发送。
- 部分机型 `input swipe` 会触发系统手势（贴边起手会被当成返回/下拉），滚动起手点已收在屏幕中间区域；走控制通道时用真拖拽，不受这条影响。
- 京东首页这类自绘页面的 uiautomator 树经常缺关键节点（搜索框可能没有 `text`，只有 `content-desc`）；skill 里已按 activity + `desc` 判据兜底，并备了落点小抄坐标。
- 长截图对「无限流 + 懒加载 + 倒计时动画」的页面会有少量行对不上，靠「压倒性增益」通道接受正确位移；若页面自己乱跳（视频广告）会拒帧少拼几屏。
