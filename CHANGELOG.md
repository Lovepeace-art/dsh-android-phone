# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.0 — 2026-10-18

首个公开版本。

### 能力

- **侧栏实时画面**：`scrcpy-server` + 浏览器 WebCodecs 硬解 H.264，`adb reverse` 隧道，起会话约 1.5s
- **控制通道**：直接注入 `INJECT_TOUCH_EVENT` / `INJECT_KEYCODE` / `INJECT_TEXT` / `INJECT_SCROLL_EVENT`，点按、滑动、长按、拖拽、滚轮、中文输入全部可用，宿主侧耗时 0~1ms
- **双指缩放**：每根手指独立 DOWN/UP，相册类应用实测 400px → 600px（×1.5）
- **截屏 / 长截图**：逐帧采集 + 行剖面运动估计 + 增量拼接，实测 1080×5147 无缝无重复
- **12 个模型工具**：`phone_status` `phone_apps` `phone_open` `phone_screenshot` `phone_longshot` `phone_inspect` `phone_action` `phone_keyboard` `phone_clipboard` `phone_stream` `phone_preset` `phone_takeover`
- **京东 skill**：`skills/jd-mall-capture`，搜索关键字 → 店铺 tab → 进店 → 店铺首页长截图
- **控制权模型**：AI 优先，人可一键强抢，静默 90s 自动交还

### 修复（相对 0.x）

- 单会话承载 video + control 两个 socket，起流从 9.8s 降到 1.5s
- `adb forward` 路径会 2~4 秒静默停流 → 改 `adb reverse` + `tunnel_forward=false`
- 服务端 `CleanUp` 子进程会删掉推上去的 jar → 传 `cleanup=false`
- 坐标必须使用**视频尺寸**而非设备像素（`PositionMapper` 严格校验，不等则静默丢弃）
- 指针 DOWN/UP 每根手指都要发，修双指缩放失效
- 视频流正常结束也要重连，修「画面冻在最后一帧」
- 侧栏 UI 适配浅色/深色主题，字号随面板宽度自适应

### 测试

- `npm test`：离线回归（`test-stitch` 35 项 + `test-client` 66 项），不需要真机；CI 跑的就是这套
- `npm run test:device`：真机回归（`test-plugin-tools` 工具与协议编码、`test-session` 单会话长跑、`test-host` HTTP 接口、`test-e2e-jd` 京东全链路）
- GitHub Actions：ubuntu + windows × node 20/22，push / PR 自动跑

### 已知限制

- 仅 Windows（`install.ps1` 与随包的 `adb.exe`）
- 中文输入依赖手机自带输入法（插件只负责把按键送进手机）
- 静止画面出帧率低：scrcpy 虚拟显示只在内容变化时出帧，静止页面 5~6fps 属正常
- 长截图对无限流 / 懒加载 / 倒计时页面可能出现少量错位
- 部分机型 `input swipe` 会触发系统手势（控制通道路径不受影响）
