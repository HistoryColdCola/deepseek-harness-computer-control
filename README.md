# dsh-computer-control

[English](README.en.md) | 中文

给 DSH 里的 agent 装上"手"：看屏幕、动鼠标、敲键盘、开关软件、操作浏览器、发消息。
**macOS 和 Windows 同一套工具**，纯 host 侧插件，**零第三方依赖** —— 只用 Node 内置模块 + 系统自带能力 + 一个自己编译的原生助手。

> **安全边界**：默认只允许"逛 + 加购物车"，**不允许进结算、不允许付款**。策略硬编码在插件里，agent 无法通过任何工具调用解除，只有人手动改配置文件才能放开。详见 [docs/SAFETY.md](docs/SAFETY.md)。

---

## 快速开始

```sh
# macOS
sh scripts/install-local.sh                 # 默认装进 desktop profile

# Windows（PowerShell）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1
```

脚本会：复制插件到 profile 的 `plugins/computer-control/`、编译原生助手、往 `cordis.patch.yml` 追加加载配置（改前自动备份，并顺带打开 HMR 监听，之后改代码不用重启）。

装完**重启 DeepSeek Harness**（或等 HMR 生效），会话里就会出现 9 个 `computer_*` 工具。

### macOS 需要授权（一次）

```sh
~/.dsh/profiles/desktop/plugins/computer-control/bin/dsh-input request   # 触发系统弹窗
```

系统设置 ▸ 隐私与安全性 里给 **DeepSeek Harness** 勾上：

| 权限 | 用途 | 缺失后果 |
|---|---|---|
| 辅助功能 Accessibility | 鼠标、键盘、菜单 | 事件被丢弃，点什么都没反应 |
| 屏幕录制 Screen Recording | 截图 | 只截到壁纸 |
| 自动化 Automation | 控制其它 App | 首次弹窗，允许即可 |

改完辅助功能**不用重启**；屏幕录制若未生效再重启一次。

### Windows 不需要授权

唯一的硬限制是 **UIPI**：非提权进程无法向提权（管理员）窗口发送输入。要让 agent 驱动某个管理员权限的程序，DSH 也得用管理员身份运行。

### 验证

```sh
node scripts/selftest.mjs                        # 本机：静态 + 真实只读执行
CC_PLATFORM=win32 node scripts/selftest.mjs      # 在任意机器上静态校验 Windows 接线
```

或者直接问 agent：`computer_policy` action=`environment`。

---

## 九个工具

| 工具 | 能干什么 |
|---|---|
| `computer_screenshot` | 截全屏/指定显示器/区域/指定窗口，把图**贴进对话**让模型真看见 |
| `computer_mouse` | 移动、单击/双击/右键/中键、拖拽、滚轮、读回坐标 |
| `computer_keyboard` | 输入任意文字（中文/emoji 直插，不走输入法）、按单键、按组合键 |
| `computer_clipboard` | 读写剪贴板（强制 UTF-8，中文不乱码） |
| `computer_app` | 启动/激活/退出应用、列窗口（拿窗口 id）、开文件网址、点多级菜单 |
| `computer_message` | 微信/QQ/钉钉/飞书/Telegram/Slack/Messages/WhatsApp 发消息（**两段式**，先定位再发送） |
| `computer_browser` | Chrome/Edge/Brave/Arc/Safari：开网址、切标签、读页面、执行 JS |
| `computer_ui` | 脚本逃生舱：macOS 走 AppleScript，Windows 走 PowerShell |
| `computer_policy` | 查策略/权限/能力矩阵/屏幕参数；用一段文字试探守卫 |

完整参数、示例与跨平台差异见 **[docs/TOOLS.md](docs/TOOLS.md)**。

---

## 讲解文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构与实现原理（插件加载、工具注册、平台适配层、原生助手、截图贴图、两段式消息、守卫位置） |
| [docs/TOOLS.md](docs/TOOLS.md) | 9 个工具完整参考 + 常用套路 |
| [docs/PLATFORMS.md](docs/PLATFORMS.md) | macOS / Windows 逐项对照：实现机制、权限、能力矩阵、各自的坑 |
| [docs/SAFETY.md](docs/SAFETY.md) | 购物守卫拦什么、为什么、边界在哪 |
| [docs/USAGE.md](docs/USAGE.md) | 使用教程：8 个实操场景 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 故障排查手册 |

---

## 跨平台能力对照（摘要）

| 能力 | macOS | Windows |
|---|---|---|
| 截屏 / 鼠标 / 键盘 / 剪贴板 / 窗口 / 应用启停 | ✅ | ✅ |
| 菜单读取与点击 | ✅ AppleScript | ❌ 无对应能力（动作会从工具枚举里摘掉） |
| 隐藏应用 | ✅ | ❌ |
| 浏览器标签列表 | ✅ 全部 | ⚠️ 仅当前标签（无 CDP 时） |
| 浏览器执行 JS | ✅ 需开发者菜单开关 | ❌ 需 DevTools Protocol |
| 聊天软件发消息 | ✅ 已实测微信 | ⚠️ 同一套逻辑，未实机验证 |
| 脚本逃生舱 | ✅ AppleScript | ✅ PowerShell |

