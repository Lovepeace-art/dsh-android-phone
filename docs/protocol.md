# 工作原理

读这篇之前先看 [README](../README.md#工作原理) 的那张链路图。这里写细节，尤其是**改代码前必须知道的约束**。

## 三条链路

**视频**：`startVideoStream()` → `adb reverse localabstract:scrcpy_<scid> tcp:<port>` → 手机上的 `scrcpy-server` 主动连回本机 TCP。

- 第 1 条连接 = **video**，第 2 条 = control（`audio=false` 时跳过 audio）
- 服务端**全部连接建完才发流头**，所以控制通道必须和视频同时连
- 流头 = `1B dummy + 64B 设备名 + 4B codecId + 4B flags + 4B 宽 + 4B 高`（reverse 模式没有 dummy 字节，少 1 字节）
- 之后每包 = `8B pts+flags + 4B size + Annex-B 负载`；`ptx` 高位是 flag 位（`1<<62` config、`1<<61` 关键帧）

**控制**：同一个会话的第 2 条 socket，发大端控制消息（`INJECT_TOUCH_EVENT` 32 字节、`INJECT_SCROLL_EVENT` 21 字节、`INJECT_KEYCODE` 14 字节、`INJECT_TEXT` 5+N）。服务端 `ControlMessageReader` 解析后注入 Android 输入系统。

**截图 / 长截图**：走 `screencap`（不占视频链路）；长截图是「滚动 → 取帧 → 行剖面估位移 → 只贴新增的行 → 收工自检重复块」。

## 坐标空间

服务端 `PositionMapper.map()` 会检查 `Position.screenSize` **是否严格等于编码尺寸**：

```java
if (!videoSize.equals(clientVideoSize)) {
    // 客户端发的坐标基于错误的尺寸，直接丢弃
    return null;
}
```

不等就 `return null` 丢弃，只在 VERBOSE 日志里说一句 —— 表现为「点的位置对、但手机毫无反应」。

所以坐标必须落在**视频尺寸**空间（比如编码输出 808×1800），不是设备像素（1080×2400）。用户在面板上点的是 0~1 相对位置，两条路径各自换算：

- 控制通道 → 乘以**视频尺寸**
- 兜底的 `adb shell input tap` → 乘以**设备像素**

## 五条关键设计（都是踩坑换来的）

1. **一个会话承载两个 socket** —— 服务端按 `video → audio → control` 顺序建连，全部建完才发流头。不能「先看画面、需要时再连控制」。
2. **走 `adb reverse` 而不是 `adb forward`** —— forward 路径实测 2~4 秒后静默停流：服务端自己 `destroyDisplay`、干净退出（exit 0），没有任何报错。换 reverse 后连跑 3 轮 20 秒稳定。
3. **必须传 `cleanup=false`** —— `scrcpy-server` 的 `CleanUp` 子进程启动第一件事就是 `unlinkSelf()` 删掉推上去的 jar；不关它，下次启动会 `Aborted`（exit 134）。
4. **坐标用视频尺寸** —— 见上一节。
5. **指针 DOWN/UP 每根手指都要发** —— `POINTER_DOWN/UP` 由服务端改写并补 `pointerIndex`；客户端自己发 5/6 会让 Android 判定「index 0 又按了一次」而整条丢弃。

## 性能数字（真机实测）

| 指标 | 数值 |
|---|---|
| 会话启动 | ~1.5s（旧实现 9.8s） |
| 控制注入（宿主侧写入） | 115µs ~ 1ms |
| `adb shell input tap` 对比 | ~91ms（**790×**） |
| 动作 → 画面可见 | 92 ~ 310ms（编码 + 传输 + 解码 + 上屏） |
| 滚轮 1 格 | 192 设备像素 ≈ 0.08 屏 |
| 长截图 1080×5147 | ~16.5s，3 帧 |

## 协议依据

控制消息与帧格式以 **scrcpy v5.0.1 源码**为准，关键文件：

`ControlMessageReader` · `ControlMessage` · `PositionMapper` · `Pointer` / `PointersState` · `Controller` · `ControlChannel` · `DeviceMessageWriter` · `Position` · `InputManager` · `Server` · `Options`

改协议层前先去读懂对应文件，不要凭记忆改字节布局。

## 为什么不用 WebCodecs 之外的东西

侧栏解码只用浏览器原生 `WebCodecs`（`VideoDecoder` + `avc: {format:'annexb'}`）。没有 `VideoDecoder` 的环境降级为每秒 2 张 `/snapshot` —— 能看，但卡。
