# macOS 与 Windows 对照

一套工具，两份平台实现。这份文档说明两边**分别是怎么做的、差在哪、各自要做什么准备**。

---

## 1. 总览

| | macOS | Windows |
|---|---|---|
| 原生助手 | `bin/dsh-input`（`native/DshInput.swift`） | `bin/dsh-input.exe`（`native/DshInput.cs`） |
| 编译方式 | `swiftc`（Xcode Command Line Tools 自带） | `csc.exe`（.NET Framework 自带，Windows 10/11 默认存在） |
| 输入事件 | CoreGraphics `CGEventPost` | Win32 `SendInput` |
| 截图 | `/usr/sbin/screencapture` + `sips` 缩放 | 助手内 GDI+ `CopyFromScreen` / `PrintWindow` |
| 剪贴板 | `pbpaste` / `pbcopy` | 助手内 Win32 剪贴板 API |
| 窗口枚举 | `CGWindowListCopyWindowInfo` | `EnumWindows` + DWM 判断是否被隐藏 |
| 激活/关闭应用 | `open -a` + `System Events` | 助手内 `SetForegroundWindow` / `WM_CLOSE` |
| 菜单操作 | ✅ AppleScript `System Events` | ❌ 无对应能力（能力位会在工具枚举里摘掉该动作） |
| 脚本逃生舱 | AppleScript（`osascript`） | PowerShell |
| 权限 | 辅助功能 + 屏幕录制 + 自动化 | 无需授权；但**不能跨权限级别发输入** |
| 标签页枚举 | ✅ 浏览器 AppleScript 字典 | ⚠️ 只能拿当前标签（窗口标题） |
| 页面 JS | ✅ 需开发者菜单开关 | ❌ 需 DevTools Protocol |

坐标系两边一致：**原点在主显示器左上角**，副屏可能为负坐标；单位是 macOS point / Windows 物理像素。但**换算规则不同**：

| | 截图像素 → 点击坐标 |
|---|---|
| macOS | 除以 `scale`（Retina 是 2） |
| Windows | 直接用，**不要**除（助手已声明 DPI-aware，像素即坐标） |

这条差异写在截图工具返回的 `note` 里，也写在工具说明里，属于"搞错了每次都点偏"的坑。

---

## 2. 安装

### macOS

```sh
sh scripts/install-local.sh            # 默认 desktop profile
sh scripts/install-local.sh <profile>
```

做三件事：复制到 `~/.dsh/profiles/<profile>/plugins/computer-control/`、用 `swiftc` 编译助手、往 `cordis.patch.yml` 追加 loader 配置（含 HMR 监听）并备份原文件。

### Windows

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1 -Profile web
```

同样三步：复制到 `%USERPROFILE%\.dsh\profiles\<profile>\plugins\computer-control\`、用 `csc.exe` 编译 `bin\dsh-input.exe`、追加配置行（**写文件时特意不带 BOM**，带 BOM 的 YAML 会被解析器拒绝）。

手动编译助手：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-helper.ps1
# 或直接：
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /platform:anycpu `
  /out:bin\dsh-input.exe native\DshInput.cs /reference:System.Windows.Forms.dll /reference:System.Drawing.dll
