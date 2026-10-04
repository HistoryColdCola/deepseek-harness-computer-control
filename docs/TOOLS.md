# 工具参考

九个工具的完整说明。所有坐标单位：**macOS 是 point，Windows 是物理像素**；原点都在主显示器左上角，副屏可能是负坐标。想知道当前屏幕参数，调 `computer_policy action=environment`。

> **换算规则（最容易点错的地方）**
> - **macOS**：Retina 截图的像素是坐标网格的 2 倍 → 点击坐标 = `图像素 ÷ scale`。
> - **Windows**：助手是 DPI-aware 的，截图像素**就是**屏幕坐标 → **直接用图像素，不要除 scale**（`scale` 只作参考）。
>
> 截图工具返回的 `note` 里会按当前平台写清这一条，照着做即可。

通用约定：

- 所有会改动的动作（输入文字 / 剪贴板写入 / 脚本 / 打开网址 / 菜单项 / 发消息）都会先过**购物守卫**，命中支付结算词直接拒绝并说明原因。
- 坐标不要猜：先 `computer_screenshot`，量出像素坐标后除以截图里给出的 `scale`。
- 失败时工具抛错，错误文本是给模型看的，通常包含下一步该怎么做。

---

## 1. `computer_screenshot` — 看屏幕

截屏并**把图片本身贴进对话**，这是整套工具的眼睛。

| 参数 | 类型 | 说明 |
|---|---|---|
| `target` | `screen` \| `region` \| `window` | 默认 `screen` |
| `display` | integer | 1 起的显示器序号，`target=screen` 时有效 |
| `region` | `{x,y,width,height}` | `target=region` 时必填，单位同坐标 |
| `window_id` | integer | `target=window` 时必填，来自 `computer_app action=windows` |
| `attach` | boolean | 是否把图贴进上下文，默认 `true` |
| `max_edge` | integer | 贴图最长边（像素），默认 1600，`0` 表示不缩放 |

返回：`path`（全尺寸 PNG）、`previewPath`（缩放版）、`width`/`height`（原图像素）、`scale`（屏幕缩放倍率）、`attached`、`note`（屏幕几何 + 权限提示），以及附带的图片块。

```
computer_screenshot {target:'window', window_id:965}          # 只看某个窗口
computer_screenshot {target:'region', region:{x:0,y:40,width:1440,height:120}}   # 只看地址栏区域
computer_screenshot {attach:false}                            # 只要路径，不占上下文
```

> 区域截图最省 token：只截你要点的那一块，模型看得更清楚，也不容易数错坐标。
> 全尺寸原图永远留在 `~/.dsh/computer-control/shots/`，需要时可以再读。

---

## 2. `computer_mouse` — 鼠标

| 参数 | 说明 |
|---|---|
| `action` | `move` / `click` / `double_click` / `right_click` / `middle_click` / `drag` / `scroll` / `position` |
| `x`,`y` | 目标点（`move`/`click`/`drag` 起点） |
| `to_x`,`to_y` | `drag` 终点 |
| `dx`,`dy` | 滚轮增量，`dy` 正数向上、负数向下翻页；macOS 单位是像素，Windows 是滚轮刻度（120 = 一格） |
| `button` | `left`/`right`/`middle`，默认 left |
| `count` | 点击次数，默认 1（`double_click` 等于 2） |
| `duration_ms` | 拖拽时长，默认 260ms |

返回落点坐标。`position` 用于读回当前鼠标位置（配合"移动后确认"的调试套路）。

```
computer_mouse {action:'position'}                      # 先看指针在哪
computer_mouse {action:'click', x:720, y:380}           # 点一下
computer_mouse {action:'drag', x:400, y:300, to_x:400, to_y:600, duration_ms:400}
computer_mouse {action:'scroll', dy:-600}               # 向下翻页
```

要点：

- 点击前先截图确认位置；点完再截图确认结果（"动作 → 验证"是这套工具的正确用法）。
- 拖拽的起点、终点都是绝对坐标，中间会自动插值多步（很多 UI 需要连续的拖动事件才认）。
- 把鼠标移到目标再点，而不是依赖"当前指针位置"，能避免用户手一动就跑偏。

---

## 3. `computer_keyboard` — 键盘

| 参数 | 说明 |
|---|---|
| `action` | `type`（输入文本）/ `key`（按单键）/ `hotkey`（组合键） |
| `text` | `type` 的内容 |
| `key` | `key` 的键名 |
| `chord` | `hotkey` 的组合，如 `cmd+shift+4` / `ctrl+c` |
| `repeat` | 重复次数 |
| `delay_ms` | 重复之间的间隔 |

键名（跨平台通用）：`return` `enter` `tab` `space` `escape` `backspace` `delete` `forwarddelete` `up` `down` `left` `right` `home` `end` `pageup` `pagedown` `insert` `f1`–`f12` `a`–`z` `0`–`9` `minus` `equal` `comma` `period` `slash` `backslash` `semicolon` `quote` `leftbracket` `rightbracket` `grave`，以及十进制虚拟键码。

