# AGENTS.md

本文件是**协作约定的唯一出处**：仓库地图、数据流、硬约定、改动检查清单、已知陷阱。
面向本仓库干活的 AI 助手与人类接手者。

> **请不要在别处重复这里的条款。** 同一件事写两处，迟早只改一处、另一处静默过期。
> `README.md` 面向使用者，`CONTRIBUTING.md` 面向贡献流程，冲突时**以本文件为准**。

---

## 1. 这是什么

DSH（DeepSeek Harness）插件：把安卓真机搬进 DSH 侧栏（实时画面 + 输入注入 + 截图/长截图），
同时把这些能力作为 12 个 `phone_*` 工具交给模型。**能力在插件，业务流程在 skill。**

- 运行时零 npm 依赖；`vendor/` 随包 `adb.exe` 与 `scrcpy-server`，不依赖 QtScrcpy / Android SDK。
- 只支持 Windows；宿主是 Node（ESM），侧栏是浏览器里的单文件 React（无 JSX）。

## 2. 仓库地图

| 路径 | 职责 | 关键符号 |
|---|---|---|
| `index.js` | 宿主入口：工具定义、HTTP 路由、设置读写、截图清理、skill 索引 | `apply()`、`buildToolDefs()`、`shotsRoot()`、`readSettings()`、`cleanupShots()`、`listSkills()` |
| `client.js` | 侧栏面板（单文件，`window.__ModuleLoader__` 的 factory） | `apply()`、`Panel`、`Screen`、`SettingsSheet`、`useVideoStream` |
| `src/android/adb.js` | adb 命令行封装与设备查询 | `pickDevice()`、`screenMetrics()`、`currentFocus()`、`uiDump()`、`parseUiXml()`、`screencap()`、`listLaunchablePackages()` |
| `src/android/video.js` | 起 `scrcpy-server`、连接、帧解析、清残留 | `startVideoStream()`、`parseStreamHeader()`、`splitPackets()`、`ensureServerPushed()`、`sweepScrcpyReverseSync()`、`killStrayServerSync()` |
| `src/android/control.js` | 控制消息编码（23 种 type）+ 通道封装 | `createControlChannel()`、`encInject*()`、`splitUtf8()`、`KEYCODES`、`POINTER` |
| `src/android/session.js` | 单会话管理器：自愈、控制权、空闲停流 | `ensureSession()`、`stopSession()`、`getControl()`、`sessionInfo()`、`setOwner()`、`assertAiAllowed()` |
| `src/android/actions.js` | 把抽象动作翻译成控制通道/ adb 操作 | `runAction()`、`runActions()`、`resolvePoint()`、`ensureForeground()` |
| `src/android/longshot.js` | 长截图编排：滚动 + 取帧 + 拼接 + 切块 | `androidLongshot()` |
| `src/android/overlay.js` | 从控件树推断固定栏，生成蒙版 | `overlayMaskFromUi()` |
| `src/core/stitch.js` | 纯算法：行剖面运动估计 + 增量拼接 | `estimateOffset()`、拼接主流程 |
| `src/core/png.js` | 纯 JS PNG 编解码（零依赖） | `encodePng()`、`decodePng()` |
| `src/core/quality.js` | 画质档位（自适应/省流/标准/高清 → maxSize、bitRate） | 档位表 |
| `src/core/attach.js` | 截图落盘 + 附件登记 | `saveShot()` |
| `src/core/preview.js` | 生成预览缩图 | `needsPreview()`、`makePreviewPng()` |
| `actions/*.json` | 预置动作序列（`phone_preset` 读取） | `jd.json` |
| `skills/<name>/` | 可选 skill；安装时**复制**到 profile 并登记 | `SKILL.md` |
| `test/` | 6 个套件，离线 2 + 真机 4 | 见 §5 |
| `scripts/install.ps1` | 装进 DSH profile（junction + bundles + dependency + skill 根） | 参数 `-WhatIfOnly/-Copy/-Uninstall` |
| `scripts/doctor.mjs` | 10 项只读自检 | `npm run doctor` |
| `scripts/check.mjs` | 静态校验（语法 / `install.ps1` 编码 / `.gitattributes`） | `npm run check` |
| `vendor/` | 随包二进制：platform-tools 37.0.1、scrcpy-server v5.0.1 | 原样分发，不改 |
| `cordis.patch.yml` | 插件默认配置（adb 路径、起流参数） | — |

