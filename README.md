# dsh-android-phone

**把安卓真机搬进 DeepSeek Harness 的侧栏**

## 能力

- 安装dsh-better-sidebar后**实时显示手机画面，不安装也可ai操作手机**
- **亚毫秒控制**：支持点按、长按、拖拽、滚轮、双指缩放、PC键盘直通
- 支持**截屏 / 长截图**
- 同一套能力作为工具交给模型 ——「AI 自动操作手机」和「用户手机画面展示」共用**同一条链路、同一个会话**
- （尚在构思中）agent自动操作手机，打通IM-PC-PHONE工作流

## 文档

| 文档 | 内容 |
|---|---|
| [使用说明](docs/usage.md) | 侧栏手势、清晰度、设置页、打开 App、会话与控制权、附带 skill |
| [工具与接口](docs/tools.md) | 12 个 `phone_*` 工具、动作语义、18 个 HTTP 接口 |
| [工作原理](docs/protocol.md) | 三条链路、坐标空间、五条关键设计、性能数字 |
| [排障](docs/troubleshooting.md) | 自检、adb 查找顺序、常见问题、清残留 |

## 环境要求

| 需要            | 说明                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------- |
| Windows 10/11 | 当前仅支持windows                                                              |
| DSH           | desktop profile，`>= 0.2.0-rc.2`                                                           |
| Node          | ≥ 20（插件运行时零 npm 依赖：adb 走命令行，PNG 编解码用自带 `src/core/png.js`）                                 |
| 安卓手机          | 「开发者选项 → USB 调试」打开，插 USB，弹窗点「一律允许」； USB 模式任选                                       |
| 可选            | `dsh-better-sidebar ^0.25.0` —— 只有「侧栏 tab」需要它；没装则没有侧栏实时手机页面，但**设置项在 DSH「插件」页里照样能用**，模型工具也照常可用 |


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

## 开发

开发约定（硬约定、常见陷阱、改完要检查什么）集中在 **[AGENTS.md](AGENTS.md)**；协作流程见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。

## 已知限制

- 仅 Windows
- 中文输入走控制通道直接送 UTF-8（≤300 字节自动分段）；只有 adb 兜底路径只支持 ASCII
- 静止画面出帧率低（5~6fps）：scrcpy 虚拟显示只在内容变化时出帧，属正常现象
- 长截图对无限流 / 懒加载 / 倒计时页面可能有少量错位
- 部分机型 `input swipe` 会触发系统手势（控制通道路径不受影响）

## 参与贡献

欢迎 Issue 与 PR。提 PR 前请跑一遍 `npm run ci`，并按 PR 模板填写测试情况（UI 改动附截图、协议层改动注明依据）。详细流程与代码约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本项目未使用 CLA：按 Apache-2.0 提交 PR 即视为同意以同一许可证授权你的贡献。

## 许可与致谢

本项目代码以 **Apache License 2.0** 授权，全文见 [LICENSE](LICENSE)，第三方组件声明见 [NOTICE](NOTICE)。

- [scrcpy](https://github.com/Genymobile/scrcpy)（Apache-2.0）—— `vendor/scrcpy-server` 原样分发；视频流协议与控制通道依据其公开源码独立实现
- [QtScrcpy](https://github.com/barry-ran/QtScrcpy)（Apache-2.0）—— 产品交互形态参考，未复制其代码
- [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)（Google）—— `vendor/platform-tools/` 原样分发，仅作运行依赖
- 长截图拼接思路参考 [SnowShot](https://github.com/mg-chao/snow-apps)（逐帧采集 + 运动估计 + 增量拼接 + 置信度拒帧），纯 JS 实现，不依赖 OpenCV
