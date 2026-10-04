/**
 * Windows adapter.
 *
 * Everything OS-level goes through `bin/dsh-input.exe`, a C# helper
 * (native/DshInput.cs) compiled at install time by scripts/build-helper.ps1 with
 * the .NET Framework compiler that ships with Windows. It posts real input via
 * SendInput, captures the screen with GDI+, enumerates windows, owns the
 * clipboard and activates windows — so the plugin needs no npm dependency and no
 * admin rights.
 *
 * PowerShell is used only for the `computer_ui` escape hatch and for `start`
 * based launching.
 */

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, shotsDir, truncate } from '../runtime.js';

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const inputBinary = join(packageRoot, 'bin', 'dsh-input.exe');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// low level
// ---------------------------------------------------------------------------

/** Run the compiled C# helper and parse its JSON reply. */
async function helper(command, args = [], options = {}) {
  if (!existsSync(inputBinary)) {
    throw new Error(
      `the Windows input helper is missing at ${inputBinary}; run scripts\\build-helper.ps1 (or scripts\\install-local.ps1) to build it`,
    );
  }
  const { stdout } = await run(inputBinary, [command, ...args], {
    timeoutMs: options.timeoutMs ?? 30000,
    signal: options.signal,
  });
  const text = stdout.trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { output: text };
  }
}

/** Run a PowerShell script. */
async function powershell(source, options = {}) {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', source],
    { timeoutMs: options.timeoutMs ?? 30000, signal: options.signal },
  );
  return stdout.trim();
}

/** `start` is a cmd builtin, which is the reliable way to launch by association. */
async function start(target, app, options = {}) {
  const args = ['/c', 'start', '', ...(app ? [app] : []), target];
  await run('cmd.exe', args, { timeoutMs: 20000, signal: options.signal });
  return target;
}

// ---------------------------------------------------------------------------
// clipboard (through the helper: no PowerShell encoding surprises)
// ---------------------------------------------------------------------------

async function readClipboard() {
  const result = await helper('clipboard-get', [], { timeoutMs: 15000 });
  return typeof result.text === 'string' ? result.text : '';
}

