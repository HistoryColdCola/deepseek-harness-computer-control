/**
 * macOS adapter.
 *
 * Two mechanisms, both built into the OS:
 *   - `bin/dsh-input` (native/DshInput.swift), a tiny CoreGraphics helper that
 *     posts real mouse/keyboard events, enumerates windows and reports screen
 *     geometry. Built by scripts/build-helper.sh.
 *   - `osascript` for app activation, menus and the browser's AppleScript
 *     dictionary.
 */

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, shotsDir, truncate } from '../runtime.js';

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const inputBinary = join(packageRoot, 'bin', 'dsh-input');

// ---------------------------------------------------------------------------
// low level
// ---------------------------------------------------------------------------

/** Run the compiled Quartz helper and parse its JSON reply. */
async function helper(command, args = [], options = {}) {
  if (!existsSync(inputBinary)) {
    throw new Error(`the macOS input helper is missing at ${inputBinary}; run scripts/build-helper.sh (or scripts/install-local.sh) to build it`);
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

/** Run AppleScript source, returning its stdout. */
async function osascript(source, options = {}) {
  const { stdout } = await run('/usr/bin/osascript', ['-e', source], {
    timeoutMs: options.timeoutMs ?? 30000,
    signal: options.signal,
  });
  return stdout.trim();
}

const ESCAPES = new Map([['\\', '\\\\'], ['"', '\\"']]);

/** Quote a value as an AppleScript string literal. */
function asLiteral(value) {
  return `"${String(value).replace(/[\\"]/g, (char) => ESCAPES.get(char))}"`;
}

/** Collapse a multi-line script into one line for an AppleScript literal. */
function flattenScript(source) {
  return String(source).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Sleep helper. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

async function readClipboard() {
  const { stdout } = await run('/usr/bin/pbpaste', [], { timeoutMs: 10000 });
  return stdout;
}

async function writeClipboard(text) {
  await new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/pbcopy', [], { timeout: 10000 }, (error) => (error ? reject(error) : resolve()));
    child.stdin.end(String(text));
  });
  return true;
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

let shotCounter = 0;

async function imageSize(file) {
  try {
    const { stdout } = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeoutMs: 15000 });
    return {
      width: Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0),
      height: Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? 0),
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

async function capture({ target = 'screen', display, region, windowId, maxEdge = 1600 } = {}, options = {}) {
  await mkdir(shotsDir, { recursive: true });
  shotCounter += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(shotsDir, `shot-${stamp}-${shotCounter}.png`);
  const args = ['-x', '-t', 'png'];
  if (target === 'region') {
    if (!region || [region.x, region.y, region.width, region.height].some((value) => typeof value !== 'number')) {
      throw new Error('screenshot target "region" needs region {x, y, width, height} in screen points');
    }
    args.push('-R', `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}`);
  } else if (target === 'window') {
    if (typeof windowId !== 'number') throw new Error('screenshot target "window" needs a numeric window_id (see computer_app action "windows")');
    args.push('-o', '-l', String(windowId));
  } else if (typeof display === 'number' && display > 0) {
    args.push('-D', String(display));
  }
  args.push(file);
  await run('/usr/sbin/screencapture', args, { timeoutMs: 30000, signal: options.signal });

  const pixels = await imageSize(file);
  let previewPath = null;
  if (maxEdge > 0 && Math.max(pixels.width, pixels.height) > maxEdge) {
    const candidate = file.replace(/\.png$/, `-${maxEdge}.png`);
    await run('/usr/bin/sips', ['-Z', String(maxEdge), file, '--out', candidate], { timeoutMs: 30000, signal: options.signal })
      .then(() => { previewPath = candidate; })
      .catch(() => { previewPath = null; });
  }
  return { path: file, previewPath, pixels, frame: null };
}

/** Screen geometry, accessibility and screen-recording status. */
async function check() {
  return helper('check', [], { timeoutMs: 15000 });
}

async function screens() {
  const status = await check();
  return status.screens ?? [];
}

async function windows() {
  const result = await helper('windows', [], { timeoutMs: 15000 });
  return (result.windows ?? []).filter((window) => window.layer === 0 && window.title !== '');
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
  wechat: 'WeChat', 微信: 'WeChat', weixin: 'WeChat',
  qq: 'QQ',
  dingtalk: 'DingTalk', 钉钉: 'DingTalk',
  feishu: 'Feishu', 飞书: 'Feishu', lark: 'Feishu',
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  messages: 'Messages', imessage: 'Messages', 信息: 'Messages', 短信: 'Messages',
  whatsapp: 'WhatsApp',
  line: 'LINE',
  mail: 'Mail', 邮件: 'Mail',
  notes: 'Notes', 备忘录: 'Notes',
  reminders: 'Reminders', 提醒事项: 'Reminders',
  calendar: 'Calendar', 日历: 'Calendar',
  finder: 'Finder', 访达: 'Finder',
  terminal: 'Terminal', 终端: 'Terminal',
  safari: 'Safari',
  chrome: 'Google Chrome', 'google chrome': 'Google Chrome',
  edge: 'Microsoft Edge',
  brave: 'Brave Browser',
  arc: 'Arc',
  vscode: 'Visual Studio Code', 'visual studio code': 'Visual Studio Code',
  iterm: 'iTerm', iterm2: 'iTerm',
};

const BROWSERS = {
  chrome: { app: 'Google Chrome', family: 'chromium' },
  edge: { app: 'Microsoft Edge', family: 'chromium' },
  brave: { app: 'Brave Browser', family: 'chromium' },
  arc: { app: 'Arc', family: 'chromium' },
  vivaldi: { app: 'Vivaldi', family: 'chromium' },
  safari: { app: 'Safari', family: 'safari' },
};

function resolveApp(app) {
  if (typeof app !== 'string' || app.trim().length === 0) throw new Error('app must be a non-empty string');
  const key = app.trim();
  return APP_ALIASES[key.toLowerCase()] ?? APP_ALIASES[key] ?? key;
}

async function activate(app, options = {}) {
  const name = resolveApp(app);
  try {
    await run('/usr/bin/open', ['-a', name], { timeoutMs: 20000, signal: options.signal });
  } catch {
    await osascript(`tell application ${asLiteral(name)} to activate`, { timeoutMs: 20000, signal: options.signal });
  }
  // `open -a` is a request that a background caller's activation can lose.
  // System Events forces the issue, which menu scripting and typing need.
  try {
    await osascript(`tell application "System Events" to set frontmost of process ${asLiteral(name)} to true`, {
      timeoutMs: 10000,
      signal: options.signal,
    });
  } catch {
    /* the app may have no UI process; not fatal */
  }
  if (options.waitMs) await sleep(options.waitMs);
  return name;
}

async function quit(app, options = {}) {
  const name = resolveApp(app);
  await osascript(`tell application ${asLiteral(name)} to quit`, { timeoutMs: 20000, signal: options.signal });
  return name;
}

async function hide(app, options = {}) {
  const name = resolveApp(app);
  await osascript(`tell application "System Events" to set visible of process ${asLiteral(name)} to false`, {
    timeoutMs: 20000,
    signal: options.signal,
  });
  return name;
}

async function list(options = {}) {
  const out = await osascript(
    'tell application "System Events" to get name of every application process whose background only is false',
    { timeoutMs: 20000, signal: options.signal },
  );
  return out.split(',').map((name) => name.trim()).filter(Boolean).sort().map((name) => ({ name }));
}

async function frontmost(options = {}) {
  const name = await osascript(
    'tell application "System Events" to get name of first application process whose frontmost is true',
    { timeoutMs: 15000, signal: options.signal },
  );
  return { app: name, title: '' };
}

async function openTarget(target, app, options = {}) {
  const args = app ? ['-a', resolveApp(app), target] : [target];
  await run('/usr/bin/open', args, { timeoutMs: 20000, signal: options.signal });
  return target;
}

/**
 * AppleScript expression for the submenu a path points at.
 * `["View", "Developer"]` -> `menu 1 of menu item "Developer" of menu "View" of menu bar 1`.
 */
function menuPathExpression(menuPath) {
  const segments = String(menuPath).split(/\s*(?:>|▸|→|\/)\s*/).map((part) => part.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error('menu path is empty');
  let submenu = `menu ${asLiteral(segments[0])} of menu bar 1`;
  for (const segment of segments.slice(1)) {
    submenu = `menu 1 of menu item ${asLiteral(segment)} of ${submenu}`;
  }
  return submenu;
}

/** Retry a menu query: a freshly activated app may not expose its menu bar yet. */
async function menuScript(source, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(700);
    try {
      return await osascript(source, { timeoutMs: options.timeoutMs ?? 20000, signal: options.signal });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/Cannot get menu|-1728/.test(message)) throw error;
    }
  }
  throw lastError;
}

