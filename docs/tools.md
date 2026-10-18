# 工具与接口

模型的 12 个 `phone_*` 工具，以及给外部脚本用的 HTTP 接口。

## 模型工具

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

**坐标一律 0~1 相对值**，宿主换算成视频像素（不是设备像素，原因见 [协议](protocol.md#坐标空间)）。

### 动作语义

| 动作 | 参数 | 说明 |
|---|---|---|
| `tap` | `at:[x,y]` 或 `nx`/`ny` | 单击 |
| `long_press` | `at`、`ms`（默认 600） | 按住 |
| `drag` | `from`、`to`、`ms`（默认 300） | 逐事件回放的真拖拽 |
| `scroll` | `pages`（正=往下）、`at` | 手指拖动型滚动 |
| `wheel` | `notches`（正=往下）、`at` | 滚轮事件，1 格 ≈ 0.08 屏 |
| `key` | `key`（`BACK`/`HOME`/`ENTER`/`APP_SWITCH`/`WAKEUP`…） | 按键 |
| `text` | `text` | 直接送文本（中文可用，≤300 字节自动分段） |
| `wait` | `ms` | 等待 |
| `launch` | `package` | 切到前台 |

## HTTP 接口

前缀 `/dsh-android-phone/api`：

```
GET  /status  /video  /snapshot
POST /session /owner /takeover /action /open /keyboard /inspect
     /shot /longshot /stream /settings /skills /clipboard /apps /close
```

常用几个：

| 接口 | 说明 |
|---|---|
| `GET /status` | 设备、会话、控制权、视频统计（侧栏每 5 秒轮询） |
| `GET /video?maxSize=&maxFps=&bitRate=` | 视频长连接，见下 |
| `GET /snapshot?scale=0.5` | 单帧 PNG（无 WebCodecs 时的降级路径） |
| `POST /action` | `{action, ...}`，支持 `human:true` 表示人发起（不受控制权限制） |
| `POST /open` | `{package, waitMs}` 切前台 |
| `POST /inspect` | 读控件树 |
| `POST /shot` | `{mode:'single'\|'long', name, maxSteps}` |
| `POST /takeover` | `{owner:'ai'\|'human'}` |
| `POST /settings` | `{action:'get'\|'cleanup'\|'reveal'}` 或直接保存 `{shotsDir, cleanup, apps, launchPkg}` |

### `GET /video` 的帧格式

`Content-Type: application/octet-stream` 长连接，响应头带 `X-Video-Width` / `X-Video-Height` / `X-Scrcpy-Version`。

每帧：

```
4B 长度（大端，不含这 13 字节头）
1B flag（1 = config/SPS+PPS，2 = 关键帧，0 = 普通帧）
8B pts（大端，微秒）
Annex-B 负载
```
