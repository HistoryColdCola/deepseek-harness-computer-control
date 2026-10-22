import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './runtime.js';

let cleanup = Promise.resolve();
let captures = 0;

export async function captureNative(helper, {
  target = 'screen', display, region, windowId, maxEdge, quality, format,
} = {}, options = {}) {
  const cfg = await loadConfig();
  maxEdge ??= cfg.maxScreenshotEdge;
  quality ??= cfg.screenshotQuality;
  format ??= maxEdge === 0 ? 'png' : cfg.screenshotFormat;
  if (!Number.isInteger(maxEdge) || maxEdge < 0 || maxEdge > 16384) throw new Error('max_edge must be 0..16384');
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('quality must be 1..100');
  if (!['png', 'jpeg'].includes(format)) throw new Error('format must be jpeg or png');
  if (!['screen', 'region', 'window'].includes(target)) throw new Error('invalid screenshot target');
  await mkdir(cfg.screenshotDir, { recursive: true });
  const file = join(cfg.screenshotDir, `shot-${Date.now()}-${randomUUID()}.${format === 'png' ? 'png' : 'jpg'}`);
  const args = ['--out', file, '--target', target, '--max-edge', String(maxEdge), '--quality', String(quality)];
  if (target === 'region') {
    if (!region || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(region[key])) || region.width <= 0 || region.height <= 0) {
      throw new Error('region needs finite x/y and positive width/height');
    }
    args.push('--region', [region.x, region.y, region.width, region.height].map(Math.round).join(','));
  } else if (target === 'window') {
    if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error('window_id must be a positive integer');
    args.push('--window', String(windowId));
  } else if (display !== undefined) {
    if (!Number.isInteger(display) || display < 1) throw new Error('display must be a positive integer');
    args.push('--display', String(display));
  }
  const started = performance.now();
  const result = await helper('screenshot', args, { ...options, timeoutMs: 15000 });
  // Cleanup is off the critical path and only owns this plugin's capture files.
  if (++captures % 20 === 0) {
    cleanup = cleanup.then(async () => {
      const keep = Math.max(20, Number.isInteger(cfg.keepScreenshots) ? cfg.keepScreenshots : 200);
      const files = (await readdir(cfg.screenshotDir)).filter((name) => /^shot-\d+-[\da-f-]+\.(jpg|png)$/.test(name)).sort();
      await Promise.all(files.slice(0, Math.max(0, files.length - keep)).map((name) => unlink(join(cfg.screenshotDir, name)).catch(() => {})));
    }).catch(() => {});
  }
  return {
    path: result.path ?? file, pixels: { width: result.width, height: result.height },
    frame: result.frame, scale: result.scale ?? 1, mediaType: format === 'png' ? 'image/png' : 'image/jpeg',
    captureMs: result.captureMs, nativeRoundTripMs: performance.now() - started,
  };
}