修饰键名：macOS 用 `cmd` `shift` `option`(=alt) `control` `fn`；Windows 用 `ctrl` `alt` `shift` `cmd`(=Win 键)。

```
computer_keyboard {action:'type', text:'搜索 蓝牙耳机'}     # 中文直接进，不走输入法
computer_keyboard {action:'key', key:'return'}
computer_keyboard {action:'hotkey', chord:'cmd+a'}          # Windows: 'ctrl+a'
computer_keyboard {action:'key', key:'down', repeat:5}      # 列表里往下挪 5 行
```

要点：

- `type` 是**直接注入 Unicode**，绕过输入法，中文/emoji 都不会乱码（已实测 6/6 通过）。
- 长文本优先用"写剪贴板 + 粘贴"，比逐字符输入快得多，也不容易丢字符。
- 焦点问题：先 `computer_app action=activate` 把目标窗口拿到前台，再打字。

---

## 4. `computer_clipboard` — 剪贴板

| 参数 | 说明 |
|---|---|
| `action` | `read` / `write` |
| `text` | `write` 的内容 |

```
computer_clipboard {action:'write', text:'一大段要填的文本'}
computer_keyboard {action:'hotkey', chord:'cmd+v'}
computer_clipboard {action:'read'}
```

内部强制 UTF-8，中文不会变成乱码（macOS 上不设 `LC_CTYPE` 时 `pbpaste` 会按 MacRoman 编码，这是踩过的坑）。

> 注意：`computer_browser` 的 `get_text` 在降级路径下会覆盖剪贴板；用它之前别放重要内容。

---

## 5. `computer_app` — 应用与窗口

| 参数 | 说明 |
|---|---|
| `action` | `open`/`activate`（启动或切前台）、`quit`、`hide`（仅 macOS）、`list`、`windows`、`frontmost`、`open_target`、`menu`（仅 macOS） |
| `app` | 应用名或别名 |
| `target` | `open_target` 的文件/文件夹/URL |
| `menu` / `item` | 菜单路径与菜单项，路径支持 `View > Developer` 多级写法 |

别名示例：`微信`/`wechat`→WeChat，`chrome`，`vscode`，`访达`/`finder`，`终端`/`terminal`；Windows 上还有 `记事本`/`notepad`、`资源管理器`/`explorer`、`计算器`。

```
computer_app {action:'windows'}                                   # 拿窗口 id（喂给截图）
computer_app {action:'activate', app:'微信'}
computer_app {action:'open_target', target:'https://example.com', app:'chrome'}
computer_app {action:'menu', app:'Google Chrome', menu:'显示 > 开发者', item:'允许 Apple 事件中的 JavaScript'}
computer_app {action:'list'}
```

要点：

- `windows` 返回 `id=... app=... title=... bounds=x,y,w,h`，`id` 可以直接给 `computer_screenshot target=window`。
- `menu` 只在 macOS 可用（Windows 没有可脚本化的菜单栏，能力位会把该动作从枚举里摘掉）；菜单子项**只有目标应用在前台时才能枚举**，所以实现里会先强制置前并重试。
- `open_target` 的 URL 会过购物守卫（命中结算/支付域名会被拒）。

---

## 6. `computer_message` — 发消息（两段式）

| 参数 | 说明 |
|---|---|
| `app` | 聊天软件名或别名（微信/QQ/钉钉/飞书/Telegram/Slack/Messages/WhatsApp） |
| `to` | 联系人/会话名 |
| `text` | 消息正文 |
| `send` | 是否在填好后按发送键，默认 `true` |
| `result_point` | **阶段二**：从阶段一截图里量出的那一行结果坐标；**不传就只定位不发送** |
| `input_point` | 打开会话后若输入框没焦点，再点一下这个坐标 |
| `search_chord` / `send_key` / `settle_ms` | 覆盖预设（搜索快捷键 / 发送键 / 每步等待毫秒） |

```
# 阶段一：只定位，返回截图，什么都没发
computer_message {app:'微信', to:'文件传输助手', text:'测试消息'}

# 阶段二：看截图量出那一行坐标，再真的发送
computer_message {app:'微信', to:'文件传输助手', text:'测试消息', result_point:{x:195,y:369}}
```

**为什么必须两段**：微信搜索下拉里回车打开的是"搜一搜"，方向键选中的是"搜索网络结果"——盲按键盘会把消息发给当时打开的那个聊天（实测差点发给真人）。所以选行这件事交给能看截图的模型，工具本身绝不猜。

返回 `needsResult:true` 表示还停在阶段一；阶段二返回 `sent:true/false` 和完整步骤流水，并附一张结果截图。

其它平台差异：macOS 搜索键默认 `cmd+f`，Windows 默认 `ctrl+f`；都可以用 `search_chord` 覆盖，或在 `config.json` 的 `messageApps` 里持久化。

---

