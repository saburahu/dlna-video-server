import { PCR_WRAP, readPcr, type PcrIndex } from "./core.js";

/** Bounded diagnostic only: retain every original 188-byte packet, add adaptation-only PCR. */
export function insertExperimentalPcr(source: Buffer, index: PcrIndex, maximumMs = 50) {
  if (source.length % 188 || index.packetCount !== source.length / 188 || index.points.length < 2 ||
      index.discontinuities || index.invalidIntervals || !Number.isFinite(maximumMs) || maximumMs <= 0 || maximumMs > 100)
    throw new Error("Aligned continuous PCR diagnostic sample required");
  const insertions = new Map<number, number>();
  for (let i = 1; i < index.points.length; i++) {
    const a = index.points[i - 1], b = index.points[i], delta = b.unwrappedPcr - a.unwrappedPcr;
    const pieces = Math.ceil(delta / (maximumMs * 27000));
    if (pieces > b.packet - a.packet || delta <= 0 || delta > 27000000) throw new Error("PCR gap cannot be safely subdivided");
    for (let j = 1; j < pieces; j++) {
      const packet = Math.round(a.packet + (b.packet - a.packet) * j / pieces);
      if (packet <= a.packet || packet >= b.packet || insertions.has(packet)) throw new Error("Ambiguous insertion position");
      insertions.set(packet, Math.round(a.unwrappedPcr + delta * (packet - a.packet) / (b.packet - a.packet)));
    }
  }
  const output = Buffer.alloc(source.length + insertions.size * 188);
  let out = 0, continuity: number | undefined;
  for (let i = 0; i < index.packetCount; i++) {
    const p = source.subarray(i * 188, (i + 1) * 188);
    if (p[0] !== 0x47) throw new Error("TS sync missing");
    if (insertions.has(i)) {
      if (continuity === undefined) throw new Error("PCR PID continuity unknown");
      const pcr = ((insertions.get(i)! % PCR_WRAP) + PCR_WRAP) % PCR_WRAP;
      const base = Math.floor(pcr / 300), ext = pcr % 300;
      const q = output.subarray(out, out + 188); q.fill(0xff);
      q[0] = 0x47; q[1] = index.pid >> 8; q[2] = index.pid & 255; q[3] = 0x20 | continuity;
      q[4] = 183; q[5] = 0x10;
      q[6] = Math.floor(base / 2 ** 25); q[7] = Math.floor(base / 2 ** 17) & 255;
      q[8] = Math.floor(base / 2 ** 9) & 255; q[9] = Math.floor(base / 2) & 255;
      q[10] = (base % 2) * 128 | 0x7e | (ext >> 8); q[11] = ext & 255;
      if (readPcr(q, 0) !== pcr) throw new Error("PCR encoding mismatch");
      out += 188;
    }
    p.copy(output, out); out += 188;
    if (((p[1] & 31) << 8 | p[2]) === index.pid) continuity = p[3] & 15;
  }
  return { output, insertedPackets: insertions.size, positions: [...insertions.keys()] };
}
