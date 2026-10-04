/**
 * Platform-independent plumbing: where state lives, how the config is read and
 * how child processes are spawned.
 *
 * OS-specific work lives in ./platform/*.js.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of the plugin's private state (config, screenshots, mount log). */
export const stateDir = join(homedir(), '.dsh', 'computer-control');
export const configPath = join(stateDir, 'config.json');
export const shotsDir = join(stateDir, 'shots');
export const mountPath = join(stateDir, 'mounted.json');

const DEFAULTS = {
  /** Hard guard: never let the agent reach a checkout/payment step. */
  allowCheckout: false,
  allowPayment: false,
  /** Screenshot behaviour. */
  screenshotDir: shotsDir,
  maxScreenshotEdge: 1600,
  keepScreenshots: 200,
  /** Input behaviour. */
  typeChunkDelayMs: 9,
  defaultWaitMs: 700,
  /** Per-app message automation presets, merged over the platform defaults. */
  messageApps: {},
};

let configCache = { mtimeMs: 0, value: null };

/** Default config document, written on first mount so the human can edit it. */
export function defaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

/**
 * Read `~/.dsh/computer-control/config.json`, falling back to defaults.
 * Cached by mtime so a human edit takes effect without a restart.
 */
export async function loadConfig() {
  try {
    const info = await stat(configPath);
    if (configCache.value !== null && configCache.mtimeMs === info.mtimeMs) return configCache.value;
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    const value = { ...DEFAULTS, ...raw };
    configCache = { mtimeMs: info.mtimeMs, value };
    return value;
  } catch {
    const value = { ...DEFAULTS };
    configCache = { mtimeMs: 0, value };
    return value;
  }
}

/** Create the state directory and a default config if absent. */
export async function ensureState() {
  await mkdir(shotsDir, { recursive: true });
  if (!existsSync(configPath)) {
    await writeFile(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { mode: 0o600 });
  }
}

/**
 * A UTF-8 environment for every child we spawn. Without it macOS tools such as
 * `pbpaste`/`pbcopy` fall back to the legacy MacRoman text encoding and CJK text
 * comes back as mojibake; Windows PowerShell would print in the OEM code page.
 */
export const UTF8_ENV = {
  ...process.env,
  LANG: process.env.LANG && process.env.LANG.length > 0 ? process.env.LANG : 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
};

/**
 * Run a command and capture its output. Never uses a shell.
 * @returns {Promise<{stdout: string, stderr: string, code: number|null}>}
 */
export function run(file, args, options = {}) {
  const { timeoutMs = 30000, maxBuffer = 16 * 1024 * 1024, signal, cwd, env = UTF8_ENV } = options;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer, signal, cwd, encoding: 'utf8', env, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          reject(new Error(`command not found: ${file}`));
          return;
        }
        if (error && error.killed) {
          reject(new Error(`${file} timed out after ${timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        if (error && typeof error.code === 'number' && error.code !== 0) {
          const detail = (stderr || stdout || '').trim();
          reject(new Error(`${file} exited ${error.code}${detail ? `: ${truncate(detail, 2000)}` : ''}`));
          return;
        }
        if (error) {
          reject(new Error(`${file} failed: ${error.message}${stderr ? `: ${truncate(stderr.trim(), 2000)}` : ''}`));
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
  });
}

export function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} of ${text.length} characters]`;
}