async function menu(app, menuPath, item, options = {}) {
  const name = await activate(app, { waitMs: 500, signal: options.signal });
  const submenu = menuPathExpression(menuPath);
  const source = [
    'tell application "System Events"',
    `  tell process ${asLiteral(name)}`,
    `    click menu item ${asLiteral(item)} of ${submenu}`,
    '  end tell',
    'end tell',
  ].join('\n');
  await menuScript(source, { signal: options.signal });
  return { app: name, menu: menuPath, item };
}

async function menuItems(app, menuPath, options = {}) {
  const name = await activate(app, { waitMs: 500, signal: options.signal });
  const submenu = menuPathExpression(menuPath);
  const source = [
    'tell application "System Events"',
    `  tell process ${asLiteral(name)}`,
    `    get name of every menu item of ${submenu}`,
    '  end tell',
    'end tell',
  ].join('\n');
  const out = await menuScript(source, { signal: options.signal });
  return out.split(',').map((entry) => entry.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------

function browserFor(key) {
  const browser = BROWSERS[String(key ?? 'chrome').toLowerCase()];
  if (!browser) throw new Error(`unknown browser ${JSON.stringify(key)}; known: ${Object.keys(BROWSERS).join(', ')}`);
  return browser;
}

function chromiumScript(app, body) {
  return ['tell application ' + asLiteral(app), body, 'end tell'].join('\n');
}

async function runJavaScript(browserKey, source, options = {}) {
  const browser = browserFor(browserKey);
  const script = flattenScript(source);
  if (browser.family === 'safari') {
    return osascript(chromiumScript(browser.app, `do JavaScript ${asLiteral(script)} in document 1`), {
      timeoutMs: options.timeoutMs ?? 30000,
      signal: options.signal,
    });
  }
  return osascript(chromiumScript(browser.app, `execute active tab of front window javascript ${asLiteral(script)}`), {
    timeoutMs: options.timeoutMs ?? 30000,
    signal: options.signal,
  });
}

/** Whether an error is the browser's "Apple Events JavaScript is off" refusal. */
function isJavaScriptDisabled(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Allow JavaScript from Apple Events|not allowed to send JavaScript|JavaScript.*turned off|JavaScript 的功能已关闭|执行 JavaScript 的功能已关闭/i.test(message);
}

function javascriptError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Allow JavaScript from Apple Events') || isJavaScriptDisabled(error)) {
    return new Error(
      `${message}\nEnable it in the browser: View ▸ Developer ▸ Allow JavaScript from Apple Events (Chrome/Edge/Brave), ` +
      'or Safari ▸ Develop ▸ Allow JavaScript from Apple Events (turn on the Develop menu in Settings ▸ Advanced first). ' +
      'Chrome may need a restart before the switch takes effect.',
    );
  }
  return error;
}

