import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NativeClient } from '../lib/native-client.js';

const fixture = fileURLToPath(new URL('./fixtures/helper.mjs', import.meta.url));
function client(t) {
  const c = new NativeClient(process.execPath, [fixture]);
  t.after(() => c.close());
  return c;
}
test('persistent worker preserves UTF-8, empty fields and ordered concurrent calls', async (t) => {
  const c = client(t);
  const [a, b] = await Promise.all([c.call('echo', ['中文🙂\n\t"', '', '-x']), c.call('echo', ['日本語 한국어 العربية'])]);
  assert.deepEqual(a.args, ['中文🙂\n\t"', '', '-x']);
  assert.equal(a.pid, b.pid);
  assert.equal(a.count, 1);
  assert.equal(b.count, 2);
  assert.equal(b.args[0], '日本語 한국어 العربية');
});
test('native errors reject the correct request without corrupting the queue', async (t) => {
  const c = client(t);
  await assert.rejects(c.call('error'), /native failure/);
  assert.equal((await c.call('echo')).count, 2);
});
test('crashes and malformed replies reject without replay, next call can restart', async (t) => {
  const c = client(t);
  for (const command of ['crash', 'bad']) {
    await assert.rejects(c.call(command), /exited|invalid native reply/);
    assert.equal((await c.call('echo')).count, 1);
  }
});
test('timeout terminates a hung worker and never replays input', async (t) => {
  const c = client(t);
  await c.call('echo');
  await assert.rejects(c.call('hang', [], { timeoutMs: 60 }), /timed out/);
  assert.equal((await c.call('echo')).count, 1);
});
test('aborting queued work does not interrupt an unrelated request', async (t) => {
  const c = client(t);
  const controller = new AbortController();
  const first = c.call('slow');
  const queued = c.call('echo', [], { signal: controller.signal });
  controller.abort();
  assert.equal((await first).count, 1);
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal((await c.call('echo')).count, 2);
});
test('abort active work kills worker, next request starts cleanly', async (t) => {
  const c = client(t);
  await c.call('echo');
  const controller = new AbortController();
  const request = c.call('hang', [], { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal((await c.call('echo')).count, 1);
});
