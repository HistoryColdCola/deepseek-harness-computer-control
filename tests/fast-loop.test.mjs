import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../lib/tools.js';
import { selectAdapter } from '../lib/platform/index.js';
import { captureNative } from '../lib/capture.js';

async function setup(t, platform = 'darwin') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fast-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.jpg');
  await writeFile(path, 'fixture');
  const events = [];
  const adapter = selectAdapter(platform);
  adapter.screen = { ...adapter.screen, check: () => { throw new Error('extra screen probe'); }, capture: async (args) => {
    events.push(['capture', args]);
    return { path, pixels: { width: 640, height: 360 }, scale: 2,
      frame: { x: -1440, y: 80, width: 1440, height: 810 }, mediaType: 'image/jpeg', captureMs: 10 };
  } };
  adapter.input = { ...adapter.input,
    click: async (x, y) => { events.push(['click', x, y]); return { x, y }; },
    type: async (text, options) => { events.push(['type', text, options.delayMs]); },
    key: async (key) => { events.push(['key', key]); },
  };
  const ctx = { get: () => ({ saveImage: async ({ mediaType, data }) => {
    events.push(['attach', mediaType]);
    return { attachmentId: 'test', bytes: data.length, mediaType, width: 640, height: 360 };
  } }) };
  const tools = Object.fromEntries(buildTools(ctx, adapter).map((tool) => [tool.name, tool]));
  return { tools, events, adapter };
}
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: action batch returns one fresh JPEG with correct frame mapping`, async (t) => {
    const { tools, events } = await setup(t, platform);
    const result = await tools.computer_step.execute({ actions: [
      { tool: 'mouse', action: 'click', x: -1200, y: 300 },
      { tool: 'keyboard', action: 'type', text: '你好🙂 hello 日本語' },
    ], wait_ms: 0 });
    assert.equal(result.completed, 2);
    assert.deepEqual(events.map((e) => e[0]), ['click', 'type', 'capture', 'attach']);
    assert.equal(events.at(-1)[1], 'image/jpeg');
    assert.match(result.screenshot.note, /x=-1440\+imageX\*1440\/640/);
    assert.match(result.screenshot.note, /y=80\+imageY\*810\/360/);
    assert.ok(result.elapsedMs >= result.screenshot.elapsedMs);
  });
}
test('batch preflight blocks forbidden text, invalid coordinates and options before side effects', async (t) => {
  const { tools, events } = await setup(t);
  const click = { tool: 'mouse', action: 'click', x: 1, y: 2 };
  for (const invalid of [
    { actions: [click, { tool: 'keyboard', action: 'type', text: '确认支付' }] },
    { actions: [click, { ...click, x: NaN }] },
    { actions: [click], quality: 0 }, { actions: [click], wait_ms: -1 },
    { actions: Array(9).fill(click) },
  ]) await assert.rejects(tools.computer_step.execute(invalid));
  assert.deepEqual(events, []);
});
test('partial failure reports completed count and skips remaining actions/capture', async (t) => {
  const { tools, events, adapter } = await setup(t);
  adapter.input.key = async () => { throw new Error('input failed'); };
  await assert.rejects(tools.computer_step.execute({ actions: [
    { tool: 'mouse', action: 'click', x: 2, y: 3 },
    { tool: 'keyboard', action: 'key', key: 'return' },
    { tool: 'keyboard', action: 'type', text: 'should not run' },
  ] }), /1\/3 actions.*input failed/);
  assert.deepEqual(events.map((e) => e[0]), ['click']);
});
test('screenshot capture forwards low-quality native knobs and validates before native calls', async () => {
  let calls = 0;
  const helper = async (command, args) => {
    calls++;
    assert.equal(command, 'screenshot');
    assert.ok(args.includes('320'));
    assert.ok(args.includes('15'));
    assert.ok(args.some((a) => a.endsWith('.jpg')));
    return { width: 320, height: 180, frame: { x: 0, y: 0, width: 1920, height: 1080 } };
  };
  const shot = await captureNative(helper, { maxEdge: 320, quality: 15 });
  assert.equal(shot.mediaType, 'image/jpeg');
  for (const args of [{ maxEdge: -1 }, { quality: 101 }, { target: 'region', region: { x: 0, y: 0, width: 0, height: 2 } }]) {
    await assert.rejects(captureNative(helper, args));
  }
  assert.equal(calls, 1);
});
