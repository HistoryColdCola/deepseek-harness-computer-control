/**
 * Self-test for dsh-computer-control.
 *
 * Two modes, and it can check the *other* platform's wiring without running it:
 *
 *   node scripts/selftest.mjs                        # this host: static + live
 *   CC_SELFTEST_OFFLINE=1 node scripts/selftest.mjs  # static only (CI, headless)
 *   CC_PLATFORM=win32 node scripts/selftest.mjs      # validate the Windows wiring
 *                                                    # from any host (never executes)
 *
 * Static mode verifies: the plugin loads, every tool registers, every JSON
 * Schema is inside the harness's supported subset, the platform adapter is
 * internally consistent, action enums match the platform's capabilities, and
 * the checkout/payment guard blocks what it should.
 *
 * Live mode additionally executes the read-only tools and checks their outputs
 * against their schemas (screenshots, pointer, policy, environment).
 */

import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

/** `CC_SELFTEST_OFFLINE=1` skips everything that needs a real desktop. */
const OFFLINE = process.env.CC_SELFTEST_OFFLINE === '1';
/** `CC_PLATFORM=win32|darwin` checks another platform's wiring statically. */
const TARGET = process.env.CC_PLATFORM ?? process.platform;
const NATIVE = TARGET === process.platform;

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- harness validators (borrowed from the installed profile) --------------
const validatorPath = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
let harness = null;
try {
  harness = await import(pathToFileURL(validatorPath).href);
} catch {
  harness = null;
}
console.log(`target platform: ${TARGET}${NATIVE ? ' (native)' : ' (static check only)'}`);
console.log(`live execution: ${NATIVE && !OFFLINE ? 'yes' : 'no'}`);
console.log(`harness schema validators: ${harness ? 'loaded' : 'unavailable (shape checks only)'}`);

// --- plugin + adapter ------------------------------------------------------
const plugin = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
const { selectAdapter, SUPPORTED } = await import(pathToFileURL(join(root, 'lib', 'platform', 'index.js')).href);
const { buildTools } = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href);

const registered = [];
const fakeAttachments = {
  async saveImage({ data, mediaType }) {
    return { attachmentId: 'att-selftest', mediaType, bytes: data.length, width: 100, height: 50, name: 'preview.png' };
  },
};
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  get: (service) => (service === 'attachments' ? fakeAttachments : undefined),
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
};

console.log('\nregistration');
check('supported platforms are darwin and win32', SUPPORTED.includes('darwin') && SUPPORTED.includes('win32'));
check('plugin exports a name', plugin.name === 'computer-control', String(plugin.name));
check('plugin injects the tools service', Array.isArray(plugin.inject) && plugin.inject.includes('tools'));

let adapter;
try {
  adapter = selectAdapter(TARGET);
  check(`adapter for ${TARGET} constructs`, true);
} catch (error) {
  check(`adapter for ${TARGET} constructs`, false, error.message);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(1);
}

if (NATIVE) {
  plugin.apply(ctx, {});
} else {
  for (const tool of buildTools(ctx, adapter)) registered.push(tool);
}

const names = registered.map((tool) => tool.name);
const expected = [
  'computer_screenshot', 'computer_mouse', 'computer_keyboard', 'computer_clipboard', 'computer_app',
  'computer_message', 'computer_browser', 'computer_ui', 'computer_policy',
];
check(`registered ${expected.length} tools`, registered.length === expected.length, `got ${registered.length}: ${names.join(', ')}`);
check('tool names match', expected.every((tool) => names.includes(tool)), names.join(', '));
check('tool names are unique', new Set(names).size === names.length);

console.log('\nadapter shape');
const required = [
  ['input.position', adapter.input?.position], ['input.move', adapter.input?.move], ['input.click', adapter.input?.click],
  ['input.drag', adapter.input?.drag], ['input.scroll', adapter.input?.scroll], ['input.type', adapter.input?.type],
  ['input.key', adapter.input?.key], ['input.chord', adapter.input?.chord],
  ['screen.check', adapter.screen?.check], ['screen.screens', adapter.screen?.screens], ['screen.capture', adapter.screen?.capture],
  ['clipboard.read', adapter.clipboard?.read], ['clipboard.write', adapter.clipboard?.write],
  ['apps.resolve', adapter.apps?.resolve], ['apps.activate', adapter.apps?.activate], ['apps.quit', adapter.apps?.quit],
  ['apps.list', adapter.apps?.list], ['apps.frontmost', adapter.apps?.frontmost], ['apps.windows', adapter.apps?.windows],
  ['apps.openTarget', adapter.apps?.openTarget], ['screen.windows', adapter.screen?.windows],
  ['script.run', adapter.script?.run], ['permissions.status', adapter.permissions?.status],
  ['notify', adapter.notify], ['browser.open', adapter.browser?.open], ['browser.listTabs', adapter.browser?.listTabs],
  ['browser.runJavaScript', adapter.browser?.runJavaScript], ['browser.readTextViaClipboard', adapter.browser?.readTextViaClipboard],
  ['messageApps.presets', adapter.messageApps?.presets], ['paths.helper', adapter.paths?.helper],
  ['coordinates.unit', adapter.coordinates?.unit], ['coordinates.imageScale', adapter.coordinates?.imageScale],
];
for (const [label, member] of required) {
  check(`adapter has ${label}`, member !== undefined && member !== null && member !== '');
}
check('adapter resolves a known alias', adapter.apps.resolve('微信') === adapter.apps.resolve('wechat'), String(adapter.apps.resolve('微信')));
check('adapter resolves an unknown name to itself', adapter.apps.resolve('SomeApp 1.0') === 'SomeApp 1.0');
check('message presets cover WeChat', 'WeChat' in adapter.messageApps.presets);