## 3. 数据流

**视频**：`startVideoStream()` → `adb reverse localabstract:scrcpy_<scid> tcp:<port>` → server 主动连回本机 TCP →
第 1 条连接 = video（其余按 audio→control 顺序）→ 解析流头 → 12 字节包头逐帧切分 → `index.js` 的 `/video`
用 `4B 长度 + 1B flag + 8B pts` 转发给侧栏 → `client.js` WebCodecs 解码 → canvas。

**控制**：第 2 条连接 = control → `control.js` 编码 32/21/14/5+N 字节的大端消息 → 服务器 `ControlMessageReader` 解析。
坐标必须落在**视频尺寸**空间（见 §4.4）。

**截图 / 长截图**：`screencap`（走 adb，不占视频链路）或逐帧采集 → `stitch.js` 行剖面估位移 →
`attach.js` 落盘到 `shotsDir` → 超过 `maxHeight` 切块 `-pNN.png`。

## 4. 硬约定（违反会静默出错，不是崩溃）

1. **`install.ps1` 必须 UTF-8 BOM + LF**。Windows PowerShell 5.1 读无 BOM 的 `.ps1` 按 ANSI(CP936) 解码，
   中文变乱码并报一堆假的 `Missing closing '}'`。`npm run check` 会校验前 3 字节是否为 `EF BB BF` 且无 CRLF。
   改这个文件要用「读全文 → 字符串替换 → 以 `UTF8Encoding($true)` 写回」，不要用会丢 BOM 的编辑器/工具直接覆盖。
2. **`client.js` 是单文件**：不能用 JSX / TypeScript / `import` / `export`，只能 `React.createElement`
   （代码里简称 `h`）；只能通过 factory 的参数 `require` 取 `react`。样式集中在文件顶部的 `S` 与调色板
   `V`（CSS 变量 `--dshp-*`，深浅主题由宿主父元素颜色派生）。
3. **`cleanup=false` 必传**：`scrcpy-server` 的 `CleanUp` 子进程启动第一件事就是 `unlinkSelf()` 删掉推上去的 jar，
   不关它下次启动会 `Aborted`。
4. **坐标用视频尺寸，不是设备像素**：服务端 `PositionMapper.map()` 要求 `Position.screenSize` 严格等于**编码尺寸**，
   不等就直接 `return null` 丢弃，只在 VERBOSE 日志里说一句。`control.js` 的 `checkPoint()` 会拦越界点。
5. **走 `adb reverse`，不用 `adb forward`**：forward 路径实测 2~4 秒后静默停流（server 自己 `destroyDisplay`
   干净退出，无报错）。forward 只作兜底。
6. **控制通道必须与视频同时连**：server 按 `video → audio → control` 顺序建连，**全部建完才发流头**；
   只连 video 会永远收不到流头。
7. **指针 DOWN/UP 每根手指都要发**：`POINTER_DOWN/UP` 由服务端改写并补 `pointerIndex`，客户端自己发 5/6
   会让 Android 判定「index 0 又按了一次」而整条丢弃。
8. **协议以 `ref/` 里的 scrcpy v5.0.1 源码为准**（`ControlMessageReader` / `PositionMapper` / `Controller` /
   `DeviceMessageWriter` / `Server` / `Options`）。字节布局凭记忆改必然出错。
9. **不引入运行时依赖**。`devDependencies` 只给测试用（react / react-dom / jsdom）。新增任何运行期依赖需要
   先讨论，因为它会破坏「拷目录即用」。
10. **`vendor/` 原样分发，不修改**。升级 = 整包替换 + 在 `NOTICE` 注明版本与来源。

