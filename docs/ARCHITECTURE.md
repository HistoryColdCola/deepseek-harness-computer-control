# 架构与实现原理

本文解释这套插件从"被 DSH 加载"到"真的点了一下鼠标"之间的每一步。看完你应该能自己改代码或加一个新工具。

---

## 1. 它是怎么被加载的

DSH 的插件系统基于 cordis：一个 profile（配置档案）由若干 **bundle** 组成，每个 bundle 提供一份 `cordis.patch.yml`，最终合并成一棵 **entry tree**，树上的每个 entry 就是一次 `import()` + `apply(ctx)`。

安装脚本往 profile 的 `cordis.patch.yml` 追加了一段：

```yaml
- insert:
    - id: computer-control
      name: './plugins/computer-control/lib/index.js'
```

含义：在根树上插入一个 id 为 `computer-control` 的条目，模块路径相对 profile 目录。loader 看到以 `.` 开头的名字，会用 `new URL(name, baseUrl)` 解析成 file URL 再 `import()`。

于是 `lib/index.js` 的 `apply(ctx)` 被调用。它做三件事：

```js
export const name = 'computer-control';
export const inject = ['tools'];          // 依赖 tools 服务，没它就拒绝启动

export function apply(ctx, config = {}) {
  const adapter = selectAdapter();          // 按 process.platform 选平台适配器
  const tools = buildTools(ctx, adapter);   // 造出 9 个工具定义
  for (const tool of tools) ctx.tools.register(tool);
  // 再往 ~/.dsh/computer-control/mounted.json 写一条加载记录（便于排查）
}
```

`inject: ['tools']` 是 cordis 的依赖声明：`tools` 服务就绪后才执行 `apply`。`ctx.tools.register(definition)` 把工具注册进当前 profile 的**全局工具表**，于是该 profile 下所有 agent 都能看到它们。

> 注册是幂等的"层"式操作：`register()` 返回一个 disposer，插件被卸载时工具自动消失。HMR 重载插件时不会残留旧工具。

### 热更新（HMR）

