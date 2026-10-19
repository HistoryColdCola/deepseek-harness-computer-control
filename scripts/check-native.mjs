import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { captureNative } from '../lib/capture.js';
import { NativeClient } from '../lib/native-client.js';
import { selectAdapter } from '../lib/platform/index.js';
const client = new NativeClient(selectAdapter().paths.helper);
try {
  const [check, position, screens] = await Promise.all([
    client.call('check'), client.call('pos'), client.call('screens'),
  ]);
  assert.equal(typeof check.screenRecording, 'boolean');
  assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
  assert.ok(Array.isArray(screens.screens));
  console.log('native persistent pipe: check, pos, screens passed');
  if (check.screenRecording) {
    const timings = [];
    for (const format of ['jpeg', 'jpeg', 'jpeg', 'jpeg', 'jpeg', 'png']) {
      const shot = await captureNative(client.call.bind(client), { format, maxEdge: 320, quality: 15 });
      try {
        const bytes = await readFile(shot.path);
        assert.equal(format === 'jpeg' ? bytes.subarray(0, 3).toString('hex') : bytes.subarray(0, 8).toString('hex'),
          format === 'jpeg' ? 'ffd8ff' : '89504e470d0a1a0a');
        assert.ok(shot.pixels.width > 0 && shot.pixels.height > 0);
        assert.ok(Math.max(shot.pixels.width, shot.pixels.height) <= 320);
        assert.ok(shot.frame.width > 0 && shot.frame.height > 0);
        timings.push({ format, captureMs: shot.captureMs, roundTripMs: shot.nativeRoundTripMs, bytes: bytes.length });
      } finally { await unlink(shot.path); }
    }
    console.log('native screenshot smoke (not a user-machine benchmark):', JSON.stringify(timings));
  } else console.log('native capture skipped: runner has no Screen Recording grant');
} finally { client.close(); }
