# 排障

## 先跑自检

```powershell
npm run doctor
```

10 项只读检查：Node 版本、平台、`vendor` 里的 adb 与 scrcpy-server、adb 是否可用及其版本、设备是否在线、分辨率与密度、截图目录是否可写、profile 里的 junction 指向、bundle 是否注册、skill 根是否并入。哪项 ❌ 就照着修。

## adb 查找顺序

`vendor/platform-tools/adb.exe` 已随包，一般不用管。真要换：

插件 config `adbPath` → `DSH_ADB` 环境变量 → `<插件>/vendor/platform-tools/` → `<cwd>/vendor/platform-tools/` → `%LOCALAPPDATA%\Android\Sdk\platform-tools\` → QtScrcpy 目录（版本号降序）→ Program Files → PATH

## 常见问题

| 现象 | 处理 |
|---|---|
| 侧栏「未发现设备」 | ①手机解锁 ②USB 调试已授权 ③换根线/换个 USB 口 ④手动跑 `<插件>\vendor\platform-tools\adb.exe devices` 看状态是不是 `unauthorized` |
| `adb devices` 里是 `unauthorized` | 手机上会有授权弹窗，勾「一律允许」；没弹就 `adb kill-server` 后重插。仍不行：手机「开发者选项 → 撤销 USB 调试授权」再插 |
| adb 起不来，报 `cannot open %TEMP%\adb.log: Permission denied` | 把 `TEMP`/`TMP` 指到可写目录再 `adb start-server` |
| 画面黑屏、没有 fps | 看状态行：`未起流` → 点「起流」；有 fps 但不动 → 静止页面本来只有 5~6fps |
| 画面停在最后一帧、fps 仍显示 | 流断了但没重连。硬刷新侧栏（Ctrl+Shift+R）。连续 8 次重连失败会自动降级成快照模式 |
| 点了没反应，但 `adb shell input tap` 有效 | 控制权在人手上（顶栏「✋ 人在操作」）→ 点「↩ 交还模型」；或坐标空间不对（见 [协议](protocol.md#坐标空间)） |
| 输不进去中文 | 走 `adb` 的命令行输入只支持 ASCII；用控制通道的 `INJECT_TEXT`（`phone_keyboard` 默认走这条，≤300 字节自动分段） |
| 键盘按键没反应 | 先点一下画面让面板获得焦点；若焦点在面板自己的输入框里，按键会留给输入框不送手机 |
| 打开 App 下拉里没有想用的 | 下拉只列设置里保存过的候选，去 `⚙ 设置 → ④ 打开 App → 从手机添加` |
| 长截图重复 / 接缝 | 吸顶、懒加载、倒计时动画会少量错位。先滚到页面顶部再触发；页面有无限流时容易在底部反复 |
| 安装脚本报一堆假的 `Missing closing '}'` | `install.ps1` 的 UTF-8 BOM 丢了（被编辑器/工具覆盖）。`git checkout -- scripts/install.ps1` 还原 |
| 改完代码没生效 | 改 `client.js` 要 Ctrl+Shift+R；改 `index.js`/`src/**` 要重启 DSH。见 [CONTRIBUTING](../CONTRIBUTING.md#改哪里怎么生效) |
| 侧栏没有「📱 手机」tab | 没装 `dsh-better-sidebar`。此时没有面板，但设置项在 DSH「插件」页里，模型工具照常可用 |
| 重启 DSH 后插件不见了 | profile 的 junction 失效（挪了仓库目录 / 删了 `node_modules`）→ 重跑 `npm run install:profile` |

## 收集诊断信息

报 Issue 时贴这几样，能省掉至少一轮来回：

1. `npm run doctor` 的完整输出
2. 手机型号 + Android 版本 + 分辨率（`adb shell wm size` / `wm density`）
3. 侧栏底栏状态行：`画面 N fps` · `M Mbps` · `编码 W×H` · `前台 <包名>`
4. `adb devices -l` 的输出
5. 相关操作的先后顺序与期望结果

## 清残留

会话异常中断有时会在设备上留下映射或残留进程：

```powershell
$adb = '<插件>\vendor\platform-tools\adb.exe'
& $adb reverse --list            # 看有没有 localabstract:scrcpy_*
& $adb reverse --remove-all      # 会连别的映射一起删，确认后再用
& $adb shell "ps -A | grep app_process"   # 残留的 scrcpy-server
```

插件自己每次起会话前都会扫一遍 `scrcpy_*` 的残留映射；正常情况下不需要手动清。
