/**
 * dsh-computer-control — give a DSH agent hands on this machine.
 *
 * A DSH host plugin that registers screen, mouse, keyboard, app, browser,
 * clipboard and messaging tools on macOS and Windows, with a hard purchase
 * guard: browsing and adding to cart are allowed, checkout and payment are not.
 *
 * Host-only, no external dependencies: every OS call goes through
 * ./platform/<name>.js.
 */

import { writeFile } from 'node:fs/promises';
import { selectAdapter } from './platform/index.js';
import { ensureState, loadConfig, mountPath } from './runtime.js';
import { buildTools } from './tools.js';

/** Cordis plugin name. */
export const name = 'computer-control';

/** The plugin is useless without the tool registry. */
export const inject = ['tools'];

/**
 * Register every computer-control tool on the harness tool registry.
 * @param {object} ctx - cordis context carrying the `tools` service.
 */
export function apply(ctx, config = {}) {
  const adapter = selectAdapter();
  const tools = buildTools(ctx, adapter);
  for (const tool of tools) ctx.tools.register(tool);

  // Best-effort mount record: proves the plugin loaded, names the active
  // platform and doubles as a machine-readable manifest for scripts/.
  void (async () => {
    await ensureState();
    await loadConfig();
    await writeFile(
      mountPath,
      `${JSON.stringify({
        mountedAt: new Date().toISOString(),
        plugin: name,
        version: '0.2.0',
        pid: process.pid,
        platform: adapter.name,
        helper: adapter.paths.helper,
        config,
        tools: tools.map((tool) => tool.name),
      }, null, 2)}\n`,
    );
  })().catch(() => {});

  try {
    ctx.logger?.info?.(`computer-control: registered ${tools.length} tools for ${adapter.label}`);
  } catch {
    /* logging is optional */
  }
}

export default { name, inject, apply };
