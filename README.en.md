# dsh-computer-control

English | [中文](README.md)

Give a DSH agent hands on this machine: see the screen, move the mouse, type, launch apps, drive a browser, send chat
messages. **One tool set for macOS and Windows.** Host-side plugin, **zero third-party dependencies** — Node builtins
plus the OS's own facilities plus one native helper compiled at install time.

> **Safety boundary**: by default the agent may browse and add items to a cart, but **must not enter checkout or pay**.
> The policy is hard-coded and no tool call can lift it — only a human editing the config file can. See
> [docs/SAFETY.md](docs/SAFETY.md).

---

## Quick start

```sh
# macOS
sh scripts/install-local.sh                 # desktop profile by default

# Windows (PowerShell)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1
```

The script copies the plugin into the profile's `plugins/computer-control/`, compiles the native helper, and appends
the loader row to `cordis.patch.yml` (backed up first, and HMR watching is switched on so later code edits reload
live). Restart DeepSeek Harness (or let HMR apply it) and nine `computer_*` tools appear in the session.

### macOS needs permissions (once)

```sh
~/.dsh/profiles/desktop/plugins/computer-control/bin/dsh-input request   # triggers the system prompts
```

Grant these to **DeepSeek Harness** under System Settings ▸ Privacy & Security:

| Permission | Used for | Without it |
|---|---|---|
| Accessibility | mouse, keyboard, menus | events are dropped, clicks do nothing |
| Screen Recording | screenshots | only the wallpaper is captured |
| Automation | controlling other apps | prompted on first use; allow it |

Accessibility applies without restarting; restart the app if Screen Recording does not.

### Windows needs no permissions

The one hard limit is **UIPI**: a non-elevated process cannot send input to an elevated (Administrator) window. To
drive an elevated app, run DSH elevated too.

### Verify

```sh
node scripts/selftest.mjs                        # this host: static + real read-only execution -> 150/150
CC_SELFTEST_OFFLINE=1 node scripts/selftest.mjs  # static only, headless/CI -> 116/116
CC_PLATFORM=win32 node scripts/selftest.mjs      # validate the Windows wiring from any host -> 113/113
```

Or ask the agent: `computer_policy` with action=`environment`.

---

## The nine tools

| Tool | What it does |
|---|---|
| `computer_screenshot` | Capture a screen, display, region or window and **attach the image to the conversation** |
| `computer_mouse` | Move, click, double-click, right/middle click, drag, scroll, read the pointer back |
| `computer_keyboard` | Type any text (CJK/emoji injected directly, no IME), press named keys and chords |
| `computer_clipboard` | Read/write the clipboard (forced UTF-8, no CJK mojibake) |
| `computer_app` | Launch/focus/quit apps, list windows with ids, open files and URLs, click nested menus |
| `computer_message` | Send a chat message in WeChat/QQ/DingTalk/Feishu/Telegram/Slack/Messages/WhatsApp (**two-phase**) |
| `computer_browser` | Chrome/Edge/Brave/Arc/Safari: open URLs, switch tabs, read pages, run JavaScript |
| `computer_ui` | Escape hatch: AppleScript on macOS, PowerShell on Windows |
| `computer_policy` | Show policy, permissions, capability matrix and screen geometry; screen a string |

Full parameter reference, examples and platform differences: **[docs/TOOLS.md](docs/TOOLS.md)**.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works: plugin loading, tool registration, platform layer, native helpers, image attachment, two-phase messaging, where the guard sits |
| [docs/TOOLS.md](docs/TOOLS.md) | Complete tool reference and common recipes |
| [docs/PLATFORMS.md](docs/PLATFORMS.md) | macOS vs Windows: mechanisms, permissions, capability matrix, platform-specific pitfalls |
| [docs/SAFETY.md](docs/SAFETY.md) | What the purchase guard blocks, why, and its limits |
| [docs/USAGE.md](docs/USAGE.md) | Tutorial with eight hands-on scenarios |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom → cause → fix |

---

## Capability matrix (summary)

| Capability | macOS | Windows |
|---|---|---|
| Screenshot / mouse / keyboard / clipboard / windows / app control | ✅ | ✅ |
| Menu reading and clicking | ✅ AppleScript | ❌ no equivalent (the action is removed from the tool enum) |
| Hiding an app | ✅ | ❌ |
| Browser tab list | ✅ all tabs | ⚠️ active tab only without CDP |
| Browser JavaScript | ✅ needs the Develop-menu switch | ❌ needs the DevTools Protocol |
| Chat messaging | ✅ WeChat measured on this machine | ⚠️ same logic, not measured on Windows |
| Script escape hatch | ✅ AppleScript | ✅ PowerShell |

