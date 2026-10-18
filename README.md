<p align="center"><img src="assets/icon.png" width="120" height="120" alt="dsh-android-phone"></p>

<h1 align="center">dsh-android-phone</h1>

<p align="center"><b>把安卓真机搬进 DeepSeek Harness 的侧栏</b></p>

## 能力

- 安装 dsh-better-sidebar 后**实时显示手机画面，不安装也可 ai 操作手机**
- **亚毫秒控制**：支持点按、长按、拖拽、滚轮、双指缩放、PC 键盘直通
- 支持**截屏 / 长截图**
- 同一套能力作为工具交给模型 ——「AI 自动操作手机」和「用户手机画面展示」共用**同一条链路、同一个会话**
- （尚在构思中）agent 自动操作手机，打通 IM-PC-PHONE 工作流

## 环境要求

| 需要            | 说明                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------- |
| Windows 10/11 | 当前仅支持windows                                                              |
| DSH           | desktop profile，`>= 0.2.0-rc.2`                                                           |
| Node          | ≥ 20（插件运行时零 npm 依赖：adb 走命令行，PNG 编解码用自带 `src/core/png.js`）                                 |
| 安卓手机          | 「开发者选项 → USB 调试」打开，插 USB，弹窗点「一律允许」； USB 模式任选                                       |
| 可选            | `dsh-better-sidebar ^0.25.0` —— 只有「侧栏 tab」需要它；没装则没有侧栏实时手机页面，但**设置项在 DSH「插件」页里照样能用**，模型工具也照常可用 |

## 安装

把整个插件目录**复制**到本机任意位置，然后在目录里跑一次安装脚本。脚本以**复制**方式装进 DSH 的 profile（`~/.dsh/profiles/desktop/vendor/dsh-android-phone`）—— 不建指向源码目录的 junction，装完源码目录可以随便挪走或删掉：

```powershell
# 在插件目录下执行（先用 -WhatIfOnly 可以只预览将要改动的内容）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Copy
```

完整卸载（摘掉注册信息、依赖声明与附带 skill，不动你的手机和截图）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
```

装完**重启 DSH**：插件会出现在 DSH 的「插件」页（可在这里开关与配置）；装了 better-sidebar 时侧栏还会多出「手机」tab。

### 让 agent 帮你装

把下面这段整段发给模型即可：

> 在这台 Windows 机器上安装 DSH 插件 `dsh-android-phone`。插件目录是 `<把你解压/克隆出来的目录填这里>`。
> 请按顺序做三件事：①在该目录下执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Copy`；②执行 `npm run doctor` 确认自检全绿，有 ❌ 就按提示修（缺 adb、手机没连、profile 没注册）；③告诉我结论，以及需要「重启 DSH」还是「刷新侧栏」。不要修改仓库里的代码文件。

安装细节（脚本究竟改了哪些文件、为什么不能用 `dsh plugin add`、BOM 注意事项）见 [使用说明 · 安装与卸载](docs/usage.md#安装与卸载)。

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

## 文档

| 文档 | 内容 |
|---|---|
| [使用说明](docs/usage.md) | 安装与卸载细节、侧栏手势、清晰度、设置页、打开 App、会话与控制权、附带 skill |
| [工具与接口](docs/tools.md) | 12 个 `phone_*` 工具、动作语义、18 个 HTTP 接口 |
| [工作原理](docs/protocol.md) | 三条链路、坐标空间、五条关键设计、性能数字 |
| [排障](docs/troubleshooting.md) | 自检、adb 查找顺序、常见问题、清残留 |

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
