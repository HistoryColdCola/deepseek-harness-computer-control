// Read-only desktop benchmark. Measures native capture + local IPC/file output;
// model inference, attachment upload and network latency are excluded.
import { stat } from 'node:fs/promises';
import { selectAdapter } from '../lib/platform/index.js';
const flags = new Map(process.argv.slice(2).reduce((pairs, value, i, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[i + 1]]);
  return pairs;
}, []));
const samples = Number(flags.get('samples') ?? 30);
const maxEdge = Number(flags.get('max-edge') ?? 640);
const quality = Number(flags.get('quality') ?? 25);
const budget = Number(flags.get('budget-ms') ?? 300);
if (!Number.isInteger(samples) || samples < 2 || samples > 1000 || !Number.isFinite(budget) || budget <= 0) {
  throw new Error('use --samples 2..1000 and --budget-ms > 0');
}
const adapter = selectAdapter();
const values = [];
for (let i = 0; i < samples + 1; i++) {
  const started = performance.now();
  const shot = await adapter.screen.capture({ maxEdge, quality, format: 'jpeg' });
  const elapsedMs = performance.now() - started;
  const row = { elapsedMs, captureMs: shot.captureMs, bytes: (await stat(shot.path)).size };
  if (i === 0) console.log(JSON.stringify({ cold: row }));
  else values.push(row);
}
const sorted = values.map((v) => v.elapsedMs).sort((a, b) => a - b);
const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
const p50 = percentile(0.5), p95 = percentile(0.95);
console.log(JSON.stringify({ platform: adapter.name, samples, maxEdge, quality, p50Ms: p50, p95Ms: p95,
  meanBytes: Math.round(values.reduce((sum, v) => sum + v.bytes, 0) / samples),
  budgetMs: budget, withinBudget: p95 <= budget,
  scope: 'native capture + IPC + local file; excludes model inference and attachment upload',
}, null, 2));
