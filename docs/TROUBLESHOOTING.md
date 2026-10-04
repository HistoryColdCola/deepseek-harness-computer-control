# 故障排查

按症状查。每一条都是"现象 → 原因 → 处理"。

---

## 插件根本没加载

**现象**：会话里看不到 `computer_*` 工具。

1. 看加载记录是否生成：
   - macOS：`~/.dsh/computer-control/mounted.json`
   - Windows：`%USERPROFILE%\.dsh\computer-control\mounted.json`

   文件里应该有 `platform`、`helper`、`tools` 三个字段。
2. 没有文件 → 配置行没生效：
   - 检查 `<profile>/cordis.patch.yml` 是否只有**一条** `id: computer-control`；
   - 重启 DeepSeek Harness（HMR 失败时这是最可靠的）。
3. 有文件但工具没出现 → 会话是插件加载**之前**创建的；新建一个会话，或重启 App。
4. 加载记录里的 `helper` 路径不存在 → 助手没编译，见下一节。

---

## 助手缺失 / 编译失败

**现象**：调用任何工具都报 `the ... input helper is missing at ...`。

### macOS

```sh
sh scripts/build-helper.sh          # 需要 Xcode Command Line Tools
xcode-select --install              # 如果提示 swiftc 不存在
~/.../computer-control/bin/dsh-input check
```

`check` 应输出一行 JSON，含 `screens` 数组。