Details in [docs/PLATFORMS.md](docs/PLATFORMS.md).

---

## Configuration

`~/.dsh/computer-control/config.json` (created on first mount; edits apply immediately, no restart):

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

- `allowCheckout` / `allowPayment`: **human-only**; the agent has no tool that can change them.
- `maxScreenshotEdge`: longest edge of the preview attached for the model (the full-size PNG stays on disk).
- `typeChunkDelayMs`: per-character delay while typing; raise it for slow apps.
- `messageApps`: per-app overrides of the messaging flow.

On Windows use `ctrl+f` instead of `cmd+f`.

Runtime state lives in `~/.dsh/computer-control/` (`config.json`, `shots/`, `mounted.json`).

---

## Layout

```
dsh-computer-control/
├── lib/
│   ├── index.js            plugin entry: pick platform, register tools
│   ├── tools.js            the nine tools (platform neutral)
│   ├── message.js          two-phase messaging (platform neutral)
│   ├── policy.js           purchase guard (pure functions)
│   ├── runtime.js          config / subprocess / UTF-8 environment
│   └── platform/
│       ├── index.js        adapter interface + platform selection
│       ├── darwin.js       macOS: dsh-input (Swift) + osascript
│       └── win32.js        Windows: dsh-input.exe (C#) + PowerShell
├── native/
│   ├── DshInput.swift      macOS helper
│   └── DshInput.cs         Windows helper
├── scripts/                build / install / uninstall / selftest (.sh and .ps1)
├── docs/                   the documentation set
└── cordis.patch.yml        bundle patch for the pnpm install path
```

---

## Verification status (honest)

| Item | Status |
|---|---|
| macOS, all features | ✅ measured on a real machine (screenshots, mouse, keyboard, clipboard, windows, menus, browsers, a real WeChat send, guard refusals) |
| macOS self-test | ✅ `node scripts/selftest.mjs` → **150/150** |
| Windows wiring (adapter, tool schemas, capabilities, action enums, guard) | ✅ static `CC_PLATFORM=win32 node scripts/selftest.mjs` → **113/113** |
| Windows C# helper and real input | ⚠️ **never compiled or run on Windows**; written for C# 5 / .NET Framework 4.x and reviewed line by line several times |

Suggested first run on Windows: `build-helper.ps1` → `check` prints JSON → `node scripts\selftest.mjs` → ask the agent
for `computer_policy environment`, then `computer_screenshot`, then `computer_mouse position`.

---

## Bugs found and fixed on real hardware

1. **Typing long text produced a single "a"**: `CGEventKeyboardSetUnicodeString` accepts very few UTF-16 units; a
   longer payload is dropped and the event degenerates to virtual keycode 0. → one character per event.
2. **Chords did nothing**: setting `CGEvent.flags` alone is ignored by some apps (Chrome). → hold the real modifier keys.
3. **Clipboard mojibake**: without `LANG`, `pbpaste`/`pbcopy` fall back to MacRoman. → every child gets
   `LC_CTYPE=en_US.UTF-8`.
4. **Browser tab lists were all `undefined`**: `tab` is a class name in the browser AppleScript dictionaries, not a tab
   character. → delimiters now use `character id 9`.
5. **Nested menu items unavailable**: the first level is a `menu bar item`, and submenus are only enumerable while the
   app is frontmost. → force frontmost, accept `View > Developer` paths, retry.
6. **WeChat search sent to the wrong person**: Return opens a web search and the arrow keys select network results. →
   `computer_message` is two-phase; the model picks the row from a screenshot.
7. **`-1719` when a browser has no window**: → return an empty tab list and say to run `action=open` first.
8. **Windows helper: `OpenClipboard` was declared as returning `IntPtr` and used as a boolean** (a C# compile error) →
   declared as `bool`. Also added a minimised-window guard and a UIPI hint for SendInput failures.

---

## Uninstall

```sh
sh scripts/uninstall-local.sh [profile]                                          # macOS
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-local.ps1   # Windows
```

Removes the plugin directory and the loader row (the original config is backed up).

## License

[MIT](LICENSE)
