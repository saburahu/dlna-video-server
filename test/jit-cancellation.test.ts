import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { jitEncoderCancellation, waitJitDrain } from '../src/jit-cancellation.js';

test('Cancellation explicitly releases encoder pipes, including after process exit', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(8*1024*1024));setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const close = once(child, 'close');
  const cancel = jitEncoderCancellation(child);
  try {
    const iterator = child.stdout![Symbol.asyncIterator]();
    await iterator.next(); // encoder pipe consumer paused while HTTP is pacing
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    cancel(); cancel(); // cancellation must also work after exit, and be idempotent
    await close;
    assert.ok(child.stdout!.destroyed);
    assert.ok(child.stderr!.destroyed);
  } finally { cancel(); }
});

test('Drain after an already closed HTTP response rejects instead of waiting forever', { timeout: 5000 }, async () => {
  const res = Object.assign(new EventEmitter(), { destroyed: true }) as unknown as ServerResponse;
  res.emit('close');
  await assert.rejects(waitJitDrain(res), /disconnected/);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
  const open = Object.assign(new EventEmitter(), { destroyed: false }) as unknown as ServerResponse;
  const waiting = waitJitDrain(open);
  open.emit('close');
  await assert.rejects(waiting, /disconnected/);
});

test('An active encoder blocked on output is cancelled without a second HTTP close event', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(8*1024*1024));setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const close = once(child, 'close');
  const cancel = jitEncoderCancellation(child);
  try {
    await child.stdout![Symbol.asyncIterator]().next();
    cancel();
    assert.ok(child.stdout!.destroyed);
    assert.ok(child.stderr!.destroyed);
    await close;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally { cancel(); }
});
