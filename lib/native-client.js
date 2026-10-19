import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { UTF8_ENV } from './runtime.js';

// One ordered pipe per adapter. Never replay an input event after a crash.
// Tab-separated base64 UTF-8 arguments avoid shell quoting and native JSON deps.
export class NativeClient {
  constructor(file, prefix = []) {
    this.file = file;
    this.prefix = prefix;
    this.child = null;
    this.pending = null;
    this.tail = Promise.resolve();
  }

  start() {
    if (this.child) return;
    const child = spawn(this.file, [...this.prefix, 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: UTF8_ENV,
    });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child || !this.pending) return;
      const { resolve, reject } = this.pending;
      this.pending = null;
      try {
        const value = JSON.parse(line);
        if (value.error) reject(new Error(value.error));
        else resolve(value);
      } catch (error) {
        reject(new Error(`invalid native reply: ${error.message}`));
        this.close();
      }
    });
    const failed = (error) => {
      if (this.child !== child) return;
      const pending = this.pending;
      this.pending = null;
      this.close();
      pending?.reject(error);
    };
    child.on('error', failed);
    child.on('exit', (code) => failed(new Error(`native helper exited ${code}: ${stderr}`)));
    child.stdin.on('error', failed);
  }

  call(command, args = [], options = {}) {
    const task = () => this.request(command, args, options);
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }

  async request(command, args, { signal, timeoutMs = 30000 } = {}) {
    signal?.throwIfAborted();
    this.start();
    clearTimeout(this.idleTimer);
    const child = this.child;
    child.ref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.ref?.();
    let timer;
    let abort;
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        const stop = (error) => {
          this.pending = null;
          this.close();
          reject(error);
        };
        abort = () => stop(signal.reason ?? new Error('aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => stop(new Error(`native ${command} timed out after ${timeoutMs}ms; operation was not replayed`)), timeoutMs);
        const line = [command, ...args].map((arg) => Buffer.from(String(arg), 'utf8').toString('base64')).join('\t');
        child.stdin.write(`${line}\n`);
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (this.child === child) {
        child.unref();
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
        this.idleTimer = setTimeout(() => this.close(), 30000);
        this.idleTimer.unref();
      }
    }
  }

  close() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.destroy();
      child.kill();
    }
    this.pending?.reject(new Error('native helper closed'));
    this.pending = null;
  }
}