```

卸载：`scripts\uninstall-local.ps1`。

> 为什么 Windows 要编译 exe？也可以用 PowerShell 的 `Add-Type` 现场编译 C#，但那样每次调用都要编译一遍（1–3 秒），一次点击就卡三秒，体验不可接受。编译成 exe 后单次调用是毫秒级，和 macOS 的做法对齐。

---

## 3. 权限

### macOS（必须）

```sh
~/.dsh/profiles/desktop/plugins/computer-control/bin/dsh-input request   # 触发系统弹窗
```

| 权限 | 用途 | 缺失后果 |
|---|---|---|
| 辅助功能 Accessibility | 鼠标、键盘、菜单、UI 脚本 | 事件被系统直接丢弃 |
| 屏幕录制 Screen Recording | 截图 | 只截到壁纸 |
| 自动化 Automation | `osascript` 控制其它 App | 首次逐个弹窗，拒绝后报 -1743 |

系统设置 ▸ 隐私与安全性 里勾选 **DeepSeek Harness**。辅助功能改完**不需要重启**（新起的助手进程立刻生效，已实测）；屏幕录制若未生效再重启一次。

### Windows

**不需要任何授权**，开箱即用。唯一的硬限制是 **UIPI（用户界面特权隔离）**：

> 一个非提权进程**无法向提权（以管理员运行）的窗口发送输入**。

所以：如果目标程序是管理员权限启动的（例如某些安装程序、任务管理器），DSH 也必须以管理员身份运行才能操作它，否则点击和输入会静默失效。反过来也一样——以管理员运行 DSH 去操作普通程序没有问题。

**建议**：默认以普通权限运行 DSH；确实需要驱动提权窗口时再提权，并且知道那一刻 agent 也拥有了提权能力。

---

## 4. 能力矩阵（模型视角）

| 动作 | macOS | Windows |
|---|---|---|
| 截屏（全屏/区域/窗口） | ✅ | ✅ |
| 鼠标移动/点击/拖拽/滚轮 | ✅ | ✅ |
| 键盘输入中文/emoji、组合键 | ✅ | ✅ |
| 剪贴板读写 | ✅ | ✅ |
| 窗口列表 / 前台应用 | ✅ | ✅ |
| 启动、激活、退出应用 | ✅ | ✅ |
| 隐藏应用 | ✅ | ❌ |
| 菜单读取/点击 | ✅ | ❌ |
| 关闭应用 | ✅ `quit` | ✅ `quit`（`WM_CLOSE`，可强制结束） |
| 系统通知 | ✅ | ✅（托盘气泡） |
| 浏览器开网址 | ✅ | ✅ |
| 浏览器标签列表 | ✅ 全部 | ⚠️ 仅当前标签 |
| 浏览器读页面文字 | ✅ | ✅（Ctrl+A/Ctrl+C） |
| 浏览器执行 JS | ✅（需开关） | ❌（需 CDP） |
| 聊天软件发消息（两段式） | ✅ 已实测微信 | ⚠️ 逻辑相同，未实机验证 |
| 脚本逃生舱 | ✅ AppleScript | ✅ PowerShell |

---

## 5. 各平台的坑（都是实际踩到的）

### 通用

1. **不要盲按键盘操作搜索框**：微信里回车打开的是网页搜索，方向键选的是网络结果分组。这是 `computer_message` 改成两段式的原因（详见 [ARCHITECTURE.md](ARCHITECTURE.md#6-消息为什么是两段式)）。
2. **坐标必须从截图量**，并且注意缩放倍率：Retina 2x、Windows 150% 缩放都会让"像素"和"坐标"不等。
3. **动作之后要验证**：点完再截一次图，别假设一次成功。

### macOS 专属

1. `CGEventKeyboardSetUnicodeString` 单事件载荷很小，一次塞多了会退化成虚拟键码 0（打出一个 "a"）→ 现在逐字符发送。
2. 只设 `CGEvent.flags` 的组合键在 Chrome 里无效 → 现在真实按下/释放修饰键。
3. 无 `LANG` 时 `pbpaste`/`pbcopy` 走 MacRoman，中文乱码 → 所有子进程强制 `LC_CTYPE=en_US.UTF-8`。
4. AppleScript 里 `tab` 在浏览器词典中是**类名**不是制表符，当分隔符会得到一堆 `undefined` → 改用 `character id 9`。
5. 菜单栏顶层是 `menu bar item`（不是 `menu item`），且子菜单**只有目标应用在前台时**才能枚举 → 先强制置前 + 重试。
6. 某浏览器没开窗口时 `front window` 会报 `-1719` → 现在返回空列表并提示先 `action=open`。
7. Chrome 的"允许 Apple 事件中的 JavaScript"用 AppleScript 点击后**不生效**（需要重启浏览器）→ `get_text` 因此内置了 ⌘A/⌘C 降级。

### Windows 专属

1. **DPI 缩放**：进程若不是 DPI-aware，系统会虚拟化坐标，导致点击位置偏移。助手启动时先 `SetProcessDPIAware()`，全程物理像素。
2. **多显示器**：虚拟桌面坐标可能为负，鼠标坐标用 `MOUSEEVENTF_VIRTUALDESK` 归一化，不能按主屏尺寸算比例。
3. **剪贴板会被占用**：其它程序打开剪贴板时 `OpenClipboard` 会失败，助手做了重试。
4. **UIPI**：见上一节。
5. **`csc.exe` 依赖 .NET Framework**：Windows 10/11 自带；极简系统若缺失，需要装 .NET Framework 4.x。
6. **`activate` 不会启动未运行的程序**：助手只负责把已有窗口提到前台（找不到就报错）。适配器因此会在失败后用 `start` 启动一次并重试；如果按名字启动不了（例如程序没注册 App Paths），改用 `computer_app action=open_target` 传可执行文件全路径。
7. **标签页没有 API**：Chromium 在 Windows 上没有 AppleScript 那样的脚本接口，除非启动时加 `--remote-debugging-port=9222` 走 CDP。所以 `list_tabs` 只报当前标签（窗口标题），`activate_tab` 只支持 1–9 序号（`Ctrl+1..9`），`run_js` 直接报错并说明替代方案。

---

## 6. 验证状态（诚实说明）

| | 状态 |
|---|---|
| macOS 全部功能 | ✅ 本机实机验证（截屏/鼠标/键盘/剪贴板/窗口/菜单/浏览器/微信真实发送/守卫） |
| macOS 自检 | ✅ `node scripts/selftest.mjs` → 150/150 |
| Windows 接线（适配器、工具 schema、能力位、动作枚举） | ✅ 静态验证 `CC_PLATFORM=win32 node scripts/selftest.mjs` → 113/113 |
| Windows C# 助手 | ⚠️ **未在 Windows 机器上编译和运行过**；按 C# 5 / .NET Framework 4.x 语法编写并经过多轮人工复查，但不等于实测 |
| Windows 真实点击/打字/截图 | ⚠️ 未验证 |

第一次在 Windows 上使用时建议按这个顺序试：

```powershell
# 1. 编译并自检助手
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-helper.ps1
#    期望输出一行 JSON，含 screens 数组

# 2. 静态自检
node scripts\selftest.mjs

# 3. 让 agent 依次试：computer_policy environment → computer_screenshot → computer_mouse position
```

如果某一步失败，[TROUBLESHOOTING.md](TROUBLESHOOTING.md) 里有对应的排查路径。
