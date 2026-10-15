import type { ChildProcess } from 'node:child_process';
import type { ServerResponse } from 'node:http';

// Killing a process does not close unread, paused stdout. Node's child `close`
// event waits for the stdio handles too; release them before waiting for close.
export function jitEncoderCancellation(child: ChildProcess): () => void {
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  child.once('close', () => { if (timer) clearTimeout(timer); });
  return () => {
    if (cancelled) return;
    cancelled = true;
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    timer.unref();
  };
}

export async function waitJitDrain(res: ServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const clean = () => { res.off('drain', done); res.off('close', closed); res.off('error', error); };
    const done = () => { clean(); resolve(); };
    const closed = () => { clean(); reject(new Error('Client disconnected during drain')); };
    const error = (e: Error) => { clean(); reject(e); };
    res.once('drain', done); res.once('close', closed); res.once('error', error);
    // close may have happened while pacing, before the listeners were attached.
    if (res.destroyed) closed();
  });
}
