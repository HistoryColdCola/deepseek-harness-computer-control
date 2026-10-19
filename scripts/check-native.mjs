import assert from 'node:assert/strict';
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
} finally { client.close(); }
