import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let count = 0;
for await (const line of lines) {
  const [command, ...args] = line.split('\t').map((s) => Buffer.from(s, 'base64').toString('utf8'));
  count++;
  if (command === 'crash') process.exit(7);
  if (command === 'hang') { await new Promise(() => {}); continue; }
  if (command === 'slow') await new Promise((r) => setTimeout(r, 80));
  if (command === 'bad') { console.log('not JSON'); continue; }
  console.log(JSON.stringify(command === 'error' ? { error: 'native failure' } : { command, args, count, pid: process.pid }));
}
