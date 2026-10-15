import { PcrIndex, Profile } from './core.js';

export function timeSeekProfile(profile: Profile): Profile {
  // Full random access is advertised by OP. The FLAGS time-seek bit describes
  // limited operation, so preserve the successful recording's flags here.
  return { ...profile, op: '10' };
}

function npt(value: string): number {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const clock = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(value);
  if (!clock) throw new RangeError('Invalid NPT');
  return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
}
export function parseTimeSeek(header: string, duration: number) {
  const match = /^npt=([^\s-]+)-([^\s-]*)$/.exec(header.trim());
  if (!match) throw new RangeError('Invalid TimeSeekRange');
  const start = npt(match[1]), end = match[2] ? npt(match[2]) : duration;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= duration || end <= start)
    throw new RangeError('Unsatisfiable TimeSeekRange');
  return { start, end: Math.min(duration, end) };
}

// Use unwrapped PCR, not the modulo ATS header, for the NPT clock.
export function packetTime(index: PcrIndex, packet: number): number {
  const points = index.points;
  if (points.length < 2 || index.discontinuities || index.invalidIntervals) throw new RangeError('Continuous PCR required');
  let low = 0, high = points.length - 1;
  while (low <= high) { const mid = (low + high) >>> 1; if (points[mid].packet <= packet) low = mid + 1; else high = mid - 1; }
  const a = points[Math.max(0, Math.min(points.length - 2, high))];
  const b = points[Math.max(1, Math.min(points.length - 1, high + 1))];
  const ticks = a.unwrappedPcr + (packet - a.packet) * (b.unwrappedPcr - a.unwrappedPcr) / (b.packet - a.packet);
  const first = points[0], second = points[1];
  const origin = first.unwrappedPcr - first.packet * (second.unwrappedPcr - first.unwrappedPcr) / (second.packet - first.packet);
  return (ticks - origin) / 27_000_000;
}
export function timeSeekSlice(index: PcrIndex, blockBytes: number, header: string) {
  const duration = packetTime(index, index.packetCount);
  const requested = parseTimeSeek(header, duration), packetsPerBlock = blockBytes / 192;
  function packetAt(seconds: number) {
    let low = 0, high = index.packetCount;
    while (low < high) { const mid = Math.floor((low + high + 1) / 2); if (packetTime(index, mid) <= seconds) low = mid; else high = mid - 1; }
    return low;
  }
  const firstPacket = Math.floor(packetAt(requested.start) / packetsPerBlock) * packetsPerBlock;
  const endPacket = Math.min(index.packetCount, Math.max(firstPacket + packetsPerBlock,
    Math.ceil((packetAt(requested.end) + (requested.end < duration ? 1 : 0)) / packetsPerBlock) * packetsPerBlock));
  const payloadBytes = (endPacket - firstPacket) * 192;
  const startByte = firstPacket * 192 + firstPacket / packetsPerBlock * 14;
  const wireBytes = payloadBytes + Math.ceil(payloadBytes / blockBytes) * 14;
  return { requested, duration, actualStart: Math.max(0, packetTime(index, firstPacket)),
    actualEnd: packetTime(index, endPacket), firstPacket, endPacket, payloadBytes, startByte, wireBytes };
}
export const formatNpt = (value: number) => value.toFixed(3);