console.log('\ncapability consistency');
const caps = adapter.capabilities;
check('capabilities is present', typeof caps === 'object' && caps !== null);
check('capabilities.menu matches apps.menu', (typeof adapter.apps.menu === 'function') === (caps.menu !== false));
check('capabilities.menuItems matches apps.menuItems', (typeof adapter.apps.menuItems === 'function') === (caps.menuItems !== false));
check('capabilities.hide matches apps.hide', (typeof adapter.apps.hide === 'function') === (caps.hide !== false));
check('capabilities.browserJs matches the browser backend', (adapter.browser.backend === 'applescript') === (caps.browserJs !== false));
check('script.language names the escape hatch', ['AppleScript', 'PowerShell'].includes(adapter.script.language), String(adapter.script.language));
check('coordinate semantics are declared', ['divide', 'identity'].includes(adapter.coordinates?.imageScale), String(adapter.coordinates?.imageScale));
check('macOS divides by scale, Windows does not', (adapter.name === 'darwin') === (adapter.coordinates?.imageScale === 'divide'));
check('coordinate unit matches the platform', adapter.coordinates?.unit === (adapter.name === 'darwin' ? 'points' : 'pixels'), String(adapter.coordinates?.unit));

console.log('\ntool definitions');
const actionEnums = {};
for (const tool of registered) {
  const label = tool.name;
  check(`${label}: description`, typeof tool.description === 'string' && tool.description.length > 30);
  check(`${label}: parameters is an object schema`, tool.parameters?.type === 'object' && typeof tool.parameters.properties === 'object');
  check(`${label}: output.render`, typeof tool.output?.render === 'function');
  check(`${label}: execute`, typeof tool.execute === 'function');
  if (tool.parameters?.properties?.action?.enum) actionEnums[label] = tool.parameters.properties.action.enum;
  if (harness) {
    try {
      harness.assertSupportedJsonSchema(tool.parameters);
      harness.assertSupportedJsonSchema(tool.output.schema);
      check(`${label}: schemas in the supported subset`, true);
    } catch (error) {
      check(`${label}: schemas in the supported subset`, false, error.message);
    }
  }
}

