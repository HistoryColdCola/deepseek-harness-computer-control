# 低延迟控制 / Low-latency control

JS 负责工具、顺序、策略校验和附件；macOS 使用 Swift + ScreenCaptureKit/CoreGraphics，Windows 使用 C# + GDI+/SendInput。原生助手是常驻的 stdin/stdout 管道服务，不监听网络端口。空闲 30 秒后退出，下次重新启动。macOS 快速截图需要 **macOS 14+ 和 Xcode Command Line Tools 15+**；Windows 使用系统 .NET Framework 4.x 编译器。升级后必须重新运行安装脚本编译助手，并重启 DSH。

JS handles tools, sequencing, policy and attachments. Swift uses ScreenCaptureKit/CoreGraphics on macOS; C# uses GDI+/SendInput on Windows. A persistent private stdin/stdout pipe avoids per-action process startup. It exits after 30 seconds idle. Fast capture requires **macOS 14+ and Xcode Command Line Tools 15+**; Windows uses the built-in .NET Framework 4.x compiler. Reinstall to rebuild the helper, then restart DSH.

## 截图参数 / Capture settings

默认只保存和返回一张最长边 640、质量 25 的 JPEG。macOS 在捕获阶段缩小图像；Windows 在内存中缩小并编码。无需写全尺寸 PNG、启动 `sips`、重复查询权限。`max_edge:320, quality:15` 更模糊更小；文字看不清时用 1280 或局部截图。`max_edge:0, format:'png'` 才请求完整无损图。

By default, capture writes one 640-edge JPEG at quality 25. macOS scales during capture; Windows scales in memory before encoding. No full PNG intermediate, `sips` subprocess or separate permission probe is needed. Use 320/15 for a very blurry frame, 1280 or a region for small text, and `max_edge:0, format:'png'` for full lossless inspection.

新安装默认配置 / Defaults for a fresh installation:

```json
{
  "maxScreenshotEdge": 640,
  "screenshotQuality": 25,
  "screenshotFormat": "jpeg",
  "typeChunkDelayMs": 0,
  "defaultWaitMs": 80,
  "keepScreenshots": 200
}
```

已有 `~/.dsh/computer-control/config.json` 中显式设置的旧值会保留。要启用新默认值，请删除相应字段，或把值改成上面这样。无需删除整个配置；付款限制等配置继续生效。输入不稳定时把 `typeChunkDelayMs` 调高，界面加载慢时增加 `wait_ms`。

Existing explicit config values remain in effect. Remove those fields or update them to adopt the new defaults. Preserve other settings. Increase typing delay for apps that drop input, or `wait_ms` when an app needs more time to render.

## 快速闭环 / Fast loop

```js
computer_step({actions:[]}) // first observation
computer_step({
  actions:[
    {tool:'mouse', action:'click', x:420, y:300},
    {tool:'keyboard', action:'type', text:'你好 Hello 日本語 한국어 🙂'}
  ],
  wait_ms:0,
  max_edge:320,
  quality:15
})
```

每次最多 8 个已确定的动作，按顺序执行后返回一张新截图。只合并已经知道的动作；下一个目标依赖界面变化时先观察。批次先整体校验参数和文字策略，运行失败会报告已执行数量，不自动重试或重放点击。取消或超时会终止助手；已向系统投递的输入无法撤回。

A step runs up to 8 known actions in order and returns one fresh screenshot. Observe again when the next action depends on a changed UI. The entire batch is validated before execution. Errors report the completed count; clicks are never automatically replayed. Cancellation/timeouts kill the helper but cannot undo input already delivered to the OS.

建议给模型的提示 / Suggested model instruction:

> 优先使用 computer_step。每次只输出必要的下一步工具调用，不加操作前说明。先看截图，按 frame 换算坐标；目标不清楚时提高分辨率或局部截图。只合并确定的动作，不盲目猜测界面变化。
>
> Prefer computer_step. Output only the next necessary tool call without narration. Observe first, convert coordinates using frame, and request more detail when needed. Batch only known actions.

