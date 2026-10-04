/**
 * Model-facing tool definitions for dsh-computer-control.
 *
 * Definitions are plain objects handed to `ctx.tools.register`, in the same
 * shape `defineTool` produces, so the plugin depends on nothing but Node
 * builtins and the OS's own tooling. Every OS-specific call goes through the
 * platform adapter (see ./platform/index.js), which is why the same nine tools
 * work on macOS and Windows.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { knownMessageApps, sendMessage } from './message.js';
import { assertAllowed, describePolicy, screen } from './policy.js';
import { loadConfig, truncate } from './runtime.js';

const object = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

const READ = 'read';
const EXECUTE = 'execute';

/** Attach a PNG through the harness attachment service when one is mounted. */
async function attachImage(ctx, file) {
  const attachments = ctx.get('attachments');
  if (!attachments || typeof attachments.saveImage !== 'function') return null;
  try {
    const data = await readFile(file);
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(file) });
    return {
      type: 'image',
      attachment: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      },
    };
  } catch {
    return null;
  }
}

/** A sentence the model should see when a permission is still missing. */
function permissionNote(status) {
  if (!status) return '';
  const missing = [];
  if (status.accessibility === false) missing.push('Accessibility (mouse/keyboard events are dropped without it)');
  if (status.screenRecording === false) missing.push('Screen Recording (screenshots show the wallpaper only without it)');
  if (missing.length === 0) return '';
  return `\n\n⚠️ Permissions still missing: ${missing.join('; ')}. ` +
    (status.hint ?? 'System Settings ▸ Privacy & Security → enable DeepSeek Harness for this app.');
}

function requirePoint(args, action) {
  if (typeof args.x !== 'number' || typeof args.y !== 'number') {
    throw new Error(`${action} needs numeric x and y in screen coordinates`);
  }
}

/**
 * Build the tool list for one platform.
 * @param {object} ctx - cordis context (provides the optional attachments service).
 * @param {object} adapter - the platform adapter.
 */
