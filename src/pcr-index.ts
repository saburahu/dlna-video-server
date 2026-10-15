import { createReadStream, promises as fs } from "node:fs";
import { inspectTs, PCR_WRAP, PcrIndex, PcrIndexPoint, readPcr } from "./core.js";
import path from 'node:path';
import {sourcePathKey} from './library-discovery.js';
import { readPcrCache, writePcrCache, pcrCacheStatus,readPcrSummary,pcrSummary,type PcrCacheSummary } from './pcr-cache.js';
import {pcrWork,PcrDeferred,type PcrWorkControl} from './pcr-work.js';

const cache = new Map<string, { key: string; value: Promise<PcrIndex | null> }>();
const weights = new Map<string, number>();
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
let memoryBytes = 0;
export function pcrIndexCacheStatus() { return { ...pcrCacheStatus(), memoryEntries: weights.size, estimatedMemoryBytes: memoryBytes, maxMemoryBytes: MAX_MEMORY_BYTES }; }
const MAX_REASONABLE_GAP_SECONDS = 10;
/** No queue joins, builds or full cache reads on a ContentDirectory request. */
export async function cachedPcrSummary(filePath:string):Promise<PcrCacheSummary|undefined>{
 filePath=path.resolve(filePath);const stat=await fs.stat(filePath),key=`${stat.size}:${stat.mtimeMs}`,entry=cache.get(sourcePathKey(filePath));
 if(entry?.key===key&&weights.has(sourcePathKey(filePath))){const index=await entry.value;return index?pcrSummary(index):undefined;}
 return readPcrSummary(filePath,key);
}

function hasDiscontinuity(packet: Buffer): boolean {
  const adaptation = (packet[3] >> 4) & 0x03;
  if (adaptation !== 2 && adaptation !== 3) return false;
  return packet[4] > 0 && (packet[5] & 0x80) !== 0;
}

export async function buildPcrIndex(filePath: string,options:{background?:boolean;bytesPerSecond?:number}={}): Promise<PcrIndex | null> {
  filePath = path.resolve(filePath);
  const stat = await fs.stat(filePath);
  const key = `${stat.size}:${stat.mtimeMs}`;
  const identity=sourcePathKey(filePath);
  const cached = cache.get(identity);
  if(!options.background)pcrWork.promote(filePath,key);
  if (cached?.key === key) {
    cache.delete(identity); cache.set(identity, cached);
    try{return await cached.value;}catch(error){
      // A foreground arrival can race with an already aborted prefetch. Its
      // cancellation belongs to the background operation, not this request.
      if(!options.background&&(error instanceof PcrDeferred||(error as Error).name==='AbortError')){
        if(cache.get(identity)===cached)cache.delete(identity);
        await new Promise<void>(resolve=>setImmediate(resolve));
        return buildPcrIndex(filePath,options);
      }throw error;
    }
  }
  if (weights.has(identity)) { memoryBytes -= weights.get(identity)!; weights.delete(identity); }
  const value = pcrWork.run({source:filePath,key,...options},async control => {
    control.check();const saved = await readPcrCache(filePath, key,control.signal);control.check();
    if (saved) {
      const after = await fs.stat(filePath);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('録画が解析待機中に変更されました。再試行してください');
      return saved.index;
    }
    const index = await build(filePath, stat.size,control);
    const after = await fs.stat(filePath);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('録画が解析中に変更されました。再試行してください');
    control.check();await writePcrCache(filePath, key, index);
    return index;
  });
  cache.set(identity, { key, value });
  try {
    const result = await value;
    if (cache.get(identity)?.value === value) {
      const weight = (result?.points.length ?? 0) * 128 + 1024;
      weights.set(identity, weight); memoryBytes += weight;
      for (const [name] of cache) {
        if (memoryBytes <= MAX_MEMORY_BYTES) break;
        const bytes = weights.get(name); if (bytes === undefined) continue;
        cache.delete(name); weights.delete(name); memoryBytes -= bytes;
      }
    }
    return result;
  } catch (error) {
    if (cache.get(identity)?.value === value) cache.delete(identity);
    throw error;
  }
}

