import { Transform, type TransformCallback } from "node:stream";
import { contentPacketLayout } from "./content-packet.js";
import type { PcrIndex } from "./core.js";

/** Conservative full-index bound: every interpolated PCR slope is <= this maximum.
 * Therefore any block of N packets spans <= N * maximumSlope, including Range origins. */
export function pcrBoundedBlockBytes(index: PcrIndex, maxSeconds: number) {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || index.discontinuities || index.invalidIntervals || index.points.length < 2) throw new Error("Continuous PCR and positive block time required");
  let maximumSlope = 0;
  for (let i = 1; i < index.points.length; i++) {
    const a = index.points[i - 1], b = index.points[i], packets = b.packet - a.packet, seconds = (b.unwrappedPcr - a.unwrappedPcr) / 27_000_000;
    if (packets <= 0 || seconds <= 0) throw new Error("Invalid PCR interval");
    maximumSlope = Math.max(maximumSlope, seconds / packets);
  }
  const packets = Math.floor(maxSeconds / maximumSlope);
  if (packets < 1 || !Number.isSafeInteger(packets) || packets * 192 > 0xffffffff) throw new Error("Cannot represent bounded Content Packet");
  return { blockBytes: packets * 192, maximumSlope, guaranteedMaxSeconds: packets * maximumSlope, requestedMaxSeconds: maxSeconds };
}

/** Reuse the production framing; the experiment never regenerates TTS or TS. */
export function experimentalLayout(sourceBytes: number, bitrate: number, wrapped: boolean, overrideBlockBytes?: number) {
  if (overrideBlockBytes === undefined) return wrapped ? contentPacketLayout(sourceBytes, bitrate) : { servedBytes: sourceBytes, blockBytes: undefined };
  if (!wrapped || !Number.isSafeInteger(sourceBytes) || sourceBytes <= 0 || sourceBytes % 192 || !Number.isSafeInteger(overrideBlockBytes) || overrideBlockBytes <= 0 || overrideBlockBytes % 192 || overrideBlockBytes > 0xffffffff) throw new Error("Invalid experimental block override");
  const blocks = Math.ceil(sourceBytes / overrideBlockBytes);
  return { blockBytes: overrideBlockBytes, blocks, headerBytes: 14, servedBytes: sourceBytes + blocks * 14 };
}

/** Read complete enclosing blocks so even a Range inside a header has exact bytes.
 * Pacing starts at that block's PCR origin, not at file packet zero.
 */
export function contentPacketRange(sourceBytes: number, blockBytes: number, start: number, end: number) {
  const firstBlock = Math.floor(start / (blockBytes + 14));
  const lastBlock = Math.floor(end / (blockBytes + 14));
  const sourceStart = firstBlock * blockBytes;
  const sourceEnd = Math.min(sourceBytes, (lastBlock + 1) * blockBytes) - 1;
  return { sourceStart, sourceEnd, skip: start - firstBlock * (blockBytes + 14), length: end - start + 1 };
}

/** Bounded Range extraction after block-aware pacing; consumes only enclosing blocks. */
export class ExperimentalRangeSlice extends Transform {
  constructor(private skip: number, private remaining: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    const skip = Math.min(this.skip, chunk.length); this.skip -= skip;
    const take = Math.min(this.remaining, chunk.length - skip);
    if (take) { this.push(chunk.subarray(skip, skip + take)); this.remaining -= take; }
    callback();
  }
  override _flush(callback: TransformCallback) {
    callback(this.skip || this.remaining ? new Error("Incomplete experimental Range") : null);
  }
}