### Windows

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-helper.ps1
```

- 报找不到 `csc.exe` → 该系统没有 .NET Framework 4.x；从微软官网安装 .NET Framework 4.8。
- 编译报语法错 → 说明 `native\DshInput.cs` 被改动过；恢复仓库版本。
- 编译通过但 `check` 输出异常 → 把完整输出贴出来（JSON 里 `screens` 是空的通常意味着没有可用桌面会话，例如在服务/Session 0 里运行）。

---

## macOS：点击、输入完全没反应

**原因**：辅助功能（Accessibility）权限没给，或给错了 App。

```sh
~/.dsh/profiles/<profile>/plugins/computer-control/bin/dsh-input request   # 触发弹窗
```

系统设置 ▸ 隐私与安全性 ▸ **辅助功能** → 勾选 **DeepSeek Harness**（不在列表就用 `+` 从 `/Applications` 添加）。
**改完不需要重启 App**（助手是独立进程，新起的进程立即生效）。

验证：`computer_policy action=environment` → `accessibility: granted`。

---

## macOS：截图只有壁纸，看不到窗口

**原因**：缺**屏幕录制**权限。

系统设置 ▸ 隐私与安全性 ▸ **屏幕录制** → 勾选 DeepSeek Harness → **重启 App**（屏幕录制权限通常需要重启才生效）。

验证：`computer_policy action=environment` → `screen recording: granted`。

---

## macOS：`osascript` 报 not authorized / -1743

**原因**：自动化（Automation）权限被拒。

系统设置 ▸ 隐私与安全性 ▸ **自动化** → 找到 DeepSeek Harness → 勾选它要控制的目标 App（Chrome、微信……）。
如果列表里之前点了"不允许"，需要先删掉那条记录，下次调用会重新弹窗。

---

## macOS：`-1728` / "不能获得 process"

**原因**：目标 App 没在运行，或菜单子项只有在它位于前台时才能枚举。

处理：先 `computer_app action=activate`，再操作。内置实现已经会先强制置前并重试 3 次；如果仍失败，说明该 App 根本没启动或进程名不对（用 `computer_app action=list` 看真实名字）。

---

## macOS：`-1719` / "不能获得 window 1"

**原因**：浏览器在运行但一个窗口都没开。

处理：`computer_browser action=open url=...` 或手动打开一个窗口。适配器现在会返回空列表并给出这条提示，不再抛系统错误。

---

## 浏览器报 "JavaScript 的功能已关闭"

**现象**：`run_js` 或 `get_html` 报错；`get_text` 返回内容但带一句"read with ⌘A/⌘C"。

**原因**：Chrome/Edge/Brave 需要 **显示 ▸ 开发者 ▸ 允许 Apple 事件中的 JavaScript**；Safari 要先在 设置 ▸ 高级 打开"显示开发菜单"，再在 开发 菜单里允许。

已知：**用 AppleScript 点这个菜单项不会生效**（实测），手动开或重启浏览器。

替代方案：

- 读页面文字 → `get_text` 的降级路径已经能用（⌘A/⌘C，会覆盖剪贴板）；
- 真要执行 JS → 用 `--remote-debugging-port=9222` 启动浏览器走 CDP，或改用 macOS 的其它方式。

---

## 输入中文乱码

**macOS**：`pbpaste`/`pbcopy` 在无 `LANG` 环境下按 MacRoman 编码。本插件已强制 `LC_CTYPE=en_US.UTF-8`。若仍有问题，说明调用的不是插件的剪贴板通道（例如自己写的脚本）。

**Windows**：助手在启动时设置 UTF-8 输出编码；如果控制台仍显示乱码，是终端显示问题，不影响 JSON 数据本身。

**输入法相关**：`computer_keyboard type` 是**直接注入 Unicode**，不经过输入法；如果你想要的恰恰是"经由输入法"（例如输入拼音候选），那不属于本插件的用法。

---

## Windows：点了没反应，但没有任何报错

**原因**：UIPI——非提权进程不能给提权窗口发输入。

处理：让 DSH 与目标程序处于**相同权限级别**。目标以管理员运行时，DSH 也要以管理员运行。

---

## Windows：点击位置偏移

**原因**：DPI 缩放，或者用了错误的缩放倍率换算。

处理：

1. 助手已声明 DPI-aware，坐标就是物理像素；
2. 截图返回的 `scale` 是显示器 DPI/96，换算时用**该显示器**的 scale；
3. 多显示器时注意副屏坐标可能是负数。

---

## 消息发错人 / 没发出去

**原因**：跳过了定位阶段直接发。

**正确流程**（见 [USAGE.md](USAGE.md#4-场景四发消息两段式务必按这个顺序)）：

1. 先 `computer_message`（不传 `result_point`）→ 拿到截图 → 什么都没发；
2. 看清截图里目标那一行 → 量坐标 → 再传 `result_point` 发送。

其它排查点：

- 输入框没焦点 → 加 `input_point`；
- 界面没反应过来 → 加大 `settle_ms`（1000–2000）；
- 搜索快捷键不对 → 用 `search_chord` 覆盖（微信 macOS 是 `cmd+f`，Windows 是 `ctrl+f`）；
- 某些软件把搜索做成了独立窗口 → 退回原语手动操作（激活 → 点搜索框 → 打字 → 截图 → 点结果 → 粘贴 → 回车）。

---

## 被购物守卫拦住，但这是误判

**现象**：例如搜一个叫"支付"的商品被拦。

处理：

1. 换个说法（"在线付款工具" → 会被拦；改成具体商品名）；
2. 或者在 `~/.dsh/computer-control/config.json` 里调整：
   - 该守卫生效在**输入动作**上，搜索词也会被检查；
   - 想放宽就把 `allowCheckout` / `allowPayment` 打开（不建议），或从禁词表想办法规避是**不被支持**的（禁词表是硬编码的，`extraBlockedPatterns` 只能加不能减）。

先自查：

```
computer_policy {action:'check', value:'你要输入的内容'}
```

---

## 工具调用超时

**原因**：脚本/AppleScript/浏览器响应慢，或目标 App 卡住。

- `computer_ui` 的 `timeout_ms` 默认 30s，可调大；
- `computer_message` 的 `settle_ms` 影响总时长；
- 截图 30s 超时通常意味着系统在弹权限对话框等待点击。

---

## HMR 改了代码没生效

**原因**：模块监听有约 2 秒的写入稳定窗口；或者 profile 里没有 `hmr` 那一段配置。

处理：

1. 等 3–5 秒再看；
2. 确认 `cordis.patch.yml` 里有 `- id: hmr` 且 `config.root: ['./plugins']`；
3. 还是不行就重启 App（最可靠）。

`~/.dsh/computer-control/config.json` 的改动**不需要**重载，每次调用都会重读。

---

## 想彻底重来

```sh
# macOS
sh scripts/uninstall-local.sh desktop     # 移除插件目录 + 配置行（自动备份）
sh scripts/install-local.sh desktop       # 重新安装

# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-local.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1
```

手工清理残留（如需）：

- 插件目录：`<profile>/plugins/computer-control/`
- 运行状态：`~/.dsh/computer-control/`（含截图、加载记录、配置）
- 配置备份：`<profile>/cordis.patch.yml.bak-*`

---

## 还是不行？收集这些信息再排查

1. `computer_policy` action=`status` 与 action=`environment` 的完整输出；
2. `<profile>/plugins/computer-control/bin/` 下助手是否存在，以及它 `check` 的输出；
3. `~/.dsh/computer-control/mounted.json`；
4. 报错工具的完整错误文本（工具的错误信息一般已经包含下一步建议）。