细节见 [docs/PLATFORMS.md](docs/PLATFORMS.md)。

---

## 配置

`~/.dsh/computer-control/config.json`（首次挂载自动生成，改完立即生效，无需重启）：

```json
{
  "allowCheckout": false,
  "allowPayment": false,
  "maxScreenshotEdge": 1600,
  "typeChunkDelayMs": 9,
  "defaultWaitMs": 700,
  "extraBlockedPatterns": [],
  "messageApps": {
    "WeChat": { "searchChord": "cmd+f", "sendKey": "return", "settleMs": 900 }
  }
}
```

- `allowCheckout` / `allowPayment`：**只有人能改**，agent 无权修改。
- `maxScreenshotEdge`：贴给模型的预览图最长边（原图始终全尺寸留在 `shots/`）。
- `typeChunkDelayMs`：逐字符输入的字间毫秒数，慢应用可以调大。
- `messageApps`：按应用覆盖发消息流程（搜索快捷键 / 发送键 / 等待时间）。

Windows 上把 `messageApps` 里的 `cmd+f` 换成 `ctrl+f`。

运行状态目录：`~/.dsh/computer-control/`（`config.json`、`shots/`、`mounted.json`）。

---

## 目录结构

```
dsh-computer-control/
├── lib/
│   ├── index.js            插件入口：选平台、注册工具
│   ├── tools.js            9 个工具（平台无关）
│   ├── message.js          两段式发消息（平台无关）
│   ├── policy.js           购物守卫（纯函数）
│   ├── runtime.js          配置 / 子进程 / UTF-8 环境
│   └── platform/
│       ├── index.js        适配器接口 + 平台选择
│       ├── darwin.js       macOS：dsh-input(Swift) + osascript
│       └── win32.js        Windows：dsh-input.exe(C#) + PowerShell
├── native/
│   ├── DshInput.swift      macOS 原生助手
│   └── DshInput.cs         Windows 原生助手
├── scripts/                构建 / 安装 / 卸载 / 自检（.sh 与 .ps1 各一套）
├── docs/                   讲解文档
└── cordis.patch.yml        作为 bundle 安装时用的 patch
```

---

## 验证状态（诚实说明）

| 项目 | 状态 |
|---|---|
| macOS 全部功能 | ✅ 实机验证（截屏/鼠标/键盘/剪贴板/窗口/菜单/浏览器/微信真实发送/守卫拦截） |
| macOS 自检 | ✅ `node scripts/selftest.mjs` → **150/150** |
| Windows 接线（适配器、工具 schema、能力位、动作枚举、守卫） | ✅ 静态验证 `CC_PLATFORM=win32 node scripts/selftest.mjs` → **113/113** |
| Windows C# 助手与真实输入 | ⚠️ **未在 Windows 上编译/运行过**；按 C# 5 + .NET Framework 4.x 语法编写并经多轮人工复查 |

第一次在 Windows 上使用，建议依次验证：`build-helper.ps1` → `check` 输出 JSON → `node scripts\selftest.mjs` → agent 依次试 `computer_policy environment`、`computer_screenshot`、`computer_mouse position`。

---

## 实机踩过并修掉的坑

1. **输入长文本只出一个 "a"**：`CGEventKeyboardSetUnicodeString` 单事件载荷很小，超了会退化成虚拟键码 0。→ 逐字符注入（代理对一起发）。
2. **组合键无效**：只设 `CGEvent.flags` 部分应用（Chrome）不认。→ 真实按下/释放修饰键。
3. **剪贴板中文乱码**：无 `LANG` 时 `pbpaste`/`pbcopy` 走 MacRoman。→ 所有子进程强制 `LC_CTYPE=en_US.UTF-8`。
4. **浏览器标签列表全是 `undefined`**：AppleScript 里 `tab` 是**类名**不是制表符。→ 改用 `character id 9`。
5. **菜单子项拿不到**：顶层是 `menu bar item`，且只有目标应用在前台才能枚举。→ 强制置前 + 多级路径 + 重试。
6. **微信搜索回车发错人**：回车打开的是"搜一搜"，方向键选的是网络结果。→ `computer_message` 改成两段式，选行交给看截图的模型。
7. **浏览器没开窗口时报 `-1719`**：→ 返回空列表并提示先 `action=open`。

---

## 卸载

```sh
sh scripts/uninstall-local.sh [profile]        # macOS
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-local.ps1   # Windows
```

会移除插件目录并清掉加载配置行（自动备份原文件）。

## 许可

[MIT](LICENSE)
