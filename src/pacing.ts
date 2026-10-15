import { Transform, TransformCallback } from "node:stream";
import { PcrIndex } from './core.js';
import { packetTime } from './time-seek.js';

/** Byte-preserving clock pacing; Content Packet headers have no PCR duration. */
export class PcrPacingTransform extends Transform {
  private readonly started = process.hrtime.bigint();
  private readonly origin: number;
  private sentBytes = 0;
  private waitedMs = 0;
  private timer?: NodeJS.Timeout;
  private pendingCallback?: TransformCallback;
  constructor(private readonly index: PcrIndex, private readonly packetSize: number,
    private readonly firstPacket: number, private readonly blockBytes?: number,
    private readonly leadMs = 0) {
    super();
    if (!Number.isFinite(leadMs) || leadMs < 0) throw new RangeError('Invalid PCR pacing lead');
    this.origin = packetTime(index, firstPacket);
  }
  private timeAt(bytes: number) {
    const payload = this.blockBytes === undefined ? bytes :
      Math.floor(bytes / (this.blockBytes + 14)) * this.blockBytes +
      Math.max(0, bytes % (this.blockBytes + 14) - 14);
    return packetTime(this.index, this.firstPacket + payload / this.packetSize) - this.origin;
  }
  getStats() {
    return { mode: 'local-pcr', waitedMs: Math.round(this.waitedMs),
      scheduledPcrSeconds: this.timeAt(this.sentBytes), leadMs: this.leadMs,
      scheduledSendSeconds: Math.max(0, this.timeAt(this.sentBytes) - this.leadMs / 1000), sentBytes: this.sentBytes };
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.pendingCallback = callback;
    let offset = 0;
    const next = () => {
      if (this.destroyed) return;
      if (offset === chunk.length) { this.pendingCallback = undefined; callback(); return; }
      const end = Math.min(chunk.length, offset + 16 * 1024);
      const seconds = this.timeAt(this.sentBytes + end - offset);
      const elapsedMs = Number(process.hrtime.bigint() - this.started) / 1e6;
      const waitMs = seconds * 1000 - this.leadMs - elapsedMs;
      const emit = () => {
        this.timer = undefined;
        if (this.destroyed) return;
        this.sentBytes += end - offset;
        this.push(chunk.subarray(offset, end)); offset = end; next();
      };
      if (waitMs > 1) { this.waitedMs += waitMs; this.timer = setTimeout(emit, waitMs); }
      else emit();
    };
    next();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    if (this.timer) clearTimeout(this.timer);
    const pending = this.pendingCallback; this.pendingCallback = undefined;
    pending?.(error ?? Object.assign(new Error('PCR pacing stream closed'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
    callback(error);
  }
}

export class BitratePacingTransform extends Transform {
  private readonly started = process.hrtime.bigint();
  private sentBytes = 0;
  private waitedMs = 0;

  constructor(private readonly bitsPerSecond: number) {
    super();
    if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
      throw new Error(`不正なペーシング速度: ${bitsPerSecond}`);
    }
  }

  getStats() {
    return { targetBitsPerSecond: this.bitsPerSecond, waitedMs: Math.round(this.waitedMs) };
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.sentBytes += chunk.length;
    const targetNs = BigInt(Math.floor(this.sentBytes * 8 * 1_000_000_000 / this.bitsPerSecond));
    const elapsedNs = process.hrtime.bigint() - this.started;
    const waitMs = Number(targetNs - elapsedNs) / 1_000_000;
    if (waitMs <= 1) {
      callback(null, chunk);
      return;
    }
    this.waitedMs += waitMs;
    setTimeout(() => callback(null, chunk), waitMs);
  }
}