async function listTabs(browserKey, options = {}) {
  const browser = browserFor(browserKey);
  const body = browser.family === 'safari'
    ? [
        'set output to ""',
        'if (count of windows) = 0 then return output',
        'set activeIndex to index of current tab of front window',
        'set counter to 0',
        'repeat with t in tabs of front window',
        '  set counter to counter + 1',
        '  set output to output & counter & (character id 9) & (name of t) & (character id 9) & (URL of t) & (character id 9) & (counter = activeIndex) & linefeed',
        'end repeat',
        'return output',
      ].join('\n')
    : [
        'set output to ""',
        'if (count of windows) = 0 then return output',
        'set activeTab to active tab of front window',
        'set counter to 0',
        'repeat with t in tabs of front window',
        '  set counter to counter + 1',
        '  set output to output & counter & (character id 9) & (title of t) & (character id 9) & (URL of t) & (character id 9) & (t is activeTab) & linefeed',
        'end repeat',
        'return output',
      ].join('\n');
  const raw = await osascript(chromiumScript(browser.app, body), { timeoutMs: 20000, signal: options.signal }).catch((error) => {
    throw windowError(error, browserKey);
  });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, title, url, active] = line.split('\t');
      return { index: Number(index), title, url, active: /true/i.test(active ?? '') };
    });
}

async function activeTab(browserKey, options = {}) {
  const tabs = await listTabs(browserKey, options);
  return tabs.find((tab) => tab.active) ?? null;
}

/** Turn "window 1 does not exist" into an instruction the model can act on. */
function windowError(error, browserKey) {
  const message = error instanceof Error ? error.message : String(error);
  if (/-1719|invalid index|无效的索引|window 1/.test(message)) {
    return new Error(`${browserFor(browserKey).app} has no open window right now; run computer_browser action=open (or computer_app action=activate) first. Original error: ${message}`);
  }
  return error;
}

async function open(browserKey, url, options = {}) {
  const browser = browserFor(browserKey);
  await run('/usr/bin/open', ['-a', browser.app, url], { timeoutMs: 20000, signal: options.signal });
  return { browser: browser.app, url };
}