## 7. `computer_browser` — 浏览器

| 参数 | 说明 |
|---|---|
| `action` | `open` `list_tabs` `active_tab` `get_text` `get_html` `run_js` `activate_tab` `close_tab` `reload` `back` `wait` |
| `browser` | macOS：`chrome` `edge` `brave` `arc` `vivaldi` `safari`；Windows：`chrome` `edge` `brave` `vivaldi` |
| `url` / `javascript` / `index` / `match` / `max_chars` / `wait_ms` | 各动作对应参数 |

```
computer_browser {action:'open', url:'https://example.com'}
computer_browser {action:'get_text', max_chars:4000}
computer_browser {action:'list_tabs'}
computer_browser {action:'activate_tab', match:'DeepSeek'}
computer_browser {action:'run_js', javascript:'document.title'}
```

平台能力差异（重要）：

| 能力 | macOS | Windows |
|---|---|---|
| 打开网址 | ✅ | ✅ |
| 列出全部标签页 | ✅ AppleScript | ⚠️ 只能拿到当前标签（窗口标题），需要 CDP 才能拿全部 |
| 按序号切标签 | ✅ | ✅ `Ctrl+1..9` |
| 按标题切标签 | ✅ | ❌ 报错并说明原因 |
| 关标签 / 刷新 / 后退 | ✅ | ✅ `Ctrl+W` / `Ctrl+R` / `Alt+←` |
| 读页面文字 | ✅（JS 或 ⌘A/⌘C 降级） | ✅（Ctrl+A/Ctrl+C） |
| 执行 JS | ✅ 需打开"允许 Apple 事件中的 JavaScript" | ❌ 需要 `--remote-debugging-port` 走 CDP |

`get_text` 的降级路径会覆盖剪贴板并在结果里注明。`run_js` 在不可用时抛出的错误里写了替代方案，不会静默失败。

---

## 8. `computer_ui` — 脚本逃生舱

| 参数 | 说明 |
|---|---|
| `action` | `script`（跑脚本）、`frontmost`、`menu_items`（仅 macOS）、`notify` |
| `script` | macOS：AppleScript 源码；Windows：PowerShell 源码 |
| `app` / `menu` | `menu_items` 用 |
| `title` / `text` | `notify` 用 |
| `timeout_ms` | 脚本超时，默认 30s |

```
# macOS
computer_ui {action:'script', script:'tell application "System Events" to keystroke "hi"'}
# Windows
computer_ui {action:'script', script:'Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -First 5 Name,MainWindowTitle'}
computer_ui {action:'frontmost'}
computer_ui {action:'notify', title:'DSH', text:'任务完成'}
```

脚本内容同样过购物守卫（例如脚本里出现"确认支付"会被拒绝）。这是"其它工具搞不定时的万能出口"，但不是绕过安全策略的出口。

---

## 9. `computer_policy` — 策略、权限与自检

| 参数 | 说明 |
|---|---|
| `action` | `status`（策略与能力矩阵）、`check`（拿一段文字试守卫）、`environment`（权限与屏幕） |
| `value` | `check` 要测试的文字 |

```
computer_policy {action:'status'}
computer_policy {action:'environment'}
computer_policy {action:'check', value:'立即购买'}
```

`status` 会列出：平台与助手路径、结算/支付是否被禁止、能力矩阵（菜单/通知/浏览器标签/浏览器 JS/脚本语言）、配置路径、支持的聊天软件与浏览器、完整禁词表。
`environment` 会列出权限状态与每个显示器的尺寸/缩放/坐标。

**推荐开场**：新环境第一次用，先 `computer_policy action=environment` 确认权限和屏幕参数，再开始操作。

---

## 10. 常用套路

**A. 点一个看得见但说不清的按钮**

```
1 computer_screenshot {target:'region', region:{...}}   # 局部截图，看清位置
2 computer_policy {action:'environment'}                # 拿到 scale
3 computer_mouse {action:'click', x:px/scale, y:py/scale}
4 computer_screenshot {}                                # 验证结果
```

**B. 填一张长表单**

```
1 computer_clipboard {action:'write', text:'...'}       # 一次写入
2 computer_mouse {action:'click', ...}                  # 点输入框
3 computer_keyboard {action:'hotkey', chord:'cmd+v'}    # 粘贴
4 computer_keyboard {action:'key', key:'tab'}           # 跳下一格
```

**C. 逛电商（不越界）**

```
computer_browser {action:'open', url:'https://...'}
computer_browser {action:'get_text', max_chars:6000}    # 读商品信息
computer_mouse {...}                                    # 点"加入购物车"（允许）
computer_keyboard {action:'type', text:'去结算'}         # ← 被守卫拒绝
```

**D. 给某人发消息**

```
1 computer_app {action:'activate', app:'微信'}
2 computer_message {app:'微信', to:'张三', text:'...'}                 # 只定位
3 computer_message {app:'微信', to:'张三', text:'...', result_point:{x,y}}  # 确认后发送
```