安装脚本还会把插件目录加进 HMR 监听：

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root: ['./plugins']
```

好处：改 `lib/*.js` 后不需要重启 App。注意 `root` 是相对 profile 目录的路径；监听有约 2 秒的写入稳定窗口（chokidar 的 `awaitWriteFinish`），所以"保存 → 生效"会有几秒延迟。改 `config.json` 不需要重载，因为它每次调用都重新读取。

---

## 2. 工具定义长什么样

DSH 的工具定义是普通对象（`defineTool()` 的产物形态）。本插件**不 import `@deepseek-ai/dsh-tools`**，因为插件是从 profile 目录加载的，依赖解析路径不可控；手写同形状对象即可，零依赖。

```js
{
  name: 'computer_mouse',
  description: '...模型看到的说明...',
  parameters: { type:'object', properties:{...}, required:[...] },   // 原生 JSON Schema
  output: {
    schema: { ... },                       // 返回值的 schema，被执行层校验
    render(args, value) {                  // 返回值 → 展示内容块
      return [{ type:'text', text:'...' }];
    },
  },
  async execute(args, exec) { ... },       // exec.signal 是取消信号
}
```

几个关键约束（都是实测踩出来的）：

1. **`parameters` / `output.schema` 必须是 harness 支持的 JSON Schema 子集**：标量 `type`、`properties`/`required`/`additionalProperties`、数组 `items`、标量 `enum`/`const`、精确一个 `oneOf`。写别的会在注册或返回时被拒。
2. **返回值会被逐字段校验，并且被冻结**（`deepFreeze`）。所以返回值必须**完全匹配** `output.schema`（`additionalProperties: false` 时多一个键就报错），并且 `render` 里不能修改 `value`，要新建对象（例如贴图时 `{ ...value.image.attachment }`）。
3. **`render` 返回内容块数组**。文本块是 `{type:'text', text}`；图片块是 `{type:'image', attachment:{...}}`，其中 `attachment` 必须来自 harness 的附件服务。

---

## 3. 截图是怎么"贴进对话"的

模型要"看见"屏幕，光给路径没用（那是另一轮工具调用）。做法是走 harness 的附件服务：

```
adapter.screen.capture()      截图并落盘 PNG（另存一份缩略图）
      │
      ▼
ctx.get('attachments')        取附件服务
      │  saveImage({ data, mediaType:'image/png', name })
      ▼
{ type:'image', attachment:{ attachmentId, mediaType, bytes, width, height } }
      │
      ▼
render() 返回 [文本块, 图片块]   ← 模型这一轮就看到了屏幕
```

`ctx.get('attachments')` 是可选依赖：拿不到就退化成"只返回路径 + 提示"，不会让工具失败。

为什么还要"缩略图"？5K 截屏原图 9MB 左右，直接塞进上下文会浪费大量 token。所以：

- 原图完整尺寸永远留在 `~/.dsh/computer-control/shots/`（可回溯、可再分析）；
- 贴给模型的是 `maxScreenshotEdge`（默认 1600）限制下的缩放版；
- 截图结果里会写明 **scale** 和原图尺寸，模型按 `image_pixel / scale` 换算成点击坐标。

---

## 4. 平台适配层

这是"macOS 和 Windows 都要做"的核心设计。工具层完全不碰系统 API，只依赖一个接口：

```
lib/platform/index.js     selectAdapter(platform) → adapter
lib/platform/darwin.js    macOS 实现
lib/platform/win32.js     Windows 实现
```

接口（完整定义见 `lib/platform/index.js` 顶部注释）：

| 成员 | 作用 |
|---|---|
| `input.*` | `position / move / click / drag / scroll / type / key / chord`，统一返回落点坐标 |
| `screen.*` | `check`（权限+屏幕）、`screens`、`capture`（截图）、`windows`（窗口枚举） |
| `clipboard.*` | `read` / `write` |
| `apps.*` | `resolve / activate / quit / list / frontmost / windows / openTarget`，macOS 额外有 `hide / menu / menuItems` |
| `script.*` | `{ language, run() }`：macOS 是 AppleScript，Windows 是 PowerShell |
| `browser.*` | `open / listTabs / activeTab / activateTab / closeTab / runJavaScript / readTextViaClipboard` |
| `permissions.*` | `status()` / `request()` |
| `notify()` | 系统通知 |
| `messageApps` | 聊天软件别名与流程预设 |
| `capabilities` | 能力位：`menu / menuItems / hide / notify / browserTabs / browserJs / scriptLanguage` |

**能力位驱动 UI**：`lib/tools.js` 在注册时就根据 `capabilities` 决定工具的参数枚举。例如 Windows 没有可脚本化的菜单栏，那么 `computer_app` 的 `action` 枚举里就**不会出现** `menu`，模型看不到、也就不会去调一个必然失败的动作。这是"把平台差异消解在注册期"而不是"运行时抛错"的做法。

两个平台各有一个**编译出来的原生助手**，因为纯脚本层做不好这件事：

| | macOS | Windows |
|---|---|---|
| 助手源码 | `native/DshInput.swift` | `native/DshInput.cs` |
| 编译 | `swiftc`（Xcode CLT 自带） | `csc.exe`（.NET Framework 自带） |
| 产物 | `bin/dsh-input` | `bin/dsh-input.exe` |
| 负责 | 鼠标/键盘事件、窗口枚举、屏幕信息 | 同上 + 截图 + 剪贴板 + 窗口激活/关闭 + 通知 |
| 脚本层 | `osascript`：激活 App、菜单、浏览器 AppleScript | PowerShell：逃生舱脚本 |

助手用**同一套命令行契约**（`check / screens / windows / pos / move / click / drag / scroll / type / key / chord / ...`，成功输出一行 JSON），所以 Node 侧两个适配器的调用代码几乎一样。

为什么要编译而不是每次跑 PowerShell 的 `Add-Type`？`Add-Type` 每次调用都要在内存里编译一遍 C#，单次开销 1–3 秒，一次"点击"就要等三秒不可接受。编译成 exe 后单次调用是毫秒级。

---

## 5. 输入事件是怎么发的

### macOS

`CGEvent` 直接投递到 HID 事件流：

- 鼠标：`CGEventCreateMouseEvent` + `CGEventPost(kCGHIDEventTap)`；
- 文本：`CGEventKeyboardSetUnicodeString`，**一个字符一个事件**（见下）；
- 组合键：**真实按下修饰键 → 敲主键 → 释放修饰键**（见下）。

两个必须知道的坑（都已在代码里解决）：

1. **一次塞多个字符会退化成 "a"**：`CGEventKeyboardSetUnicodeString` 的单事件载荷很小，超了会被系统丢弃，而虚拟键码是 0，于是只打出一个 "a"。现在逐字符发送（代理对一起发），字间延迟可配（`typeChunkDelayMs`）。
2. **只设 `CGEvent.flags` 的组合键在部分 App 里无效**（Chrome 就是）：必须真的把修饰键按下去再松开。

### Windows

`SendInput` + `INPUT` 结构：

- 鼠标：`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`，坐标按虚拟桌面归一化到 0–65535；
- 文本：`KEYEVENTF_UNICODE`，每字符 down+up 两个事件，最多 64 字符打包成一次 `SendInput`；
- 组合键：`VK_LSHIFT/VK_LCONTROL/VK_LMENU/VK_LWIN` 按下 → 主键 → 逆序释放。

坐标系与 macOS 一致：原点在主显示器左上角，副屏可能为负坐标。任务开始时先 `SetProcessDPIAware()`，全程用物理像素，避免 150% 缩放下的坐标错位。

---

## 6. 消息为什么是两段式

最初的设计是"搜索联系人 → 回车 → 粘贴 → 回车"的一把梭。实测时发现：

- 微信 macOS 版搜索框里**回车打开的是"搜一搜"网页搜索**；
- **方向键选中的是"搜索网络结果"分组**，不是联系人；
- 结果就是：消息被粘进了当时打开的那个聊天窗口——**差点发给一个真人**。

所以改成两段，把"选哪一行"交给能看截图的模型：

```
阶段一（不传 result_point）
  activate(app) → 打开搜索 → 粘贴联系人名 → 截图返回
  → 不发送、不粘贴消息体、返回 needsResult: true

阶段二（传 result_point）
  点击该坐标打开正确会话 → 粘贴消息 → 按发送键 → 再截图返回
```

这套逻辑在 `lib/message.js`，平台无关；两个平台只是搜索快捷键不同（`cmd+f` / `ctrl+f`）。

---

## 7. 购物守卫插在哪

`lib/policy.js` 是一个纯函数模块，被**所有会产生副作用的动作**在执行前调用：

```
输入文字 / 写剪贴板 / AppleScript / PowerShell / 浏览器 JS
打开的 URL / 菜单项名 / 消息正文 / 联系人名
        │
        ▼
   assertAllowed(config, { kind, value, what })
        │  命中禁词或 URL 模式
        ▼
     抛错（模型收到明确拒绝 + 指引）
```

守卫**不读对话、不看上下文**，只做词表 + URL 正则匹配，因此可预测、可测试。默认 `allowCheckout=false, allowPayment=false`，而这两个开关**只能由人改配置文件**——没有任何工具可以写 `config.json`，模型也无权调用"更改策略"。详见 [SAFETY.md](SAFETY.md)。

---

## 8. 自检脚本做了什么

`scripts/selftest.mjs` 有三种运行模式，是本项目唯一的自动化验证手段：

```sh
node scripts/selftest.mjs                        # 本机：静态 + 真实执行（只读操作）
CC_SELFTEST_OFFLINE=1 node scripts/selftest.mjs  # 只静态（CI / 无桌面）
CC_PLATFORM=win32 node scripts/selftest.mjs      # 在任意机器上静态校验 Windows 那套接线
```

`CC_PLATFORM=win32` 是关键：Windows 的适配器是纯 JS 构造（构造期不碰系统调用），所以可以在 macOS 上把它造出来，验证

- 9 个工具都能注册、schema 都在 harness 支持子集内；
- 适配器成员齐全、能力位与实现一致（例如 `capabilities.menu === false` 时 `apps.menu` 必须不存在、工具枚举里必须没有 `menu`）；
- 购物守卫该拦的拦、该放的放。

它**不能**验证 Windows 侧的 C# 助手与真实输入行为——那需要一台 Windows。这一点在 [PLATFORMS.md](PLATFORMS.md) 里明确标注。

---

## 9. 目录结构与职责

```
lib/index.js            插件入口：选平台、注册工具、写加载记录
lib/tools.js            9 个工具：schema / 执行 / 渲染（平台无关）
lib/message.js          两段式发消息流程（平台无关）
lib/policy.js           购物守卫（纯函数）
lib/runtime.js          配置读写、子进程封装、UTF-8 环境
lib/platform/index.js   适配器接口定义 + 平台选择
lib/platform/darwin.js  macOS：dsh-input(Swift) + osascript
lib/platform/win32.js   Windows：dsh-input.exe(C#) + PowerShell
native/DshInput.swift   macOS 原生助手源码
native/DshInput.cs      Windows 原生助手源码
scripts/*              构建 / 安装 / 卸载 / 自检
```

## 10. 想扩展的话

- **加一个工具**：在 `lib/tools.js` 里加一个对象，返回 `{name, description, parameters, output, execute}`；若需要系统能力，先在平台适配器接口里加成员，再在 `darwin.js`/`win32.js` 各实现一份。
- **换一个平台**（例如 Linux）：实现 `lib/platform/linux.js`（X11/AT-SPI），在 `platform/index.js` 注册，然后在 `scripts/selftest.mjs` 的 `SUPPORTED` 断言里放行。工具层不用动。
- **加聊天软件**：在适配器的 `MESSAGE_PRESETS` 里加一条（搜索快捷键、发送键、等待时间），必要时用 `config.json` 的 `messageApps` 覆盖。