async function activateTab(browserKey, { index, match }, options = {}) {
  const browser = browserFor(browserKey);
  if (typeof index === 'number') {
    const body = browser.family === 'safari'
      ? `set current tab of front window to tab ${index} of front window`
      : `set active tab index of front window to ${index}`;
    await osascript(chromiumScript(browser.app, body), { timeoutMs: 20000, signal: options.signal }).catch((error) => {
      throw windowError(error, browserKey);
    });
    return { index };
  }
  if (typeof match === 'string' && match.length > 0) {
    const tabs = await listTabs(browserKey, options);
    const found = tabs.find((tab) => (tab.title ?? '').includes(match) || (tab.url ?? '').includes(match));
    if (!found) throw new Error(`no tab matching ${JSON.stringify(match)}; tabs: ${tabs.map((tab) => tab.title).join(' | ')}`);
    return activateTab(browserKey, { index: found.index }, options);
  }
  throw new Error('activate_tab needs either index or match');
}

async function closeTab(browserKey, options = {}) {
  const browser = browserFor(browserKey);
  const body = browser.family === 'safari'
    ? 'close current tab of front window'
    : 'close active tab of front window';
  await osascript(chromiumScript(browser.app, body), { timeoutMs: 20000, signal: options.signal }).catch((error) => {
    throw windowError(error, browserKey);
  });
  return true;
}

/** Read page text without Apple Events JavaScript: ⌘A / ⌘C through the clipboard. */
async function readTextViaClipboard(browserKey, options = {}) {
  const browser = browserFor(browserKey);
  await activate(browser.app, { waitMs: 500, signal: options.signal });
  await input.chord('cmd+a', { signal: options.signal });
  await input.chord('cmd+c', { signal: options.signal });
  await sleep(400);
  return readClipboard();
}

const browser = {
  backend: 'applescript',
  jsHint: 'Enable View ▸ Developer ▸ Allow JavaScript from Apple Events (Chrome/Edge/Brave) or Safari ▸ Develop ▸ Allow JavaScript from Apple Events; Chrome may need a restart.',
  list: Object.keys(BROWSERS),
  open,
  listTabs,
  activeTab,
  activateTab,
  closeTab,
  runJavaScript,
  readTextViaClipboard,
  javascriptError,
  isJavaScriptDisabled,
};

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

const MESSAGE_PRESETS = {
  WeChat: { searchChord: 'cmd+f', sendKey: 'return', settleMs: 900 },
  QQ: { searchChord: 'cmd+f', sendKey: 'return', settleMs: 900 },
  DingTalk: { searchChord: 'cmd+k', sendKey: 'return', settleMs: 900 },
  Feishu: { searchChord: 'cmd+k', sendKey: 'return', settleMs: 900 },
  Telegram: { searchChord: 'cmd+f', sendKey: 'return', settleMs: 900 },
  Slack: { searchChord: 'cmd+k', sendKey: 'return', settleMs: 900 },
  Messages: { searchChord: 'cmd+f', sendKey: 'return', settleMs: 700 },
  WhatsApp: { searchChord: 'cmd+f', sendKey: 'return', settleMs: 800 },
};

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

export function createAdapter() {
  return {
    name: 'darwin',
    label: 'macOS',
    capabilities: {
      permissions: true,
      menu: true,
      menuItems: true,
      notify: true,
      browserTabs: true,
      browserJs: true,
      nativeHelper: 'swiftc',
      scriptLanguage: 'AppleScript',
    },
    // Screenshots are 2x the point grid on a Retina display, so a measured
    // image pixel must be divided by the reported scale to get a coordinate.
    coordinates: { unit: 'points', imageScale: 'divide' },
    input,
    screen: { check, screens, capture, windows },
    clipboard: { read: readClipboard, write: writeClipboard },
    apps: {
      aliases: APP_ALIASES,
      resolve: resolveApp,
      activate,
      quit,
      hide,
      list,
      frontmost,
      windows,
      openTarget,
      menu,
      menuItems,
    },
    script: {
      language: 'AppleScript',
      run: async (source, options = {}) => osascript(source, options),
    },
    browser,
    permissions: {
      async status() {
        const status = await check();
        return {
          required: ['Accessibility', 'Screen Recording', 'Automation'],
          accessibility: status.accessibility === true,
          screenRecording: status.screenRecording === true,
          hint: 'System Settings ▸ Privacy & Security ▸ Accessibility / Screen Recording / Automation → enable DeepSeek Harness.',
        };
      },
      async request() {
        return helper('request', [], { timeoutMs: 60000 });
      },
    },
    async notify(title, text, options = {}) {
      await osascript(`display notification ${asLiteral(text)} with title ${asLiteral(title)}`, {
        timeoutMs: 10000,
        signal: options.signal,
      });
      return true;
    },
    messageApps: { aliases: APP_ALIASES, presets: MESSAGE_PRESETS },
    paths: { helper: inputBinary, packageRoot },
    helpers: { osascript, asLiteral, flattenScript, helper, sleep, truncate },
  };
}