console.log('\naction enums follow the platform');
check('computer_mouse offers every documented action',
  ['move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'position'].every((action) => actionEnums.computer_mouse?.includes(action)));
const appActions = actionEnums.computer_app ?? [];
check('computer_app hides "menu" when the platform cannot script menus', caps.menu !== false || !appActions.includes('menu'));
check('computer_app hides "hide" when the platform cannot hide windows', caps.hide !== false || !appActions.includes('hide'));
const uiActions = actionEnums.computer_ui ?? [];
check('computer_ui hides "menu_items" when unsupported', caps.menuItems !== false || !uiActions.includes('menu_items'));
check('computer_browser has browsers for this platform', Array.isArray(adapter.browser.list) && adapter.browser.list.length > 0, JSON.stringify(adapter.browser.list));

// --- live execution (native only) -----------------------------------------
const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
const exec = { signal: undefined };

async function callTool(name, args) {
  const tool = byName[name];
  const value = await tool.execute(args, exec);
  if (harness) {
    const violations = harness.validateJsonSchemaValue(tool.output.schema, value, 'value');
    check(`${name} output validates (${JSON.stringify(args).slice(0, 60)})`, violations.length === 0, violations.join('; '));
  }
  const blocks = tool.output.render(args, value);
  check(`${name} render returns content blocks`, Array.isArray(blocks) && blocks.length > 0 && typeof blocks[0].type === 'string');
  return { value, blocks };
}

console.log('\nexecution (read-only)');
if (!NATIVE || OFFLINE) {
  console.log('  skip — wiring-only run (unset CC_PLATFORM / CC_SELFTEST_OFFLINE to execute)');
} else {
  try {
    const { value } = await callTool('computer_policy', { action: 'status' });
    check('policy status reports checkout blocked', value.result.includes('checkout: blocked'), value.result.slice(0, 120));
    check('policy status reports payment blocked', value.result.includes('payment: blocked'));
    check('policy status names the platform', value.result.includes(adapter.label), value.result.slice(0, 120));
    check('policy status lists patterns', /立即购买/.test(value.result));
    const environment = await callTool('computer_policy', { action: 'environment' });
    check('environment reports displays', /display 1:/.test(environment.value.result), environment.value.result.slice(0, 160));
    const blockedCheck = await callTool('computer_policy', { action: 'check', value: '立即购买' });
    check('guard check flags 立即购买', blockedCheck.value.result.startsWith('blocked'), blockedCheck.value.result.slice(0, 80));
    const allowedCheck = await callTool('computer_policy', { action: 'check', value: '加入购物车' });
    check('guard check allows 加入购物车', allowedCheck.value.result.startsWith('allowed'), allowedCheck.value.result.slice(0, 80));

    const position = await callTool('computer_mouse', { action: 'position' });
    check('mouse position returns numbers', Number.isFinite(position.value.x) && Number.isFinite(position.value.y));

    const shot = await callTool('computer_screenshot', { target: 'screen', attach: false, max_edge: 0 });
    check('screenshot captured a png', shot.value.width > 0 && shot.value.height > 0 && shot.value.path.endsWith('.png'), JSON.stringify(shot.value));
    await access(shot.value.path);

    const shotWithImage = await callTool('computer_screenshot', { target: 'screen', attach: true, max_edge: 600 });
    check('screenshot attaches an image block', shotWithImage.value.attached === true && shotWithImage.blocks.some((block) => block.type === 'image'),
      `attached=${shotWithImage.value.attached} blocks=${shotWithImage.blocks.map((block) => block.type).join(',')}`);

    const tabs = await callTool('computer_browser', { action: 'list_tabs', browser: adapter.browser.list[0] });
    check('browser list_tabs answers', typeof tabs.value.result === 'string');

    await callTool('computer_clipboard', { action: 'read' });
    await callTool('computer_app', { action: 'windows' });
    await callTool('computer_app', { action: 'frontmost' });
  } catch (error) {
    check('read-only execution', false, error instanceof Error ? error.message : String(error));
  }
}

// --- guard unit tests ------------------------------------------------------
console.log('\npurchase guard');
const { assertAllowed, screen } = await import(pathToFileURL(join(root, 'lib', 'policy.js')).href);
const config = { allowCheckout: false, allowPayment: false };
for (const sample of ['立即购买', '去结算', '提交订单', '确认支付', 'Buy Now', 'proceed to checkout', 'https://shop.example.com/checkout']) {
  check(`blocks ${JSON.stringify(sample)}`, screen(config, sample).allowed === false);
}
for (const sample of ['加入购物车', 'add to cart', '搜索 蓝牙耳机', 'https://shop.example.com/item/42']) {
  check(`allows ${JSON.stringify(sample)}`, screen(config, sample).allowed === true, screen(config, sample).matched ?? '');
}
let threw = false;
try {
  assertAllowed(config, { kind: 'text', value: '确认支付 ¥199', what: 'typed text' });
} catch {
  threw = true;
}
check('assertAllowed throws on payment text', threw);

// --- helper binary ---------------------------------------------------------
console.log('\nnative helper');
if (!NATIVE) {
  console.log(`  skip — the ${TARGET} helper cannot run on ${process.platform}`);
} else {
  const helperExists = existsSync(adapter.paths.helper);
  const buildHint = adapter.name === 'darwin' ? 'sh scripts/build-helper.sh' : 'powershell -File scripts\\build-helper.ps1';
  if (OFFLINE && !helperExists) {
    console.log(`  skip — the helper is not built yet (run ${buildHint}); a fresh clone has no bin/`);
  } else {
    try {
      check('helper binary exists', helperExists, adapter.paths.helper);
      const status = await adapter.screen.check();
      check('helper reports accessibility flag', typeof status.accessibility === 'boolean');
      check('helper reports screen-recording flag', typeof status.screenRecording === 'boolean');
      if (!OFFLINE) check('helper reports display geometry', Array.isArray(status.screens) && status.screens.length > 0, JSON.stringify(status));
      if (status.accessibility === false) console.log('       note: Accessibility is not granted to this app yet');
      if (status.screenRecording === false) console.log('       note: Screen Recording is not granted to this app yet');
    } catch (error) {
      check('helper runs', false, error.message);
    }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
