/**
 * Platform layer.
 *
 * Everything the tools need that differs between macOS and Windows lives behind
 * one adapter object, picked from `process.platform` at load time. ../tools.js
 * and ../message.js are written against this interface and never touch OS APIs
 * directly.
 *
 * ── PlatformAdapter ─────────────────────────────────────────────────────────
 * name           'darwin' | 'win32'
 * label          human-readable OS name
 * capabilities   { permissions, menu, menuItems, hide, notify, browserTabs,
 *                  browserJs, scriptLanguage, nativeHelper }
 * coordinates    { unit, imageScale }
 *                  `unit` is 'points' (macOS) or 'pixels' (Windows) and is what
 *                  the model is told to use; `imageScale` is 'divide' when a
 *                  screenshot pixel must be divided by the reported scale to
 *                  become a coordinate (Retina) and 'identity' when image pixel
 *                  == screen coordinate (DPI-aware Windows).
 * input          { position, move, click, drag, scroll, type, key, chord }
 *                  every call takes a trailing options object that may carry
 *                  `signal`; the resolved coordinates come back as { x, y } in
 *                  screen pixels/points, origin at the top-left of the primary
 *                  display (secondary displays may be negative)
 * screen         { check, screens, capture, windows }
 *                  capture({ target, display, region, windowId, maxEdge })
 *                    -> { path, previewPath, pixels: { width, height }, frame }
 * clipboard      { read, write }
 * apps           { aliases, resolve, activate, quit, list, frontmost,
 *                  openTarget, hide?, menu?, menuItems? }
 *                  list() -> [{ name, title?, pid? }]
 *                  frontmost() -> { app, title, pid? }
 * script         { language, run(source, { timeoutMs }) }
 * browser        { backend, limited?, jsHint, list, open, listTabs, activeTab,
 *                  activateTab, closeTab, runJavaScript, readTextViaClipboard,
 *                  javascriptError, isJavaScriptDisabled }
 * permissions    { status, request }
 * notify(title, text, options)
 * messageApps    { aliases, presets }
 * paths          { helper, packageRoot }
 *
 * Optional members are absent where the OS cannot do it (macOS menu scripting
 * has no Windows equivalent); callers check `capabilities` first.
 */

import { createAdapter as createDarwinAdapter } from './darwin.js';
import { createAdapter as createWin32Adapter } from './win32.js';

/** Platforms this plugin implements. */
export const SUPPORTED = ['darwin', 'win32'];

/**
 * Build the adapter for a platform.
 * @param {string} [platform] defaults to the running platform.
 */
export function selectAdapter(platform = process.platform) {
  if (platform === 'darwin') return createDarwinAdapter();
  if (platform === 'win32') return createWin32Adapter();
  throw new Error(
    `dsh-computer-control implements macOS (darwin) and Windows (win32); this host reports ${JSON.stringify(platform)}.`,
  );
}