## 5. 改动检查清单

按你改的东西选：

- 改 `client.js` → `node --check client.js` + `npm test`；UI 改动附截图（Ctrl+Shift+R 后看真实侧栏）
- 改 `index.js` / `src/**` → `npm run ci`；协议层改动补 `npm run test:device`（真机）
- 改 `scripts/install.ps1` → `npm run check`（BOM/LF）+ `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -WhatIfOnly` 干跑
- 改 `skills/**` → `npm run install:profile` 后重启 DSH 验证技能可见
- 改了对外接口（工具名/参数/HTTP 路由） → 同步 `README.md` 的工具表与接口列表，`CHANGELOG.md` 记一笔
- 发版 → `package.json` 的 `version`、`CHANGELOG.md` 加小节、打 tag

**测试套件**：

| 命令 | 覆盖 | 需要真机 |
|---|---|---|
| `npm test` | `test-stitch`（35 项，逐像素拼接）+ `test-client`（86 项，侧栏 UI/键盘/剪贴板/设置/打开 App） | 否 |
| `npm run test:device` | `test-plugin-tools`（工具与编码）+ `test-session`（单会话长跑）+ `test-host`（HTTP）+ `test-e2e-jd`（京东全链路） | **是** |

真机测试会抢手机焦点、打开设置/京东等 App。跑之前把手机放一边；别在登着他人账号的手机上走到购买/支付路径；

## 6. 已知陷阱（都真实发生过）

1. **`adb` daemon 起不来**，报 `cannot open %TEMP%\adb.log: Permission denied` → 把 `TEMP/TMP` 指到可写目录再 `adb start-server`。
2. **设备 `unauthorized`** → 手机上点「一律允许」；RSA 指纹删掉重插。
3. **`app_process ... Aborted`（exit 134）** → 推上去的 jar 已经不在了（被 `CleanUp` 删了或没推成功），重新推。
4. **画面 2~4 秒后自己停** → 走了 forward 路径，见 §4.5。
5. **点击没反应但 adb 点得动** → `Position.screenSize` 与编码尺寸不一致，事件被静默丢弃，见 §4.4。
6. **`am start -n <pkg>/.Settings` 返回 ok 但 App 不起来** → Android 12 上未导出的 Activity 会静默失败，用 `monkey` 或解析出的默认 Activity。
7. **中文输入** → 控制通道 `INJECT_TEXT` 可直接送 UTF-8（≤300 字节，按字符边界切分）；走 adb 时只能 ASCII。
8. **`ps -A` 里看不到 scrcpy server** → 进程名是 `app_process`（不是类名），别拿类名当存活判据；用抽象 socket 是否存在判断。
9. **`adb reverse --remove tcp:<port>` 删不掉映射** → 必须按 `localabstract:scrcpy_*` 删；启动前用 `sweepScrcpyReverseSync()` 清残留。
10. **静止画面 fps 低** → 虚拟显示只在内容变化时出帧，5~6fps 是正常的，不要试图「补帧」。
11. **`edit`/`write` 工具会丢 BOM** → 改完 `.ps1` 用 `UTF8Encoding($true)` 重写并验证前 3 字节（§4.1）。
12. **`.NET` 文件 API 用进程 CWD，不认 PowerShell 的 `Set-Location`** → 脚本里一律用绝对路径。

## 7. 不要做

- 不要在仓库里提交 `test/reports/`、`recon/`、`out/`、`*.bak-*`、`PROBE-*`（都已在 `.gitignore`）。
- 不要把本机的绝对路径、设备序列号、账号信息写进仓库文件。
- 不要在 `client.js` 里改用 `fetch`/`EventSource` 之外的传输方式而不改宿主对应路由（视频是 `application/octet-stream` 长连接）。
- 不要为了让测试变绿去放宽断言，尤其 `test-client` 里关于「键盘直通不抢输入框」「下拉只列保存过的 App」这两类行为断言 —— 那是用户明确要求。