async function writeClipboard(text) {
  await helper('clipboard-set', ['--b64', Buffer.from(String(text), 'utf8').toString('base64')], { timeoutMs: 15000 });
  return true;
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

let shotCounter = 0;

async function capture({ target = 'screen', display, region, windowId, maxEdge = 1600 } = {}, options = {}) {
  await mkdir(shotsDir, { recursive: true });
  shotCounter += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(shotsDir, `shot-${stamp}-${shotCounter}.png`);
  const preview = maxEdge > 0 ? file.replace(/\.png$/, `-${maxEdge}.png`) : null;

  const args = ['--out', file, '--target', target];
  if (target === 'region') {
    if (!region || [region.x, region.y, region.width, region.height].some((value) => typeof value !== 'number')) {
      throw new Error('screenshot target "region" needs region {x, y, width, height} in screen pixels');
    }
    args.push('--region', `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}`);
  } else if (target === 'window') {
    if (typeof windowId !== 'number') throw new Error('screenshot target "window" needs a numeric window_id (see computer_app action "windows")');
    args.push('--window', String(windowId));
  } else if (typeof display === 'number' && display > 0) {
    args.push('--display', String(display));
  }
  if (preview !== null) args.push('--preview', preview, '--max-edge', String(maxEdge));

  const result = await helper('screenshot', args, { timeoutMs: 60000, signal: options.signal });
  return {
    path: result.path ?? file,
    previewPath: preview !== null && existsSync(preview) ? preview : null,
    pixels: { width: Number(result.width ?? 0), height: Number(result.height ?? 0) },
    frame: result.frame ?? null,
  };
}

async function check() {
  return helper('check', [], { timeoutMs: 20000 });
}

async function screens() {
  const status = await check();
  return status.screens ?? [];
}

async function windows() {
  const result = await helper('windows', [], { timeoutMs: 20000 });
  return (result.windows ?? []).filter((window) => window.title !== '');
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

const input = {
  async position(options = {}) {
    return helper('pos', [], options);
  },
  async move(x, y, options = {}) {
    return helper('move', [String(x), String(y)], options);
  },
  async click(x, y, options = {}) {
    const args = [];
    if (typeof x === 'number' && typeof y === 'number') args.push(String(x), String(y));
    args.push('--button', options.button ?? 'left', '--count', String(options.count ?? 1));
    return helper('click', args, options);
  },
  async drag(from, to, options = {}) {
    return helper('drag', [
      String(from.x), String(from.y), String(to.x), String(to.y),
      '--button', options.button ?? 'left', '--duration-ms', String(options.durationMs ?? 260),
    ], options);
  },
  async scroll(dx, dy, options = {}) {
    return helper('scroll', [String(dx), String(dy)], options);
  },
  async type(text, options = {}) {
    return helper('type', [
      '--b64', Buffer.from(String(text), 'utf8').toString('base64'),
      '--delay-ms', String(options.delayMs ?? 9),
    ], { timeoutMs: 120000, signal: options.signal });
  },
  async key(name, options = {}) {
    return helper('key', [name, '--repeat', String(options.repeat ?? 1), '--delay-ms', String(options.delayMs ?? 12)], options);
  },
  async chord(spec, options = {}) {
    return helper('chord', [spec], options);
  },
};
// ---------------------------------------------------------------------------
// apps
// ---------------------------------------------------------------------------

const APP_ALIASES = {
  wechat: 'WeChat', 微信: 'WeChat', weixin: 'WeChat', 'wechat': 'WeChat',
  qq: 'QQ',
  dingtalk: 'DingTalk', 钉钉: 'DingTalk',
  feishu: 'Feishu', 飞书: 'Feishu', lark: 'Feishu',
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  line: 'LINE',
  explorer: 'explorer', 资源管理器: 'explorer',
  terminal: 'WindowsTerminal', 终端: 'WindowsTerminal',
  powershell: 'powershell',
  cmd: 'cmd', 命令提示符: 'cmd',
  notepad: 'notepad', 记事本: 'notepad',
  calc: 'Calculator', 计算器: 'Calculator',
  chrome: 'chrome', 'google chrome': 'chrome',
  edge: 'msedge', 'microsoft edge': 'msedge',
  brave: 'brave',
  vivaldi: 'vivaldi',
  vscode: 'Code', 'visual studio code': 'Code',
};

const BROWSERS = {
  chrome: { app: 'chrome', exe: 'chrome' },
  edge: { app: 'msedge', exe: 'msedge' },
  brave: { app: 'brave', exe: 'brave' },
  vivaldi: { app: 'vivaldi', exe: 'vivaldi' },
};

function resolveApp(app) {
  if (typeof app !== 'string' || app.trim().length === 0) throw new Error('app must be a non-empty string');
  const key = app.trim();
  return APP_ALIASES[key.toLowerCase()] ?? APP_ALIASES[key] ?? key;
}

async function activate(app, options = {}) {
  const name = resolveApp(app);
  try {
    const result = await helper('activate', ['--app', name], { timeoutMs: 20000, signal: options.signal });
    if (options.waitMs) await sleep(options.waitMs);
    return result.app ?? name;
  } catch (error) {
    if (options.noLaunch === true) throw error;
    // The helper only raises an existing window. `computer_app action=open`
    // means "start it if needed", so launch by name and try once more.
    await start(name, null, options).catch(() => {});
    await sleep(options.launchWaitMs ?? 1200);
    try {
      const retry = await helper('activate', ['--app', name], { timeoutMs: 20000, signal: options.signal });
      if (options.waitMs) await sleep(options.waitMs);
      return retry.app ?? name;
    } catch {
      throw new Error(
        `${name} is not running and could not be launched by name: ${error instanceof Error ? error.message : String(error)}. ` +
        'Use computer_app action=open_target with the full path of the executable, or start it yourself first.',
      );
    }
  }
}

async function quit(app, options = {}) {
  const name = resolveApp(app);
  const args = ['--app', name];
  if (options.force === true) args.push('--force');
  await helper('close', args, { timeoutMs: 20000, signal: options.signal });
  return name;
}

async function list(options = {}) {
  const result = await helper('list', [], { timeoutMs: 20000, signal: options.signal });
  return (result.apps ?? []).map((entry) => ({ name: entry.name, title: entry.title, pid: entry.pid }));
}

async function frontmost(options = {}) {
  const result = await helper('foreground', [], { timeoutMs: 15000, signal: options.signal });
  return { app: result.app ?? '', title: result.title ?? '', pid: result.pid };
}

async function openTarget(target, app, options = {}) {
  await start(target, app ? resolveApp(app) : null, options);
  return target;
}

function browserFor(key) {
  const browser = BROWSERS[String(key ?? 'chrome').toLowerCase()];
  if (!browser) {
    throw new Error(
      `unknown browser ${JSON.stringify(key)} on Windows; known: ${Object.keys(BROWSERS).join(', ')}. ` +
      'Safari and Arc are macOS-only.',
    );
  }
  return browser;
}

// ---------------------------------------------------------------------------
// browser — no scriptable dictionary on Windows, so this drives the real UI
// ---------------------------------------------------------------------------

async function focusBrowser(browser, options = {}) {
  await activate(browser.app, { waitMs: 400, signal: options.signal });
  return browser;
}

async function open(browserKey, url, options = {}) {
  const browser = browserFor(browserKey);
  try {
    await start(url, browser.exe, options);
  } catch {
    await start(url, null, options); // fall back to the default browser
  }
  return { browser: browser.app, url };
}

/**
 * Windows exposes no reliable cross-browser tab API without enabling Chrome
 * DevTools Protocol. The active tab is readable from the window title; the rest
 * is not, so this reports what it can instead of pretending.
 */
async function listTabs(browserKey, options = {}) {
  const browser = browserFor(browserKey);
  await focusBrowser(browser, options);
  const front = await frontmost(options);
  return [{ index: 1, title: front.title || '(untitled window)', url: null, active: true }];
}

async function activeTab(browserKey, options = {}) {
  const tabs = await listTabs(browserKey, options);
  return tabs[0] ?? null;
}

async function activateTab(browserKey, { index, match }, options = {}) {
  const browser = browserFor(browserKey);
  if (typeof match === 'string' && match.length > 0) {
    throw new Error('activate_tab by title is not supported on Windows (no tab API without Chrome DevTools Protocol); pass a 1-based index instead');
  }
  if (typeof index !== 'number' || index < 1 || index > 9) {
    throw new Error('on Windows activate_tab accepts an index from 1 to 9 (implemented as Ctrl+1…Ctrl+9)');
  }
  await focusBrowser(browser, options);
  await input.chord(`ctrl+${index}`, options);
  return { index };
}

async function closeTab(browserKey, options = {}) {
  const browser = browserFor(browserKey);
  await focusBrowser(browser, options);
  await input.chord('ctrl+w', options);
  return true;
}

async function runJavaScript() {
  throw new Error(
    'run_js is not available on Windows: Internet Explorer-style AppleScript does not exist and Chrome/Edge ' +
    'refuse to be scripted without the DevTools Protocol. Start the browser with --remote-debugging-port=9222 and ' +
    'drive it over CDP, or use computer_browser action=get_text, which reads the rendered page through Ctrl+A/Ctrl+C.',
  );
}

async function readTextViaClipboard(browserKey, options = {}) {
  const browser = browserFor(browserKey);
  await focusBrowser(browser, options);
  await input.chord('ctrl+a', options);
  await input.chord('ctrl+c', options);
  await sleep(400);
  return readClipboard();
}

const browser = {
  backend: 'keyboard',
  limited: true,
  jsHint: 'Not available on Windows without Chrome DevTools Protocol (--remote-debugging-port=9222). Use get_text instead.',
  list: Object.keys(BROWSERS),
  open,
  listTabs,
  activeTab,
  activateTab,
  closeTab,
  runJavaScript,
  readTextViaClipboard,
  javascriptError: (error) => error,
  isJavaScriptDisabled: () => false,
};

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

const MESSAGE_PRESETS = {
  WeChat: { searchChord: 'ctrl+f', sendKey: 'return', settleMs: 900 },
  QQ: { searchChord: 'ctrl+f', sendKey: 'return', settleMs: 900 },
  DingTalk: { searchChord: 'ctrl+k', sendKey: 'return', settleMs: 900 },
  Feishu: { searchChord: 'ctrl+k', sendKey: 'return', settleMs: 900 },
  Telegram: { searchChord: 'ctrl+f', sendKey: 'return', settleMs: 900 },
  Slack: { searchChord: 'ctrl+k', sendKey: 'return', settleMs: 900 },
  WhatsApp: { searchChord: 'ctrl+f', sendKey: 'return', settleMs: 800 },
};

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

export function createAdapter() {
  return {
    name: 'win32',
    label: 'Windows',
    capabilities: {
      permissions: false,
      menu: false,
      menuItems: false,
      hide: false,
      notify: true,
      browserTabs: false,
      browserJs: false,
      nativeHelper: 'csc',
      scriptLanguage: 'PowerShell',
    },
    // The helper is DPI aware, so a captured pixel IS the screen coordinate and
    // the reported DPI scale must not be divided out.
    coordinates: { unit: 'pixels', imageScale: 'identity' },
    input,
    screen: { check, screens, capture, windows },
    clipboard: { read: readClipboard, write: writeClipboard },
    apps: {
      aliases: APP_ALIASES,
      resolve: resolveApp,
      activate,
      quit,
      list,
      frontmost,
      windows,
      openTarget,
    },
    script: {
      language: 'PowerShell',
      run: async (source, options = {}) => powershell(source, options),
    },
    browser,
    permissions: {
      async status() {
        return {
          required: [],
          accessibility: true,
          screenRecording: true,
          hint: 'Windows needs no TCC grant. Note: a non-elevated process cannot send input to an elevated (Administrator) window — User Interface Privilege Isolation blocks it.',
        };
      },
      async request() {
        return { accessibility: true, screenRecording: true, requested: false };
      },
    },
    async notify(title, text, options = {}) {
      await helper('notify', ['--title', String(title), '--text', String(text)], { timeoutMs: 20000, signal: options.signal });
      return true;
    },
    messageApps: { aliases: APP_ALIASES, presets: MESSAGE_PRESETS },
    paths: { helper: inputBinary, packageRoot },
    helpers: { helper, powershell, start, sleep, truncate },
  };
}
