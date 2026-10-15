import { Transform } from "node:stream";

// ARIB STD-B21 table 9-61: 0 + 9 user bytes + 4-byte payload length.
// Input consists of complete 192-byte packets, so no 16-byte padding is needed.
export function contentPacketLayout(payloadBytes: number, bitsPerSecond: number) {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 0 || payloadBytes % 192 !== 0 ||
      !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) throw new Error("Content Packet入力が不正です");
  const blockBytes = Math.max(192, Math.floor(bitsPerSecond * 0.5 / 8 / 192) * 192);
  if (blockBytes > 0xffffffff) throw new Error("Content Packetが長すぎます");
  const blocks = Math.ceil(payloadBytes / blockBytes);
  return { blockBytes, blocks, headerBytes: 14, servedBytes: payloadBytes + blocks * 14 };
}

export class ContentPacketTransform extends Transform {
  private remaining: number;
  private blockRemaining = 0;
  constructor(private readonly payloadBytes: number, private readonly blockBytes: number) {
    super();
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 0 || payloadBytes % 192 !== 0 ||
        !Number.isSafeInteger(blockBytes) || blockBytes <= 0 || blockBytes % 192 !== 0 ||
        blockBytes > 0xffffffff) throw new Error("Content Packet入力が不正です");
    this.remaining = payloadBytes;
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      if (chunk.length > this.remaining) throw new Error("Content Packet入力が予定長を超えました");
      let offset = 0;
      while (offset < chunk.length) {
        if (this.blockRemaining === 0) {
          this.blockRemaining = Math.min(this.blockBytes, this.remaining);
          const header = Buffer.alloc(14); header.writeUInt32BE(this.blockRemaining, 10); this.push(header);
        }
        const take = Math.min(chunk.length - offset, this.blockRemaining);
        this.push(chunk.subarray(offset, offset + take));
        offset += take; this.remaining -= take; this.blockRemaining -= take;
      }
      callback();
    } catch (error) { callback(error as Error); }
  }
  override _flush(callback: (error?: Error | null) => void) {
    callback(this.remaining === 0 ? null : new Error(`Content Packet入力不足: ${this.remaining}バイト`));
  }
}
