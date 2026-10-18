---
name: jd-shop-longshot
description: 用安卓真机打开京东 App，搜索关键字 → 切「店铺」tab → 进目标店铺 → 把店铺首页长截图成一张整页图。用于店铺首页/商品列表/搜索结果这类 App 内页面的截图取证。
whenToUse: 用户要京东 App（不是网页版）的店铺页面截图、店铺首页长截图、按关键字搜店铺再截图；或需要可复现、可复现落点的 App 内页面长图。手机没连、没开 USB 调试、DSH 里没装 dsh-android-phone 插件、或要的是网页版时不要用本 skill。
metadata:
  engine: dsh-android-phone
  platform: android-real-device
  api: http://127.0.0.1:<当前DSH端口>/dsh-android-phone/api
  verified: "2026-10-16 华为 nova 6 5G (WLZ-AN00, Android 12, 1080x2400@480dpi) · scrcpy 5.0.1"
---

# 京东「搜店铺 → 进店 → 店铺首页长截图」

能力全在插件 `dsh-android-phone` 里（scrcpy 控制通道 + 长截图拼接），本 skill 只提供**路径**。

## 两条用法

### A. 一键脚本（推荐）

脚本随插件一起安装；`<插件目录>` = skill 目录的上一级
（装好后是 `%USERPROFILE%\.dsh\profiles\desktop\vendor\dsh-android-phone`，源码树里就是 `dsh-android-phone`）。

```powershell
node <插件目录>\skills\jd-shop-longshot\scripts\jd-shop-longshot.mjs --keyword 牛奶 --shop 每日鲜语
```

它自己完成：起会话 → 打开京东 → 关开屏广告落首页 → 点搜索框 → 输中文关键字 → 回车 →
切「店铺」tab → 选店铺进店 → 长截图 → 落盘 + JSON 报告。

常用参数：

| 参数 | 含义 |
|---|---|
| `--keyword <词>` | 搜索关键字（必填，**中文可以直接用**） |
| `--shop <名字片段>` | 要进的店铺名片段；默认取店铺列表第一个「旗舰店」 |
| `--out-dir <目录>` | 把长截图和报告复制过去（默认只留在插件截图目录） |
| `--base <URL>` | 插件 API 根地址（默认 `http://127.0.0.1:<当前DSH端口>/dsh-android-phone/api`，也认环境变量 `DSH_ANDROID_PHONE_API`） |
| `--max-steps <n>` | 长截图最多拼接步数，默认 8 |
| `--force` | 人在操作（`owner=human`）时也强行拿回控制权 |
| `--json` | 只输出一行 JSON（给程序吃） |
| `--keep-open` | 跑完不停会话 |

退出码：`0` 全流程通过 · `1` 拿到长截图但有步骤没通过 · `2` 参数错 · `3` 运行失败。

### B. 模型直接用插件工具（不用脚本）

模型侧工具（工具名以实际注册为准）：`phone_status` · `phone_open` · `phone_inspect` ·
`phone_action` · `phone_keyboard` · `phone_screenshot` · `phone_longshot` · `phone_stream` ·
`phone_preset` · `phone_takeover`。

顺序与判据就是下面「落点小抄」，**要点：所有写操作都应该是 `via: 'control'`**（走 scrcpy
控制通道，亚毫秒且支持中文）。若返回 `via: 'adb'`，说明控制通道没连上，中文会失败、点击慢 100 倍。

## 前提（缺一不可）

1. 手机 USB 连上、通知栏 **USB 调试** 已授权（华为建议同时选「传输文件」模式）
2. 屏幕已解锁（锁屏时截图是黑屏）
3. 京东 App 已安装且**已登录**——未登录时搜索会跳登录页，店铺页只有骨架
4. DSH 里已安装插件 `dsh-android-phone`（`scripts\install.ps1` 装完要重启 DSH），
   侧栏能看到手机画面；插件自带 `vendor/platform-tools/adb.exe`（37.0.1）与 `vendor/scrcpy-server`（5.0.1）
5. 控制权：`owner=ai` 时模型可以随便操作；侧栏点过「✋ 接管」之后 `owner=human`，
   模型的写操作会被拒绝（报 `手机控制权已被人工接管（owner=human）`）——要么让用户点「↩ 交还模型」，
   要么脚本加 `--force`。只读的 `phone_status` / `phone_inspect` 不受限。

## 落点小抄（真机实测，1080x2400，视频 808x1800）

> **京东首页的 uiautomator 树不能全信**（节点坐标常和画面对不上），但**搜索框那一个节点是准的**，直接用它，别猜 y。