async function build(filePath: string, fileSize: number,control:PcrWorkControl): Promise<PcrIndex | null> {
  const file = await fs.open(filePath, "r");
  let initial: Buffer;
  try {
    initial = Buffer.alloc(Math.min(8 * 1024 * 1024, fileSize));
    let filled=0;while(filled<initial.length){control.check();const {bytesRead}=await file.read(initial,filled,Math.min(initial.length-filled,control.initialBackground?256*1024:initial.length),filled);if(!bytesRead)break;filled+=bytesRead;await control.charge(bytesRead,'prefix');}
    initial = initial.subarray(0, filled);
  } finally {
    await file.close();
  }
  const inspection = inspectTs(initial);
  if (inspection.packetSize === null || inspection.syncOffset === null || inspection.pcrPid === null) return null;
  const packetSize = inspection.packetSize;
  const syncOffset = inspection.syncOffset;
  // Only accept packet-aligned files; 192-byte TTS has a four-byte ATS prefix.
  if (syncOffset !== (packetSize === 192 ? 4 : 0)) return null;

  const points: PcrIndexPoint[] = [];
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let packetIndex = 0;
  let wrapOffset = 0;
  let lastRaw: number | null = null;
  let lastUnwrapped: number | null = null;
  let discontinuities = 0;
  let invalidIntervals = 0;

  for await (const chunk of createReadStream(filePath, { highWaterMark: control.initialBackground?256*1024:4*1024*1024,signal:control.signal })) {
    control.check();
    const data = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer;
    let offset = 0;
    while (offset + packetSize <= data.length) {
      const packet = data.subarray(offset + syncOffset, offset + syncOffset + 188);
      if (packet[0] !== 0x47) throw new Error(`TS同期バイト不一致: packet ${packetIndex}`);
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      if (pid === inspection.pcrPid) {
        const raw = readPcr(packet, 0);
        if (raw !== null) {
          const signaled = hasDiscontinuity(packet);
          if (lastRaw !== null && raw < lastRaw && lastRaw - raw > PCR_WRAP / 2) wrapOffset += PCR_WRAP;
          let unwrapped = raw + wrapOffset;
          const delta = lastUnwrapped === null ? 0 : unwrapped - lastUnwrapped;
          const unreasonable = lastUnwrapped !== null &&
            (delta <= 0 || delta > MAX_REASONABLE_GAP_SECONDS * 27_000_000);
          const discontinuityBefore = points.length > 0 && (signaled || unreasonable);
          if (discontinuityBefore) {
            discontinuities++;
            if (unreasonable) invalidIntervals++;
            // 新区間を前区間の直後へつなぎ、30bit ATSを単調に保つ。
            if (lastUnwrapped !== null && delta <= 0) {
              wrapOffset += lastUnwrapped + 1 - unwrapped;
              unwrapped = raw + wrapOffset;
            }
          }
          points.push({ packet: packetIndex, pcr: raw, unwrappedPcr: unwrapped, discontinuityBefore });
          lastRaw = raw;
          lastUnwrapped = unwrapped;
        }
      }
      packetIndex++;
      offset += packetSize;
    }
    pending = data.subarray(offset);
    await control.charge((chunk as Buffer).length,'index');
  }

  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const durationTicks = last.unwrappedPcr - first.unwrappedPcr;
  const coveredBytes = (last.packet - first.packet) * packetSize;
  return {
    pid: inspection.pcrPid,
    packetCount: Math.floor(fileSize / packetSize),
    points,
    discontinuities,
    invalidIntervals,
    firstPacket: first.packet,
    lastPacket: last.packet,
    durationSeconds: durationTicks / 27_000_000,
    averageBitrate: durationTicks > 0 ? coveredBytes * 8 * 27_000_000 / durationTicks : 0
  };
}

export function clearPcrIndexCache() {
  cache.clear();
  weights.clear(); memoryBytes = 0;
}

export function forgetPcrIndex(filePath:string){
 const key=sourcePathKey(filePath);cache.delete(key);memoryBytes-=weights.get(key)??0;weights.delete(key);
}
