# 使用教程

从装好到实际干活。命令示例里的 `computer_*` 都是**对 agent 说的话**（或模型自己发起的工具调用），不是 shell 命令。

---

## 0. 装好之后先做三件事

1. **确认插件加载**：当前会话的工具列表里应该出现 9 个 `computer_*` 工具；没有就重启 App。
   加载记录写在 `~/.dsh/computer-control/mounted.json`（Windows：`%USERPROFILE%\.dsh\computer-control\mounted.json`）。
2. **确认权限**：让 agent 执行 `computer_policy` action=`environment`。
   - macOS 应看到 `accessibility: granted`、`screen recording: granted`；缺了就按 [PLATFORMS.md](PLATFORMS.md#3-权限) 授权。
   - Windows 两行恒为 granted，无需授权。
3. **跑一次自检**（可选，验证整条链路）：

   ```sh
   node scripts/selftest.mjs          # macOS / 已装 Node 的 Windows
   CC_PLATFORM=win32 node scripts/selftest.mjs   # 任意机器上静态校验 Windows 接线
   ```

---

## 1. 场景一：看一眼现在屏幕上是什么

> "截个图看看现在屏幕上是什么。"

```
computer_screenshot {}
```

返回里会带图片。想省钱就只截一块：

> "只看浏览器地址栏那一块。"

```
computer_screenshot {target:'region', region:{x:0, y:40, width:1440, height:120}}
```

**要点**：截图里的坐标是**图片像素**。模型要用 `computer_mouse` 点击时，必须先除以 `details` 里的 `scale`（Retina 是 2，Windows 常见 1.25/1.5/2）——工具说明里写了这件事，所以正常情况模型会自己换算。

---

## 2. 场景二：点一个"看得见但说不清"的按钮

> "点一下那个蓝色的保存按钮。"

模型会这样做（这是正确姿势，你也可以照此提示它）：

```
1  computer_screenshot {target:'region', region:{...}}    # 看清按钮位置
2  computer_mouse {action:'click', x:..., y:...}          # 点击（坐标 = 图像素 / scale）
3  computer_screenshot {}                                 # 验证结果
```

**要点**：

- 一定要求"点完再截一次图确认"。90% 的自动化失败都是"点了但没点中"或"点到了别的地方"。
- 界面动过（弹窗、动画、加载）之后再点，要先重新截图，别复用旧坐标。

---

## 3. 场景三：打开软件 / 切换窗口

> "打开微信，把窗口调到前面。"

```
computer_app {action:'activate', app:'微信'}      # 别名：微信/wechat 都行
computer_app {action:'list'}                      # 看现在都有什么
computer_app {action:'windows'}                   # 拿窗口 id / 标题 / 位置
```

拿到的窗口 id 可以直接用来只截某个窗口：

```
computer_screenshot {target:'window', window_id:965}
```

---

## 4. 场景四：发消息（两段式，务必按这个顺序）

> "在微信里给『文件传输助手』发一条：今天的日报已提交。"

**第一步，只定位不发送**：

```
computer_message {app:'微信', to:'文件传输助手', text:'今天的日报已提交。'}
```

返回一张截图 + `NOTHING was sent`。检查截图里：

- 搜索下拉里是不是有目标那一行（微信里通常在"功能"或"联系人"分组）；
- 量出那一行的坐标（图片像素 ÷ scale）。

**第二步，确认无误再发送**：

```
computer_message {app:'微信', to:'文件传输助手', text:'今天的日报已提交。', result_point:{x:195, y:369}}
```

如果点开聊天后输入框没拿到焦点（消息粘不进去），再加上输入框坐标：

```
computer_message {..., result_point:{x:195,y:369}, input_point:{x:640, y:700}}
```

**要点**：

- **永远先跑第一步**。微信搜索框回车打开的是网页搜索，盲按必然发错人（实测差点发给真人）。
- 慢机器上把 `settle_ms` 调大（例如 1500），给界面留出反应时间。
- 发送不顺时别硬来，退回原语手动走：`computer_app activate` → `computer_mouse click`（点搜索框）→ `computer_keyboard type`（打字）→ `computer_screenshot` 确认 → `computer_mouse click`（点会话）→ `computer_clipboard write` + `computer_keyboard hotkey cmd+v` → `computer_mouse click`（点发送）。

---

## 5. 场景五：逛电商（能加购，不能结算）

> "打开某商城，搜『蓝牙耳机』，按价格排序，把前三个加进购物车，然后告诉我哪个最便宜。"

```
computer_browser {action:'open', url:'https://shop.example.com'}
computer_browser {action:'get_text', max_chars:8000}       # 读页面内容
computer_mouse {...}                                        # 搜索框 → 输入 → 回车
computer_browser {action:'get_text'}                        # 读结果列表
computer_mouse {...}                                        # 点"加入购物车"（允许）
```

一旦试图走到结算：

```
computer_keyboard {action:'type', text:'去结算'}
→ Error: blocked by the computer-control purchase guard: typed text matches "去结算".
  This profile is configured for browsing and adding to cart only — checkout and
  payment are disabled. ... tell the user the next step needs their own click.
```

这是**预期行为**。想要放宽带见 [SAFETY.md](SAFETY.md#3-模型无法自己放权)，但强烈建议保留。

---

## 6. 场景六：填表 / 批量输入

长文本用剪贴板比逐字打字快得多，也更不容易丢字符：

```
1  computer_clipboard {action:'write', text:'一段很长的地址……'}
2  computer_mouse    {action:'click', x:..., y:...}          # 点输入框
3  computer_keyboard {action:'hotkey', chord:'cmd+v'}        # Windows 用 'ctrl+v'
4  computer_keyboard {action:'key', key:'tab'}               # 跳到下一格，循环
```

中文输入直接 `computer_keyboard {action:'type', text:'中文内容'}`——它是**直接注入 Unicode**，不走输入法，不会出现乱码（已在 TextEdit 里回读比对 6/6 通过）。

---

## 7. 场景七：浏览器里读页面 / 执行 JS

```
computer_browser {action:'active_tab'}                  # 当前标签
computer_browser {action:'list_tabs'}                   # 全部标签（macOS）
computer_browser {action:'activate_tab', match:'DeepSeek'}
computer_browser {action:'get_text', max_chars:6000}    # 读正文
computer_browser {action:'run_js', javascript:'document.querySelectorAll("h2").length'}
```

- macOS 上 `run_js` 需要先在浏览器里打开 **显示 ▸ 开发者 ▸ 允许 Apple 事件中的 JavaScript**（Chrome 可能要重启才生效）。没开时 `get_text` 会自动降级为 ⌘A/⌘C 读剪贴板。
- Windows 上 `run_js` 不可用，`get_text` 走 Ctrl+A/Ctrl+C；标签列表只能拿到当前标签。

---

## 8. 场景八：其它工具做不到的事，用脚本逃生舱

```
# macOS
computer_ui {action:'script', script:'tell application "Finder" to get name of every disk'}

# Windows
computer_ui {action:'script', script:'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,FreeSpace'}
```

脚本内容同样过购物守卫；带"确认支付"之类的脚本会被拒绝。

---

## 9. 让 agent 干得更好的提示词技巧

| 想要的效果 | 怎么提要求 |
|---|---|
| 少踩空 | "每点一次都要截图确认，坐标从截图里量。" |
| 省 token | "只截需要看的那一小块区域。" |
| 更稳 | "找不到就停下来告诉我，不要猜坐标。" |
| 别乱发 | "发消息前先把截图给我看，我确认了再发。" |
| 慢机器 | "把 settle_ms 设成 1500。" |
| 明确边界 | "可以加购物车，但不要进结算。" |

---

## 10. 一次完整对话长什么样

> **你**：帮我在微信里给『文件传输助手』发一条"测试消息 ✅"，发之前给我看一下。

> **agent**：`computer_message {app:'微信', to:'文件传输助手', text:'测试消息 ✅'}`
> 现在是搜索结果的截图，还没发送。目标那一行在 (195, 369)，要我发送吗？

> **你**：发。

> **agent**：`computer_message {app:'微信', to:'文件传输助手', text:'测试消息 ✅', result_point:{x:195, y:369}}`
> 已发送，这是发送后的截图。

这就是设计的用法：**agent 负责跑腿和核对，你负责按最后那一下**。
