# 飞鸟手机插件 DSH 化改造计划

> **状态（2026-10-16 收尾）**：本计划**已执行完毕**（阶段 0/1/2/3 全部落地，已装进真实 desktop profile，等重启眼验）。
> 执行过程中的**实际差异、逐项决策、踩过的坑**都在 `PROGRESS.md`（§1 当前状态 / §3 坑 / §5 阶段勾选 / §6 待拍板 / §7 决策），
> 与本文档不一致时**以 `PROGRESS.md` 为准**。本文档保留为「当初为什么这么设计」的依据。
>
> 基线：`飞鸟手机插件-dsh-android-phone-20261016.zip`（35 文件 / 325,542 字节）
> 本项目目录：`C:\Users\Administrator\Desktop\DSH\feiniao-android-phone\`
> 目标仓库内结构：
> ```
> feiniao-android-phone/
>   dsh-android-phone/     插件本体（宿主 + 侧栏 client）
>   skills/jd-mall-capture/  skill（路径/流程）
>   验证报告/               历史验收报告（基线证据，只读）
>   安装说明.txt            基线说明
>   vendor/                 ← 新增：随插件分发的运行时
>   PLAN.md                 ← 本文件
> ```

---

## 0. 一句话结论

体积不是问题（318KB 全是纯 JS 源码、零 npm 依赖，真正没打进去的只有约 10MB 运行时）。
**主因是 `video.js:201` 传来传去的 `control=false`——scrcpy 控制通道整条没用**，
输入被迫退回 `adb shell input`，实测 `tap` 306ms、`scroll` 674ms（每次冷启 ART 虚拟机约 200ms）。

---

## 1. 目标与非目标

### 这一版要做

1. **单会话**：`video + control` 同一个 scrcpy-server 会话，跟随侧边栏"手机"页签打开/关闭。
2. **控制通道**：注入改走 scrcpy 二进制控制协议，不再走 `adb shell input`。
3. **控制权模型**：AI 优先，人只观；AI 空闲时人可操作；人可强制抢占。
4. **低延迟渲染**：修掉积压策略、无背压、分辨率档拍脑袋三处。
5. **运行时打包**：`vendor/` 随插件带 `adb.exe` + 2 个 DLL + `scrcpy-server`（约 10MB）。
6. **接口零变更**：`phone_*` 工具名与参数、`jd.json` 动作表、`SKILL.md` 全部不动。

### 这一版不做

- 侧栏字体发虚（按用户要求跳过，但留基线测量，见 §5 阶段 2.4）
- 原生桌面窗口方案（效果不好再回头）
- 音频、`adb shell input` 回落路径的删除（保留为 fallback）
- 弹窗播放（下一版）

---

## 2. 三个核心设计

### 2.1 控制通道归宿主（Node），不归浏览器

- 模型走 `phone_action` 工具，executor 在宿主进程；浏览器够不着控制 socket。
- 一个会话只能有一个控制连接，**必须有人独占** → 放宿主即天然独占。
- 顺带白送：人与模型天然共用一条通道、天然串行化。

→ `client.js` 的输入路径几乎不变（还是 `POST /action`），换的是宿主那一头的注入后端。

### 2.2 单会话 + 跟随侧边栏（用户 2026-10-16 拍板）

- 会话 = 一个 scrcpy-server 进程 = **两个 adb forward 隧道 + 两条 socket**。
- **关键约束**（来自 scrcpy v5.0.1 `DesktopConnection.open()`）：`tunnel_forward=true` 时服务端
  `new LocalServerSocket("scrcpy_<scid>")` 后**按 video → audio → control 顺序 accept**。
  所以必须：
  1. `adb forward tcp:V localabstract:scrcpy_<scid>` 与 `adb forward tcp:C localabstract:scrcpy_<scid>`
  2. **先连 V**（收 1 字节 dummy + 64 字节设备名 + 流头），确认视频建立
  3. **再连 C**（控制）
  - 顺序错了会把控制连成视频连；而且如果服务端在 `open()` 里 accept 完所有 socket 才起流，
    **不连控制会导致视频永远不出帧** → 阶段 0 必须验证这一点。
- `scid` 同名 `scrcpy_%08x`；端口复用同一个 scid，两条 forward 用不同 host 端口。
- 生命周期 API 全部收进一个 `session.js`（新建），`video.js` / `control.js` 都从它取 socket。

### 2.3 控制权状态机（用户 2026-10-16 拍板）

| 状态 | 谁能写 | 进入条件 | 退出条件 |
|---|---|---|---|
| `idle` | 人 + AI | 会话就绪且无人持有 | 任一方发起操作 |
| `human` | 只有人 | 侧栏指针活动 | 空闲 3s |
| `ai` | 只有 AI | `phone_action` 进入动作序列 | 序列跑完 / 空闲 30s 上限 / 被抢占 |
| `preempted` | 只有人 | 人点"接管" | 人空闲 3s → `idle` |

规则：

1. **AI 持锁时人只读**：侧栏 canvas 上的 tap / drag / 滚轮**不注入**，改为浮层提示
   "AI 正在操作 · 点此接管"。
2. **强制抢占**：人点接管 → 立即 `preempted`，取消 AI 当前序列剩余步骤；
   AI 下一次 `phone_action` 返回 `{ ok:false, error:'preempted_by_human' }`。
3. **看门狗**：`ai` 态最多持有 30s（可配），防止模型卡死不放锁。
4. **所有注入走一个串行队列**（宿主侧 `injectQueue`），保证字节流不乱序、不交错。
5. `/status` 返回 `{ owner, session, via }`，侧栏据此渲染。
6. 新增 `POST /takeover`（人抢占）。

**跟随侧边栏的后果（需用户确认）**：页签关闭 = 会话停 = **模型无法操作手机**。

- 建议的软化：页签关闭后给 **60s 宽限期**；模型发起动作时若会话已停，**自动拉起**（约 1.75s）。
  `phone_status` 里如实返回 `session: 'stopped' | 'starting' | 'ready'`。

---

## 3. 控制协议（已对 scrcpy v5.0.1 源码核实，可直接照写）

来源：`server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java`、
`app/src/control_msg.h`。**全部大端。**

| 消息 | type | 负载（顺序即字节顺序） |
|---|---|---|
| INJECT_KEYCODE | 0 | u8 action, i32 keycode, i32 repeat, i32 metaState |
| INJECT_TEXT | 1 | u32 len + len×UTF-8（单条上限 **300 字节**） |
| INJECT_TOUCH_EVENT | 2 | u8 action, i64 pointerId, Position, i16 pressure(定点), i32 actionButton, i32 buttons |
| INJECT_SCROLL_EVENT | 3 | Position, i16 hScroll, i16 vScroll, i32 buttons |
| BACK_OR_SCREEN_ON | 4 | u8 action |
| EXPAND_NOTIFICATION_PANEL / EXPAND_SETTINGS_PANEL / COLLAPSE_PANELS | 5 / 6 / 7 | 空 |
| GET_CLIPBOARD | 8 | u8 copyKey |
| SET_CLIPBOARD | 9 | i64 sequence, u8 paste, u32 len + bytes |
| SET_DISPLAY_POWER | 10 | u8 on |
| ROTATE_DEVICE | 11 | 空 |
| UHID_CREATE | 12 | u16 id, u16 vendorId, u16 productId, u8 nameLen+name, u16 dataLen+data |
| UHID_INPUT / UHID_DESTROY | 13 / 14 | u16 id, u16 len+data / u16 id |
| OPEN_HARD_KEYBOARD_SETTINGS | 15 | 空 |
| START_APP | 16 | u8 nameLen + UTF-8 包名 |
| RESET_VIDEO | 17 | 空 |
| CAMERA_SET_TORCH / CAMERA_ZOOM_IN / CAMERA_ZOOM_OUT | 18 / 19 / 20 | u8 bool / 空 / 空 |
| RESIZE_DISPLAY | 21 | u16 width, u16 height |
| SCAN_FILE | 22 | u32 len + UTF-8 path |

- **`Position` = i32 x, i32 y, u16 screenWidth, u16 screenHeight（10 字节）**
  —— 坐标自带屏幕尺寸，服务端自己映射。侧栏 canvas 归一化坐标 × `wm size` 即可。
- 滚动量是 **i16 定点，满量程 ±16**（`i16FixedPointToFloat` 假设 [-1,1] 但文档写明 ×16）
  → `i16 = round(value * 2048)`。
- `pointerId`：`-1` 鼠标、`-2` 普通手指、`-3` 虚拟手指（捏合缩放）。
- 空消息 = 只有 1 字节 type。`MESSAGE_MAX_SIZE = 1<<18`（256KB）。
- 待核实（阶段 0）：`ControlMessage.java` 的 type 常量值是否与上表枚举顺序一致；
  `DeviceMessage` 的字段布局（本轮两次 fetch 失败）。

### 能力映射

| 现有动作 | 现在（adb shell input） | 改后（control） |
|---|---|---|
| `tap` | `input tap`，306ms | INJECT_TOUCH_EVENT DOWN+UP，<10ms |
| `long_press` | 原地 swipe hack | DOWN → 等待 → UP |
| `drag` | 只发**一次** swipe，无中间 MOVE | DOWN + 插值 MOVE×N + UP（真拖拽） |
| `scroll` | `input swipe` 模拟，会 fling、量不准 | INJECT_SCROLL_EVENT，精确滚轮量 |
| `text` 中文 | **直接抛错**（`adb.js:413-419`） | INJECT_TEXT UTF-8，按 300 字节边界分段 |
| `launch` | `monkey` + 硬等 8s | START_APP 包名，立即返回 |
| `key`/`back` | `keyevent` | INJECT_KEYCODE / BACK_OR_SCREEN_ON |
| 息屏/旋屏 | 无 | SET_DISPLAY_POWER / ROTATE_DEVICE |
| 剪贴板 | 无 | GET_CLIPBOARD / SET_CLIPBOARD |
| 双指缩放 | 无 | pointerId `-3` |

---

## 4. 文件级改动清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `dsh-android-phone/src/android/session.js` | **新增** | 会话：起 server、两条 forward、按序建两条 socket、引用计数、宽限期、`owner` 状态机 |
| `dsh-android-phone/src/android/control.js` | **新增** | 控制协议编解码器 + 串行注入队列 + 抢占取消 |
| `dsh-android-phone/src/android/actions.js` | 改后端 | **动作表与数据格式不变**；`tap/long_press/drag/scroll/text/key/launch` 走 control，新增 `back`/`rotate`/`screen_on`/`screen_off` |
| `dsh-android-phone/src/android/adb.js` | 保留 | 截图 / `uiautomator dump` / `wm size` 继续用；注入类函数降级为 fallback |
| `dsh-android-phone/src/android/video.js` | 改 | `control=false` → `control=true`（`:201`）；`clipboard_autosync=false`；去掉 `C:\Users\30716\...` 硬编码（`:40-41`）；`vendor/` 提到查找首位；socket 改由 `session.js` 提供 |
| `dsh-android-phone/index.js` | 改 | `/action` 接 control + 锁校验；**宿主丢帧策略**（补上被 `void backpressure` 丢掉的背压，`:597-625`）；新增 `/takeover`；`/status` 加 `owner`/`session`/`via`；`/snapshot?scale=` 的三重循环优化（`:692-698`） |
| `dsh-android-phone/client.js` | 改 | `decodeQueueSize > 12` → `> 2`（`:231`）；去掉 `while(>10) await sleep(4)`（`:249`）；`maxSize` 按面板 DPR 自适应；降采样改 `createImageBitmap({resizeQuality:'high'})`；快照兜底从"每秒 2 张"改"暂停+提示"；AI 持锁时指针事件不发 `/action`、显示接管浮层；状态栏显示 owner |
| `dsh-android-phone/actions/jd.json` | 不动 | 15 条动作表原样 |
| `dsh-android-phone/package.json` | 改 | `files` 加 `vendor` |
| `dsh-android-phone/vendor/platform-tools/` | **新增** | `adb.exe` + `AdbWinApi.dll` + `AdbWinUsbApi.dll`（用 Android platform-tools **37.0.1**，不是 QtScrcpy 自带的 1.0.41） |
| `dsh-android-phone/vendor/scrcpy-server` | **新增** | 取自 scrcpy **v5.0.1** 发布包 |
| `dsh-android-phone/scripts/test-control.mjs` | **新增** | 控制通道真机验证：构造字节与手算 hex 比对、真机往返、延迟对照表 |
| `skills/jd-mall-capture/` | 不动 | 它是"没装插件时"的独立 CLI 兜底，保持可脱离插件跑 |

---

## 5. 阶段与验收

### 阶段 0：三个风险点清零（不写功能，必须先过）

| # | 动作 | 验收 |
|---|---|---|
| 0.1 | 用 scrcpy **v5.0.1** 的 `scrcpy-server` 跑现有回归（139 项） | 全绿 → 证明流头兼容。已核代码：v5.0 头 = 1+64+codec(4)+flags(4)+w(4)+h(4) = **81**，v4.x 头 = 77，插件的布局 A/B 已经把两者都兼容了 |
| 0.2 | 起 `video=true, audio=false, control=true` 单会话，**按序连两条 socket** | ① 先连 V 后连 C 不出错；② **不连控制 socket 时视频是否还出帧**；③ 发一条 `INJECT_KEYCODE(HOME)`，手机回到桌面 → **整个方案的单点验证** |
| 0.3 | 核对 `ControlMessage.java` 的 type 常量值 | 与 §3 表一致 |
| 0.4 | 核对 `clipboard_autosync=false` 是否被 server 接受 | 接受 → 宿主不必读设备侧消息，省一个读循环 |
| 0.5 | 分辨 `writeDisableStream` 的 code[3]=0（流关但继续）与 =1（配置错误必须停） | 插件能给出正确错误信息而不是静默挂住 |

**0.2 不过，整个 P0 要重新评估。所以第一件事就是它。**

### 阶段 1：控制通道落地

| # | 动作 | 验收 |
|---|---|---|
| 1.1 | `control.js` 编解码 + 串行队列 | 单测：每种消息字节 hex 与手算值逐字节相等 |
| 1.2 | `session.js` + `video.js` 改单会话 | 页签开→会话起；页签关→60s 后会话停；无进程残留 |
| 1.3 | `actions.js` 切后端，保留 adb 回落 | `jd.json` 15 条动作全部跑通，返回值带 `via` |
| 1.4 | 控制权状态机 + `/takeover` | AI 跑时人手点无效并有提示；点接管后 AI 序列立即中断；AI 空闲后人可操作 |
| 1.5 | 真机延迟对照表 | `tap` **306ms → <10ms**；`scroll` 674ms → <10ms；`text` 中文可用；真拖拽可用 |
| 1.6 | `jd-capture` 端到端 | 完整跑一次"打开京东→搜店铺→长截图"，与基线结果一致 |

### 阶段 2：低延迟渲染

| # | 动作 | 验收 |
|---|---|---|
| 2.1 | 宿主丢帧（`writableLength` 超阈值丢非关键帧） | 客户端故意卡住时宿主内存不增长，恢复后延迟立刻回落 |
| 2.2 | 客户端队列压到 1–2 帧 | 滚动跟手明显改善 |
| 2.3 | `maxSize` 按面板 DPR 自适应 + 高清重采样 | 手机画面里的字明显变清楚，且带宽下降 |
| 2.4 | **"平台糊"与"插件糊"分离测量** | 跳过了字体修复，但必须留基线，否则日后无法判断 2.3 是否有效。做法：同一块屏截图，比对侧栏文字与手机画面文字的边缘像素；并在侧栏里放一段固定字号文字做对照 |

### 阶段 3：可移植性（可提前，不依赖控制通道）

| # | 动作 | 验收 |
|---|---|---|
| 3.1 | `vendor/` 打包 adb 37.0.1 + scrcpy-server，查找顺序提到最前 | 在**没装过 QtScrcpy** 的机器上装插件即用 |
| 3.2 | 清掉所有硬编码用户路径 | `grep 30716` / `grep D:\Ruan` 全仓库为空 |

---

## 6. 已确认的默认值

| 项 | 决定 |
|---|---|
| 会话数 | **单会话**（用户拍板，推翻我原建议的双会话） |
| 中文注入 | 按 UTF-8 边界分段，每段 ≤300 字节，间隔 100ms |
| 控制不可用时 | 静默回落 `adb shell input`，返回值带 `via:'adb'` |
| adb 版本 | Android platform-tools **37.0.1** |
| 弹窗播放 | 不进这一版 |
| 字体发虚 | 跳过，仅留基线测量 |

---

## 7. 未决问题

1. **手机现在插着 USB 吗？** 阶段 0.2 必须真机验证，没有真机只能写代码不能证明它成立。
2. 跟随侧边栏的后果：**页签关了就没人能操作手机**（包括模型）。
   接受"模型发起动作时自动拉起会话"吗？
3. 接管入口放哪：侧栏里的"接管"按钮，还是键盘快捷键（抢占要快）？