插件不掌握 DSH 的模型推理参数或 API 网络延迟，也不能让一个不支持视觉的模型看懂图片。请在 DSH 中选择支持图片且响应快的模型。减少输出说明和工具轮次有助于提速；高度模糊可能增加识别错误，需要实测权衡。

The plugin does not control DSH's inference parameters or API latency. Select a fast vision-capable model in DSH. Short outputs and fewer round trips help; excessively blurry images can cause retries.

## 坐标 / Coordinates

返回的 `width` / `height` 就是实际附件像素尺寸，`frame` 是截图覆盖的屏幕矩形。两种系统统一换算：

Returned width/height are the actual attached image dimensions. Frame is the captured rectangle in screen units (macOS points, Windows physical pixels):

```text
screenX = frame.x + imageX * frame.width / width
screenY = frame.y + imageY * frame.height / height
```

这同时处理缩图、Retina、区域和副屏偏移。不要额外再除 `scale`。macOS 区域必须完整位于单个显示器内，`display:1` 为主屏，其余按 display ID 排序。窗口列表缓存最长 2 秒；窗口截图会重新读取窗口列表以获取当前位置。

This includes scaling, Retina and crop/secondary-display offsets. Do not divide by scale again. macOS regions must fit within one display; display 1 is primary, remaining displays are ordered by ID. Display enumeration caches for up to 2 seconds; window capture refreshes window geometry.

## 实测 / Measurement

```sh
npm test
CC_PLATFORM=darwin CC_SELFTEST_OFFLINE=1 node scripts/selftest.mjs
CC_PLATFORM=win32 CC_SELFTEST_OFFLINE=1 node scripts/selftest.mjs
npm run benchmark -- --samples 30 --max-edge 320 --quality 15 --budget-ms 300
```

PowerShell 静态检查请用 `$env:CC_PLATFORM='win32'; $env:CC_SELFTEST_OFFLINE='1'; node scripts/selftest.mjs`。

基准必须在已授权的真实 macOS/Windows 桌面运行。它报告冷启动、热运行 p50/p95、字节数，以及 p95 是否达到指定预算，测量范围是原生截图 + 本地管道和文件写入。截图工具另有 `captureMs`、`attachmentMs`、`elapsedMs`；模型推理、远程网络不在基准内。**100–300ms 是截图目标，不是已经证明的承诺；完整控制回合还要加附件服务和模型耗时。**

Run the benchmark on an authorized real desktop. It reports cold startup, warm p50/p95, payload size and whether p95 meets your budget. It includes native capture, IPC and local writes. Tool results separately report captureMs, attachmentMs and elapsedMs. **100–300ms is a capture target, not a verified guarantee; full turns also include attachment service and model latency.**

Linux tests use a fixture worker and mocked platform input/capture to exercise ordering, Unicode, cancellation, crashes, policy, image metadata and coordinate mapping. They do not measure real native screenshot speed. CI builds both native helpers and checks their persistent protocol and real JPEG/PNG output when screen access is granted. Full UI behavior still needs on-device validation.

## CI 原生截图样本 / Native CI capture sample

[验证运行 / Validation run](https://github.com/HistoryColdCola/deepseek-harness-computer-control/actions/runs/39238442687)，代码提交 `4ea4cb8`。JS 11 项测试、两个原生构建、常驻协议及实际 JPEG/PNG 文件检查均通过。

| 320-edge JPEG, quality 15 | Windows runner | macOS 14 runner |
|---|---|---|
| First capture, helper already running | 129.8ms | 472.0ms |
| Next 4 captures, capture + local IPC | 14.4–28.5ms | 7.5–41.8ms |
| Encoded bytes | 7,589 | 3,104 |

截图包含本地文件写入；不含助手进程启动、附件上传、模型推理和网络。这只是构建机桌面的 5 帧检查，桌面内容简单、样本少，不能代表用户电脑上的 p95。请用上面的 30 次基准在本机测量。

Includes local file output; excludes helper process startup, attachment upload, inference and network. These are five smoke-test frames of simple CI desktops, not a statistically meaningful p95 result for user machines. Use the 30-sample benchmark on your own desktop.
