/**
 * The messaging flow, shared by every platform.
 *
 * It is deliberately two-phase. Chat apps put their search results in a
 * dropdown whose keyboard behaviour differs per app — in WeChat on macOS, Return
 * opens a web search and the arrow keys select network results, so a blind
 * "type the name, press Return, type the message, press Return" sequence sends
 * to whoever happened to have the open chat (this was observed for real). So:
 *
 *   phase 1 — activate, open search, paste the contact, return a screenshot and
 *             send NOTHING;
 *   phase 2 — with the row coordinate measured on that screenshot, click it,
 *             paste the message and press the send key.
 *
 * The caller is the model, which can read the screenshot. That keeps one-shot
 * convenience for well-behaved apps while making a misfire impossible when the
 * caller looks first.
 */

const FALLBACK_PRESET = { searchChord: 'ctrl+f', sendKey: 'return', settleMs: 900 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Merge built-in, config-file and per-call presets for one app. */
export function presetFor(adapter, app, config, overrides = {}) {
  const builtin = adapter.messageApps?.presets?.[app] ?? {};
  const configured = config?.messageApps?.[app] ?? {};
  return { ...FALLBACK_PRESET, ...builtin, ...configured, ...overrides };
}

/** Apps this deployment ships a preset for. */
export function knownMessageApps(adapter, config) {
  const names = new Set([
    ...Object.keys(adapter.messageApps?.presets ?? {}),
    ...Object.keys(config?.messageApps ?? {}),
  ]);
  return [...names];
}

/**
 * Run one phase of the messaging flow.
 * @returns {Promise<{app, to, sent, steps, needsResult, pasted}>}
 */
export async function sendMessage(adapter, input, config, options = {}) {
  const { app, to, text, send = true, resultPoint, inputPoint, overrides = {}, signal } = options;
  const name = adapter.apps.resolve(app);
  const preset = presetFor(adapter, name, config, overrides);
  const steps = [];
  const call = { signal };

  await adapter.apps.activate(name, { waitMs: 400, signal });
  steps.push(`activate ${name}`);
  await sleep(preset.settleMs);

  await adapter.input.chord(preset.searchChord, call);
  steps.push(`search ${preset.searchChord}`);
  await sleep(500);

  await adapter.input.chord(adapter.name === 'win32' ? 'ctrl+a' : 'cmd+a', call);
  await adapter.clipboard.write(to);
  await adapter.input.chord(adapter.name === 'win32' ? 'ctrl+v' : 'cmd+v', call);
  steps.push(`typed contact ${to}`);
  await sleep(Math.round(preset.settleMs * 1.5));

  if (!resultPoint || typeof resultPoint.x !== 'number' || typeof resultPoint.y !== 'number') {
    return { app: name, to, sent: false, steps, needsResult: true, pasted: false };
  }

  await adapter.input.click(resultPoint.x, resultPoint.y, call);
  steps.push(`clicked result (${Math.round(resultPoint.x)},${Math.round(resultPoint.y)})`);
  await sleep(Math.round(preset.settleMs * 1.5));

  if (inputPoint && typeof inputPoint.x === 'number' && typeof inputPoint.y === 'number') {
    await adapter.input.click(inputPoint.x, inputPoint.y, call);
    steps.push(`focused message box (${Math.round(inputPoint.x)},${Math.round(inputPoint.y)})`);
    await sleep(300);
  }

  await adapter.clipboard.write(text);
  await adapter.input.chord(adapter.name === 'win32' ? 'ctrl+a' : 'cmd+a', call);
  await adapter.input.chord(adapter.name === 'win32' ? 'ctrl+v' : 'cmd+v', call);
  steps.push('pasted message');
  await sleep(250);

  if (send) {
    await adapter.input.key(preset.sendKey, call);
    steps.push(`pressed ${preset.sendKey}`);
  }
  return { app: name, to, sent: Boolean(send), steps, needsResult: false, pasted: true };
}