| 步骤 | 落点 | 实测 |
|---|---|---|
| 开京东 | `phone_open {package:'com.jingdong.app.mall'}`（控制通道 `START_APP`） | 406~493ms；首次要等 ~6s 让首页起来 |
| 关开屏广告 | 落到 `ProductDetailActivity`（国补广告）就 `key BACK`，直到出现「关注/推荐/秒杀/京东超市」 | 一般 0~1 次 BACK |
| 点搜索框 | 首页 `text/desc` 含「搜索」且 `clickable=true` 的节点，中心 **979,317**（设备像素）→ `nx≈0.906 ny≈0.132` | 走控制通道**一次就进** `com.jd.lib.search.view.Activity.ProductListActivity` |
| 输关键字 | `phone_keyboard {text:'牛奶'}`（控制通道 `INJECT_TEXT`，中文直进） | 宿主 1~57ms，`chunks:1` |
| 提交 | `phone_action {action:'key', key:'ENTER'}` | 127ms，结果页文字含「牛奶」 |
| 切店铺 tab | 结果页节点文字形如 **`店铺,,未选中`**（可能在 `text` 或 `desc`，随版本/机型变） | 用 `/^店铺/` 或 `/店铺[,，]/` 匹配，**不要** `=== '店铺'`；节点约 (761,336) |
| 进店 | 店铺列表里含 `旗舰店`/`专营店`/`专卖店` 的节点（如「每日鲜语官方旗舰店」405,484） | 点击后进店铺首页 |
| 店铺首页长截图 | `phone_longshot {name:'…', maxSteps:6}` | **1080x5148**、3 帧接受（dy 1494/1505）、2 帧 `too-few-matched-rows` 正确收尾、16480ms |

- 搜索框里的 hint（「订鲜牛奶」/「鲜奶次日达」）是**京东自己在轮播**，不是输入内容，别拿它当证据；
  确认输入成功看 `phone_keyboard` 的返回和结果页文字。
- 长截图机制：逐帧 `screencap` → 行剖面估位移 → 只贴新增行；固定栏（顶/底导航）从控件树量出后永不贴；
  收尾自检重复块。超过 22000px 会自动切块成 `-pNN.png`。
- 视频/动画/直播区域可能被当固定栏遮掉或出现接缝；无限流/懒加载页面对不齐属于已知限制。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `没有可用设备（status.ready=false）` | 手机没连/没授权；或插件找不到 adb（`phone_status` 看 `adbPath` 是否为 null，可设 `DSH_ADB` 指向 adb.exe） |
| 所有动作 `via: 'adb'` | 控制通道没起来（会话没起或 scrcpy-server 版本不匹配）。先 `phone_status` 看 `session.control` |
| `手机控制权已被人工接管（owner=human）` | 用户点过「接管」：让用户点「↩ 交还模型」，或脚本 `--force`，或调 `phone_takeover {owner:'ai'}` |
| 点了没反应（没报错） | **坐标系错了**：scrcpy 控制通道的坐标必须是**视频尺寸**空间（不是设备像素），插件已按此换算；若自定义调用请用归一化 `nx/ny` |
| 中文输入失败 / 落到英文 | 没走控制通道（`via: 'adb'`），`adb shell input text` 只支持 ASCII |
| 找不到「搜索」节点 | 不在京东首页（先关广告/弹窗），或这一屏是懒加载骨架 → `phone_inspect` 看文字，必要时 `key BACK` 后退重来 |
| 找不到「店铺」tab | 匹配太严：节点文字带 `,,未选中` 后缀，改成正则匹配 |
| 长截图只有一屏 | 页面确实不可滚（骨架/空列表），或内容在内嵌滚动容器里 |
| 拿到的是登录页 | 先在手机上手工登录一次（登录态留在 App 里） |

## 备用：不依赖插件的老路径

`<插件目录>\skills\jd-shop-longshot\scripts\jd-capture.mjs` 是改造前的 CLI 执行器：自己调 `adb` 截图与拼接，
**不需要插件**，但每步输入走 `adb shell input`（慢、只支持 ASCII），且不能搜中文关键字。
只在插件没装/起不来时当兜底：

```powershell
node <插件目录>\skills\jd-shop-longshot\scripts\jd-capture.mjs --steps 8          # 当前页面长截图
node <插件目录>\skills\jd-shop-longshot\scripts\jd-capture.mjs --pre tab-mine,wait-3s --out-dir recon\shots
node <插件目录>\skills\jd-shop-longshot\scripts\jd-capture.mjs --no-launch --steps 5 --json
```

## 联调提示（开发用）

不重启 DSH 也能联调插件接口：`node <插件目录>\scripts\serve-api.mjs --port 19399`，
然后把 `--base` 指到 `http://127.0.0.1:19399/dsh-android-phone/api`。

## 自检（改完插件或换手机后先跑这个）

```powershell
node <插件目录>\scripts\serve-api.mjs --port 19399            # 另开一个窗口
node <插件目录>\skills\jd-shop-longshot\scripts\jd-shop-longshot.mjs --keyword 牛奶 --json
```

`pass/fail` 全过、`control: true`、长截图高度 > 2000 就算这套链路是好的。