export function buildTools(ctx, adapter) {
  const config = () => loadConfig();
  const platform = adapter.label;
  const coordinates = adapter.coordinates ?? { unit: 'pixels', imageScale: 'identity' };
  const unit = coordinates.unit;
  // Retina screenshots are 2x the coordinate grid; a DPI-aware Windows capture
  // is already 1:1. Telling the model the wrong one makes every click miss.
  const coordinateRule = coordinates.imageScale === 'divide'
    ? `divide measured image pixels by \`scale\` to get screen ${unit}`
    : 'image pixels already equal screen coordinates, so use them directly and do NOT divide by scale (scale is informational)';
  const chordExample = adapter.name === 'darwin' ? 'cmd+c' : 'ctrl+c';
  const searchApps = knownMessageApps(adapter, {});
  const scriptLanguage = adapter.script.language;
  const browserNames = adapter.browser.list;
  const browserDefault = browserNames[0];

  return [
    // -----------------------------------------------------------------------
    {
      name: 'computer_screenshot',
      description:
        `Capture what is on the ${platform} screen and look at it. Use this before clicking anything you cannot see. ` +
        `Coordinates reported in ${unit} match computer_mouse; the attached image may be downscaled — ${coordinateRule}.` +
        (adapter.name === 'darwin' ? ' Requires the Screen Recording permission.' : ''),
      parameters: object({
        target: { type: 'string', enum: ['screen', 'region', 'window'], description: 'screen (default) | region | window.' },
        display: {
          type: 'integer',
          description: adapter.name === 'darwin'
            ? '1-based display index for target=screen; omit to use the system default capture.'
            : '1-based display index for target=screen; omit to capture the primary display.',
        },
        region: object({
          x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
        }, ['x', 'y', 'width', 'height']),
        window_id: { type: 'integer', description: 'Window id from computer_app action "windows" (target=window).' },
        attach: { type: 'boolean', description: 'Attach the image itself to the result. Default true.' },
        max_edge: { type: 'integer', description: 'Max pixel edge of the attached preview. Default 1600, 0 disables downscaling.' },
      }, []),
      output: {
        schema: object({
          path: { type: 'string' },
          previewPath: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          scale: { type: 'number' },
          attached: { type: 'boolean' },
          note: { type: 'string' },
          image: { type: 'object', additionalProperties: true },
        }, ['path', 'width', 'height', 'scale', 'attached']),
        render: (_args, value) => {
          const blocks = [{
            type: 'text',
            text: `<screenshot>\n<path>${value.path}</path>\n<details>${value.width}x${value.height} px${value.previewPath ? `, preview ${value.previewPath}` : ''}, screen scale ${value.scale}x, attached image: ${value.attached ? 'yes' : 'no'}</details>\n</screenshot>${value.note ?? ''}`,
          }];
          if (value.image) blocks.push({ type: 'image', attachment: { ...value.image.attachment } });
          return blocks;
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cfg = await config();
        const status = await adapter.screen.check().catch(() => ({ screens: [] }));
        const capture = await adapter.screen.capture({
          target: args.target ?? 'screen',
          display: args.display,
          region: args.region,
          windowId: args.window_id,
          maxEdge: args.max_edge ?? cfg.maxScreenshotEdge,
        }, { signal: exec?.signal });

        let attached = false;
        let image = null;
        if (args.attach !== false) {
          image = await attachImage(ctx, capture.previewPath ?? capture.path);
          attached = image !== null;
        }
        const screens = status.screens ?? [];
        const active = screens[args.display ? args.display - 1 : 0] ?? screens[0] ?? {};
        const scale = active.scale ?? 1;
        const note = [
          `Screen geometry: origin top-left, ${screens[0]?.width ?? '?'}x${screens[0]?.height ?? '?'} ${unit}, scale ${scale}x.`,
          coordinates.imageScale === 'divide'
            ? `Mouse coordinates are in ${unit}: image_pixel / scale.`
            : `Mouse coordinates are in ${unit} and equal image pixels: use image_pixel directly, do not divide by scale.`,
          permissionNote(status),
        ].join(' ');
        return {
          path: capture.path,
          ...(capture.previewPath ? { previewPath: capture.previewPath } : {}),
          width: capture.pixels.width,
          height: capture.pixels.height,
          scale,
          attached,
          note,
          ...(image ? { image } : {}),
        };
      },
      presentCall: (args) => ({ card: 'generic', title: `Screenshot ${args.target ?? 'screen'}`, kind: READ }),
    },

    // -----------------------------------------------------------------------
    {
      name: 'computer_mouse',
      description:
        `Move the real mouse, click, drag and scroll on ${platform}. Coordinates are screen ${unit} with the origin at ` +
        'the top-left of the main display (what computer_screenshot reports). Prefer clicking something you can see in a ' +
        'fresh screenshot; after acting, take another screenshot to confirm.',
      parameters: object({
        action: {
          type: 'string',
          enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'position'],
          description: 'What to do.',
        },
        x: { type: 'number', description: 'Target x in screen coordinates (move/click/drag start).' },
        y: { type: 'number', description: 'Target y in screen coordinates.' },
        to_x: { type: 'number', description: 'Drag end x.' },
        to_y: { type: 'number', description: 'Drag end y.' },
        dx: { type: 'number', description: 'Horizontal scroll delta (positive = right).' },
        dy: {
          type: 'number',
          description: adapter.name === 'darwin'
            ? 'Vertical scroll delta in pixels (positive = up). Use a negative value for page-down.'
            : 'Vertical scroll delta in wheel units (120 = one notch, positive = up). Use a negative value for page-down.',
        },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default left.' },
        count: { type: 'integer', description: 'Click count. Default 1 (double_click means 2).' },
        duration_ms: { type: 'integer', description: 'Drag duration in milliseconds. Default 260.' },
      }, ['action']),
      output: {
        schema: object({
          action: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          detail: { type: 'string' },
        }, ['action', 'x', 'y']),
        render: (_args, value) => [{ type: 'text', text: `mouse ${value.action} → (${Math.round(value.x)}, ${Math.round(value.y)})${value.detail ? ` ${value.detail}` : ''}` }],
      },
      async execute(args, exec) {
        const signal = exec?.signal;
        switch (args.action) {
          case 'position': {
            const at = await adapter.input.position({ signal });
            return { action: 'position', x: at.x, y: at.y, detail: '' };
          }
          case 'move': {
            requirePoint(args, 'move');
            const at = await adapter.input.move(args.x, args.y, { signal });
            return { action: 'move', x: at.x ?? args.x, y: at.y ?? args.y, detail: '' };
          }
          case 'scroll': {
            const dx = args.dx ?? 0;
            const dy = args.dy ?? 0;
            const at = await adapter.input.position({ signal });
            await adapter.input.scroll(dx, dy, { signal });
            return { action: 'scroll', x: at.x, y: at.y, detail: `dx=${dx} dy=${dy}` };
          }
          case 'drag': {
            if (typeof args.to_x !== 'number' || typeof args.to_y !== 'number') throw new Error('drag needs to_x and to_y');
            requirePoint(args, 'drag');
            await adapter.input.drag({ x: args.x, y: args.y }, { x: args.to_x, y: args.to_y }, {
              button: args.button ?? 'left',
              durationMs: args.duration_ms ?? 260,
              signal,
            });
            return { action: 'drag', x: args.to_x, y: args.to_y, detail: `from (${Math.round(args.x)}, ${Math.round(args.y)})` };
          }
          default: {
            requirePoint(args, args.action);
            const button = args.action === 'right_click' ? 'right' : (args.action === 'middle_click' ? 'middle' : (args.button ?? 'left'));
            const count = args.count ?? (args.action === 'double_click' ? 2 : 1);
            const at = await adapter.input.click(args.x, args.y, { button, count, signal });
            return { action: args.action, x: at.x ?? args.x, y: at.y ?? args.y, detail: `${button} ×${count}` };
          }
        }
      },
      presentCall: (args) => ({ card: 'generic', title: `Mouse ${args.action}`, kind: EXECUTE }),
    },

    // -----------------------------------------------------------------------
    {
      name: 'computer_keyboard',
      description:
        `Type text and press keys on ${platform}. \`type\` inserts arbitrary Unicode (CJK included) straight into the ` +
        'focused field, bypassing the input method. `key` presses one named key (return, tab, escape, up, f5, …). ' +
        `\`hotkey\` presses a chord such as ${chordExample}. Focus the target window first (computer_app action activate).`,
      parameters: object({
        action: { type: 'string', enum: ['type', 'key', 'hotkey'], description: 'What to do.' },
        text: { type: 'string', description: 'Text for action=type.' },
        key: { type: 'string', description: 'Key name for action=key (return, tab, escape, space, delete, up/down/left/right, f1..f12, a..z, 0..9).' },
        chord: {
          type: 'string',
          description: `Chord for action=hotkey, e.g. "${chordExample}". ` +
            (adapter.name === 'win32' ? 'Modifiers: ctrl, alt, shift, cmd (Windows key).' : 'Modifiers: cmd, shift, option, control.'),
        },
        repeat: { type: 'integer', description: 'Repeat count. Default 1.' },
        delay_ms: { type: 'integer', description: 'Delay between repeats in milliseconds.' },
      }, ['action']),
      output: {
        schema: object({
          action: { type: 'string' },
          detail: { type: 'string' },
        }, ['action', 'detail']),
        render: (_args, value) => [{ type: 'text', text: `keyboard ${value.action}: ${value.detail}` }],
      },
      async execute(args, exec) {
        const cfg = await config();
        const signal = exec?.signal;
        if (args.action === 'type') {
          if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('type needs a non-empty text');
          assertAllowed(cfg, { kind: 'text', value: args.text, what: 'typed text' });
          const repeat = Math.max(1, args.repeat ?? 1);
          for (let index = 0; index < repeat; index += 1) {
            await adapter.input.type(args.text, { delayMs: cfg.typeChunkDelayMs ?? 9, signal });
          }
          return { action: 'type', detail: `${args.text.length} characters${repeat > 1 ? ` ×${repeat}` : ''}` };
        }
        if (args.action === 'key') {
          if (typeof args.key !== 'string') throw new Error('key needs a key name');
          const repeat = Math.max(1, args.repeat ?? 1);
          await adapter.input.key(args.key, { repeat, delayMs: args.delay_ms ?? cfg.typeChunkDelayMs, signal });
          return { action: 'key', detail: `${args.key}${repeat > 1 ? ` ×${repeat}` : ''}` };
        }
        if (typeof args.chord !== 'string' || !args.chord.includes('+')) throw new Error(`hotkey needs a chord such as "${chordExample}"`);
        const repeat = Math.max(1, args.repeat ?? 1);
        for (let index = 0; index < repeat; index += 1) {
          await adapter.input.chord(args.chord, { signal });
        }
        return { action: 'hotkey', detail: args.chord };
      },
      presentCall: (args) => ({ card: 'generic', title: `Keyboard ${args.action}`, kind: EXECUTE }),
    },

    // -----------------------------------------------------------------------
    {
      name: 'computer_clipboard',
      description:
        'Read or write the clipboard. Pasting through the clipboard is far more reliable than typing for long or ' +
        `non-ASCII text (${adapter.name === 'darwin' ? '⌘V' : 'Ctrl+V'}).`,
      parameters: object({
        action: { type: 'string', enum: ['read', 'write'], description: 'What to do.' },
        text: { type: 'string', description: 'Text to place on the clipboard for action=write.' },
      }, ['action']),
      output: {
        schema: object({
          action: { type: 'string' },
          text: { type: 'string' },
          length: { type: 'integer' },
        }, ['action', 'text', 'length']),
        render: (_args, value) => [{
          type: 'text',
          text: value.action === 'read'
            ? `clipboard (${value.length} chars):\n${truncate(value.text, 4000)}`
            : `clipboard set (${value.length} chars)`,
        }],
      },
      async execute(args) {
        const cfg = await config();
        if (args.action === 'read') {
          const text = await adapter.clipboard.read();
          return { action: 'read', text, length: text.length };
        }
        if (typeof args.text !== 'string') throw new Error('write needs text');
        assertAllowed(cfg, { kind: 'text', value: args.text, what: 'clipboard text' });
        await adapter.clipboard.write(args.text);
        return { action: 'write', text: args.text, length: args.text.length };
      },
      presentCall: (args) => ({ card: 'generic', title: `Clipboard ${args.action}`, kind: args.action === 'read' ? READ : EXECUTE }),
    },

    // -----------------------------------------------------------------------
    {
      name: 'computer_app',
      description:
        `Work with applications on ${platform}: launch or focus one, quit it, list what is running, list windows ` +
        '(window ids feed computer_screenshot), open a file/folder/URL, or click a menu item. ' +
        (adapter.capabilities.menu ? 'Menu paths accept nested levels separated by ">", e.g. "View > Developer". ' : 'Menu scripting is not available on this OS. ') +
        (adapter.name === 'darwin'
          ? 'Aliases such as 微信, chrome and vscode are understood.'
          : 'Aliases such as 微信, chrome and 记事本 are understood.'),
      parameters: object({
        action: {
          type: 'string',
          enum: [
            'open', 'activate', 'quit', ...(adapter.capabilities.hide === false ? [] : ['hide']),
            'list', 'windows', 'frontmost', 'open_target', ...(adapter.capabilities.menu ? ['menu'] : []),
          ],
          description: 'open/activate launch or focus an app; open_target opens a file, folder or URL.',
        },
        app: { type: 'string', description: 'Application name or alias, e.g. WeChat, 微信, Google Chrome, Finder, 记事本.' },
        target: { type: 'string', description: 'File path, folder path or URL for action=open_target.' },
        menu: { type: 'string', description: 'Menu path for action=menu; nested levels separated by ">", e.g. "View > Developer".' },
        item: { type: 'string', description: 'Menu item title for action=menu.' },
      }, ['action']),
      output: {
        schema: object({
          action: { type: 'string' },
          result: { type: 'string' },
        }, ['action', 'result']),
        render: (_args, value) => [{ type: 'text', text: value.result }],
      },
      async execute(args, exec) {
        const cfg = await config();
        const signal = exec?.signal;
        switch (args.action) {
          case 'open':
          case 'activate': {
            const name = await adapter.apps.activate(args.app, { waitMs: 600, signal });
            return { action: args.action, result: `activated ${name}` };
          }
          case 'quit': {
            if (typeof adapter.apps.quit !== 'function') throw new Error(`quitting an app is not supported on ${platform}`);
            return { action: 'quit', result: `quit ${await adapter.apps.quit(args.app, { signal })}` };
          }
          case 'hide': {
            if (typeof adapter.apps.hide !== 'function') throw new Error(`hiding an app is not supported on ${platform}; there is no equivalent primitive here`);
            return { action: 'hide', result: `hid ${await adapter.apps.hide(args.app, { signal })}` };
          }
          case 'list': {
            const apps = await adapter.apps.list({ signal });
            const text = apps.map((entry) => (entry.title ? `${entry.name} — ${entry.title}` : entry.name)).join(', ');
            return { action: 'list', result: truncate(text, 6000) || 'no windowed applications' };
          }
          case 'frontmost': {
            const front = await adapter.apps.frontmost({ signal });
            return { action: 'frontmost', result: front.title ? `${front.app} — ${front.title}` : front.app };
          }
          case 'windows': {
            const windows = await adapter.apps.windows({ signal });
            const lines = windows.map((window) => `id=${window.id} app=${window.app} title=${JSON.stringify(window.title)} bounds=${Math.round(window.x)},${Math.round(window.y)},${Math.round(window.width)}x${Math.round(window.height)}`);
            return { action: 'windows', result: lines.length > 0 ? lines.join('\n') : 'no on-screen windows' };
          }
          case 'open_target': {
            if (typeof args.target !== 'string' || args.target.length === 0) throw new Error('open_target needs a target');
            assertAllowed(cfg, { kind: 'url', value: args.target, what: 'target' });
            await adapter.apps.openTarget(args.target, args.app, { signal });
            return { action: 'open_target', result: `opened ${args.target}${args.app ? ` with ${adapter.apps.resolve(args.app)}` : ''}` };
          }
          case 'menu': {
            if (typeof adapter.apps.menu !== 'function') throw new Error(`${platform} has no scriptable menu bar; drive the visible menu with computer_mouse / computer_keyboard instead`);
            if (!args.app || !args.menu || !args.item) throw new Error('menu needs app, menu and item');
            assertAllowed(cfg, { kind: 'menu', value: `${args.menu} ${args.item}`, what: 'menu item' });
            const clicked = await adapter.apps.menu(args.app, args.menu, args.item, { signal });
            return { action: 'menu', result: `clicked ${clicked.menu} ▸ ${clicked.item} in ${clicked.app}` };
          }
          default:
            throw new Error(`unsupported action ${args.action}`);
        }
      },
      presentCall: (args) => ({ card: 'generic', title: `App ${args.action}`, kind: args.action === 'list' || args.action === 'windows' ? READ : EXECUTE }),
    },

    // -----------------------------------------------------------------------
    {
      name: 'computer_message',
      description:
        `Send a chat message through a messaging app on ${platform} by driving its own search box ` +
        `(${searchApps.join(', ')}). TWO PHASES, because search dropdowns are app-specific: (1) call without ` +
        '`result_point` — it activates the app, searches the contact and returns a screenshot of the dropdown without ' +
        'sending anything; (2) call again with `result_point` (the {x,y} of the right row in that screenshot, plus ' +
        '`input_point` if the message box is not focused) — it clicks that row, pastes the text and sends. Never guess ' +
        'coordinates: look at the screenshot first.',
      parameters: object({
        app: { type: 'string', description: 'Messaging app name or alias, e.g. WeChat / 微信 / DingTalk.' },
        to: { type: 'string', description: 'Contact or chat name to search for.' },
        text: { type: 'string', description: 'Message body.' },
        send: { type: 'boolean', description: 'Press the send key after filling the box. Default true.' },
        search_chord: { type: 'string', description: `Override the search shortcut, e.g. "${adapter.name === 'darwin' ? 'cmd+f' : 'ctrl+f'}".` },
        send_key: { type: 'string', description: 'Override the send key. Default "return".' },
        settle_ms: { type: 'integer', description: 'Wait between steps in milliseconds. Raise it on slow machines.' },
        result_point: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          description: 'Screen point of the search result row to open, read off the screenshot from phase 1. Omit to stay in phase 1 (nothing is sent).',
        },
        input_point: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          description: 'Screen point of the message input box, when the app does not focus it after opening the chat.',
        },
      }, ['app', 'to', 'text']),
      output: {
        schema: object({
          app: { type: 'string' },
          to: { type: 'string' },
          sent: { type: 'boolean' },
          steps: { type: 'string' },
          needsResult: { type: 'boolean' },
          image: { type: 'object', additionalProperties: true },
        }, ['app', 'to', 'sent', 'steps', 'needsResult']),
        render: (_args, value) => {
          const blocks = [{
            type: 'text',
            text: value.needsResult
              ? `phase 1 done: ${value.app} is showing search results for ${value.to}; NOTHING was sent.\n` +
                'Check the screenshot, then call computer_message again with result_point at the row of the right chat ' +
                '(and input_point if the message box is not focused).\n' +
                `flow: ${value.steps}`
              : `${value.sent ? 'sent' : 'pasted (not sent)'} to ${value.to} in ${value.app}\nflow: ${value.steps}`,
          }];
          if (value.image) blocks.push({ type: 'image', attachment: { ...value.image.attachment } });
          return blocks;
        },
      },
      async execute(args, exec) {
        const cfg = await config();
        assertAllowed(cfg, { kind: 'message', value: args.text, what: 'message body' });
        assertAllowed(cfg, { kind: 'message', value: args.to, what: 'contact name' });
        const overrides = {};
        if (args.search_chord) overrides.searchChord = args.search_chord;
        if (args.send_key) overrides.sendKey = args.send_key;
        if (typeof args.settle_ms === 'number') overrides.settleMs = args.settle_ms;

        const result = await sendMessage(adapter, null, cfg, {
          app: args.app,
          to: args.to,
          text: args.text,
          send: args.send !== false,
          resultPoint: args.result_point,
          inputPoint: args.input_point,
          overrides,
          signal: exec?.signal,
        });

        let image = null;
        if (result.needsResult || result.sent) {
          const capture = await adapter.screen.capture({ target: 'screen', maxEdge: 1400 }, { signal: exec?.signal });
          image = await attachImage(ctx, capture.previewPath ?? capture.path);
        }
        return {
          app: result.app,
          to: result.to,
          sent: result.sent,
          steps: result.steps.join(' → '),
          needsResult: result.needsResult === true,
          ...(image ? { image } : {}),
        };
      },
      presentCall: (args) => ({ card: 'generic', title: `Message ${args.to} via ${args.app}`, kind: EXECUTE }),
    },

    // -----------------------------------------------------------------------
    {
      name: 'computer_browser',
      description:
        `Drive a real browser on ${platform} (${browserNames.join(', ')}). ` +
        (adapter.browser.backend === 'applescript'
          ? 'Open URLs, list or switch tabs, read the page text/HTML, or run JavaScript in the active tab. Reading text ' +
            'and running JavaScript may require enabling "Allow JavaScript from Apple Events" in the browser\'s Develop menu. '
          : 'Open URLs, switch or close tabs by keyboard, and read the page text through the clipboard. Run JavaScript ' +
            'only after starting the browser with the DevTools Protocol enabled. Tab listing reports the active tab only. ') +
        'Browsing and adding to cart are allowed; checkout and payment are blocked by policy.',
      parameters: object({
        action: {
          type: 'string',
          enum: ['open', 'list_tabs', 'active_tab', 'get_text', 'get_html', 'run_js', 'activate_tab', 'close_tab', 'reload', 'back', 'wait'],
          description: 'What to do.',
        },
        browser: { type: 'string', enum: browserNames, description: `Which browser. Default ${browserDefault}.` },
        url: { type: 'string', description: 'URL for action=open.' },
        javascript: { type: 'string', description: 'JavaScript source for action=run_js (single expression or statements).' },
        index: { type: 'integer', description: '1-based tab index for action=activate_tab.' },
        match: { type: 'string', description: 'Title or URL substring for action=activate_tab.' },
        max_chars: { type: 'integer', description: 'Truncate get_text/get_html to this many characters. Default 20000.' },
        wait_ms: { type: 'integer', description: 'Milliseconds to sleep for action=wait (max 30000).' },
      }, ['action']),
      output: {
        schema: object({
          action: { type: 'string' },
          result: { type: 'string' },
        }, ['action', 'result']),
        render: (_args, value) => [{ type: 'text', text: `browser ${value.action}:\n${value.result}` }],
      },
      async execute(args, exec) {
        const cfg = await config();
        const signal = exec?.signal;
        const browser = args.browser ?? browserDefault;
        const limit = args.max_chars ?? 20000;
        const tabsLimited = adapter.browser.limited === true;
        try {
          switch (args.action) {
            case 'open': {
              if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('open needs a url');
              assertAllowed(cfg, { kind: 'url', value: args.url, what: 'URL' });
              const opened = await adapter.browser.open(browser, args.url, { signal });
              return { action: 'open', result: `opened ${opened.url} in ${opened.browser}` };
            }
            case 'list_tabs': {
              const tabs = await adapter.browser.listTabs(browser, { signal });
              const lines = tabs.map((tab) => `${tab.active ? '*' : ' '} [${tab.index}] ${tab.title ?? '(untitled)'}${tab.url ? ` — ${tab.url}` : ''}`);
              return {
                action: 'list_tabs',
                result: (lines.join('\n') || 'no tabs') +
                  (tabsLimited ? '\n(note: this platform exposes only the active tab without the Chrome DevTools Protocol)' : ''),
              };
            }
            case 'active_tab': {
              const tab = await adapter.browser.activeTab(browser, { signal });
              return { action: 'active_tab', result: tab ? `[${tab.index}] ${tab.title}${tab.url ? `\n${tab.url}` : ''}` : 'no active tab' };
            }
            case 'get_text': {
              if (adapter.browser.backend !== 'applescript') {
                const text = await adapter.browser.readTextViaClipboard(browser, { signal });
                return { action: 'get_text', result: `${truncate(text, limit)}\n\n(note: read with the select-all/copy shortcut; the clipboard was overwritten.)` };
              }
              try {
                const text = await adapter.browser.runJavaScript(browser, 'document.body ? document.body.innerText : ""', { signal });
                return { action: 'get_text', result: truncate(String(text), limit) };
              } catch (error) {
                if (!adapter.browser.isJavaScriptDisabled(error)) throw error;
                const text = await adapter.browser.readTextViaClipboard(browser, { signal });
                return {
                  action: 'get_text',
                  result: `${truncate(text, limit)}\n\n(note: read with ⌘A/⌘C because Apple Events JavaScript is off in ${browser}; the clipboard was overwritten. Enable it to get cleaner text.)`,
                };
              }
            }
            case 'get_html': {
              const html = await adapter.browser.runJavaScript(browser, 'document.documentElement.outerHTML', { signal });
              return { action: 'get_html', result: truncate(String(html), limit) };
            }
            case 'run_js': {
              if (typeof args.javascript !== 'string' || args.javascript.length === 0) throw new Error('run_js needs javascript');
              assertAllowed(cfg, { kind: 'javascript', value: args.javascript, what: 'JavaScript' });
              const value = await adapter.browser.runJavaScript(browser, args.javascript, { signal });
              return { action: 'run_js', result: truncate(String(value), limit) };
            }
            case 'activate_tab': {
              await adapter.browser.activateTab(browser, { index: args.index, match: args.match }, { signal });
              const tab = await adapter.browser.activeTab(browser, { signal });
              return { action: 'activate_tab', result: tab ? `active [${tab.index}] ${tab.title}` : 'switched' };
            }
            case 'close_tab': {
              await adapter.browser.closeTab(browser, { signal });
              return { action: 'close_tab', result: 'closed active tab' };
            }
            case 'reload': {
              if (adapter.browser.backend === 'applescript') {
                await adapter.browser.runJavaScript(browser, 'location.reload()', {});
              } else {
                await adapter.apps.activate(browser, { waitMs: 300, signal });
                await adapter.input.chord('ctrl+r', { signal });
              }
              return { action: 'reload', result: 'reloading' };
            }
            case 'back': {
              if (adapter.browser.backend === 'applescript') {
                await adapter.browser.runJavaScript(browser, 'history.back()', {});
              } else {
                await adapter.apps.activate(browser, { waitMs: 300, signal });
                await adapter.input.chord('alt+left', { signal });
              }
              return { action: 'back', result: 'went back' };
            }
            case 'wait': {
              const ms = Math.min(Math.max(args.wait_ms ?? cfg.defaultWaitMs, 0), 30000);
              await new Promise((resolve) => setTimeout(resolve, ms));
              return { action: 'wait', result: `waited ${ms}ms` };
            }
            default:
              throw new Error(`unsupported action ${args.action}`);
          }
        } catch (error) {
          throw adapter.browser.javascriptError(error);
        }
      },
      presentCall: (args) => ({ card: 'generic', title: `Browser ${args.action}`, kind: EXECUTE }),
    },

    // -----------------------------------------------------------------------
    {
      name: 'computer_ui',
      description:
        `Escape hatch for anything the other tools do not cover, using ${scriptLanguage} on ${platform}. ` +
        (adapter.name === 'darwin'
          ? 'Sample: tell application "System Events" to keystroke "hi". '
          : 'Windows has no scriptable menu bar, so drive visible menus with computer_mouse / computer_keyboard. ') +
        'Actions that steer towards checkout or payment are refused before the script runs.',
      parameters: object({
        action: {
          type: 'string',
          enum: ['script', 'frontmost', 'notify', ...(adapter.capabilities.menuItems ? ['menu_items'] : [])],
          description: 'What to do.',
        },
        script: { type: 'string', description: `${scriptLanguage} source for action=script.` },
        app: { type: 'string', description: 'Application name for action=menu_items.' },
        menu: { type: 'string', description: 'Menu bar title for action=menu_items.' },
        title: { type: 'string', description: 'Notification title for action=notify.' },
        text: { type: 'string', description: 'Notification body for action=notify.' },
        timeout_ms: { type: 'integer', description: 'Script timeout in milliseconds. Default 30000.' },
      }, ['action']),
      output: {
        schema: object({
          action: { type: 'string' },
          result: { type: 'string' },
        }, ['action', 'result']),
        render: (_args, value) => [{ type: 'text', text: `${scriptLanguage.toLowerCase()} ${value.action}:\n${value.result}` }],
      },
      async execute(args, exec) {
        const cfg = await config();
        const signal = exec?.signal;
        switch (args.action) {
          case 'script': {
            if (typeof args.script !== 'string' || args.script.trim().length === 0) throw new Error(`script needs ${scriptLanguage} source`);
            assertAllowed(cfg, { kind: 'script', value: args.script, what: scriptLanguage });
            const out = await adapter.script.run(args.script, { timeoutMs: args.timeout_ms ?? 30000, signal });
            return { action: 'script', result: truncate(out, 20000) || '(no output)' };
          }
          case 'frontmost': {
            const front = await adapter.apps.frontmost({ signal });
            return { action: 'frontmost', result: front.title ? `${front.app} — ${front.title}` : front.app };
          }
          case 'menu_items': {
            if (typeof adapter.apps.menuItems !== 'function') throw new Error(`${platform} has no scriptable menu bar`);
            if (!args.app || !args.menu) throw new Error('menu_items needs app and menu');
            const items = await adapter.apps.menuItems(args.app, args.menu, { signal });
            return { action: 'menu_items', result: items.join(' | ') };
          }
          case 'notify': {
            const title = args.title ?? 'DSH';
            const text = args.text ?? '';
            assertAllowed(cfg, { kind: 'text', value: `${title} ${text}`, what: 'notification' });
            await adapter.notify(title, text, { signal });
            return { action: 'notify', result: `notified: ${title}` };
          }
          default:
            throw new Error(`unsupported action ${args.action}`);
        }
      },
      presentCall: (args) => ({ card: 'generic', title: `${scriptLanguage} ${args.action}`, kind: EXECUTE }),
    },

    // -----------------------------------------------------------------------
    {
      name: 'computer_policy',
      description:
        'Show the computer-control safety policy (checkout/payment guard), the permissions this app still needs, the ' +
        'platform capabilities, and the screen geometry. The guard cannot be lifted from a tool call; only the human can ' +
        'edit ~/.dsh/computer-control/config.json.',
      parameters: object({
        action: { type: 'string', enum: ['status', 'check', 'environment'], description: 'status = policy; check = screen a string against the guard; environment = permissions and displays.' },
        value: { type: 'string', description: 'Text to screen for action=check.' },
      }, ['action']),
      output: {
        schema: object({
          action: { type: 'string' },
          result: { type: 'string' },
        }, ['action', 'result']),
        render: (_args, value) => [{ type: 'text', text: value.result }],
      },
      async execute(args) {
        const cfg = await loadConfig();
        if (args.action === 'check') {
          const verdict = screen(cfg, args.value ?? '');
          return { action: 'check', result: verdict.allowed ? 'allowed: no checkout/payment pattern matched' : `blocked: ${verdict.matched}` };
        }
        if (args.action === 'environment') {
          const status = await adapter.permissions.status();
          const screens = await adapter.screen.screens().catch(() => []);
          const lines = [
            `platform: ${adapter.label} (${adapter.name})`,
            `accessibility: ${status.accessibility ? 'granted' : 'MISSING'}`,
            `screen recording: ${status.screenRecording ? 'granted' : 'MISSING'}`,
            ...(screens ?? []).map((entry) => `display ${entry.index}: ${entry.width}x${entry.height} ${unit} (${entry.pixelsWide}x${entry.pixelsHigh} px, scale ${entry.scale}x) at (${entry.x}, ${entry.y})`),
            status.hint ?? '',
          ];
          return { action: 'environment', result: lines.filter(Boolean).join('\n') + permissionNote(status) };
        }
        const policy = describePolicy(cfg);
        const lines = [
          `platform: ${adapter.label} (${adapter.name}), helper: ${adapter.paths.helper}`,
          'browsing / adding to cart: allowed',
          `checkout: ${policy.allowCheckout ? 'ALLOWED (human enabled it)' : 'blocked'}`,
          `payment: ${policy.allowPayment ? 'ALLOWED (human enabled it)' : 'blocked'}`,
          `capabilities: menus=${adapter.capabilities.menu ? 'yes' : 'no'}, notifications=${adapter.capabilities.notify ? 'yes' : 'no'}, ` +
            `browser tabs=${adapter.capabilities.browserTabs ? 'yes' : 'active only'}, browser JS=${adapter.capabilities.browserJs ? 'yes' : 'no'}, ` +
            `script=${scriptLanguage}`,
          `config: ${policy.configPath}`,
          `message presets: ${searchApps.join(', ')}`,
          `browsers: ${browserNames.join(', ')}`,
          '',
          'blocked patterns:',
          ...policy.blockedPatterns.map((pattern) => `  - ${pattern}`),
        ];
        return { action: 'status', result: lines.join('\n') };
      },
      presentCall: () => ({ card: 'generic', title: 'Computer control policy', kind: READ }),
    },
  ];
}
