import { createRequire } from "node:module";
import { inspectTs } from "./core.js";
import { SectionAssembler } from "./psi-scanner.js";
import { sectionCrc } from "./arib-metadata.js";
const require = createRequire(import.meta.url);
const Packet = require("aribts/lib/packet") as new (b: Buffer) => { decode(): { PID: number; payload_unit_start_indicator: number; data_byte?: Buffer } };
const pts = (b: Buffer) => ((b[0] >> 1) & 7) * 2 ** 30 + b[1] * 2 ** 22 + (b[2] >> 1) * 2 ** 15 + b[3] * 2 ** 7 + (b[4] >> 1);

export function auditAdts(data: Buffer) {
  let offset = 0, frames = 0, leadingBytes = 0;
  const kinds: Record<string, number> = {};
  let first: { mpegId: number; profile: number; sampleFrequencyIndex: number; channelConfiguration: number; hex: string } | undefined;
  while (offset + 7 <= data.length) {
    const h = data.subarray(offset, offset + 7);
    if (h[0] !== 255 || (h[1] & 0xf6) !== 0xf0) {
      if (frames) return { frames, kinds, first, leadingBytes, trailingBytes: data.length - offset, invalidInterior: true };
      offset++; leadingBytes++; continue;
    }
    const length = ((h[3] & 3) << 11) | (h[4] << 3) | (h[5] >> 5);
    if (length < (h[1] & 1 ? 7 : 9)) throw new Error("Invalid ADTS frame length");
    if (offset + length > data.length) break;
    const fields = { mpegId: (h[1] >> 3) & 1, profile: (h[2] >> 6) + 1, sampleFrequencyIndex: (h[2] >> 2) & 15, channelConfiguration: ((h[2] & 1) << 2) | (h[3] >> 6) };
    first ??= { ...fields, hex: h.toString("hex") };
    const key = JSON.stringify(fields); kinds[key] = (kinds[key] || 0) + 1;
    frames++; offset += length;
  }
  return { frames, kinds, first, leadingBytes, trailingBytes: data.length - offset, invalidInterior: false };
}

/** Read-only structural audit. Reuses TS decoder/PSI assembly; no delivery code. */
export function auditExperimentalAudio(bytes: Buffer) {
  const ts = inspectTs(bytes);
  if (!ts.packetSize || ts.syncOffset === null || ts.pmtPid === null || !ts.audioPids.length) throw new Error("Audio/PMT not found");
  const pid = ts.audioPids[0], assembler = new SectionAssembler();
  const sections: Buffer[] = [], pes: { streamId: number; pts?: number; bytes: Buffer }[] = [];
  let parts: Buffer[] = [], started = false, incompletePes = 0;
  const finish = () => {
    if (!parts.length) return;
    const b = Buffer.concat(parts); parts = [];
    if (b.length < 9 || b[8] + 9 > b.length) { incompletePes++; return; }
    const size = b.readUInt16BE(4); if (!size || size + 6 > b.length) { incompletePes++; return; }
    pes.push({ streamId: b[3], pts: b[7] & 128 && b[8] >= 5 ? pts(b.subarray(9, 14)) : undefined, bytes: b.subarray(9 + b[8], 6 + size) });
  };
  for (let base = 0; base + ts.packetSize <= bytes.length; base += ts.packetSize) {
    const raw = bytes.subarray(base + ts.syncOffset, base + ts.syncOffset + 188), p = new Packet(raw).decode();
    if (p.PID === ts.pmtPid) for (const s of assembler.feed(raw)) if (s[0] === 2 && sectionCrc(s) === 0 && !sections.some(a => a.equals(s))) sections.push(s);
    if (p.PID !== pid || !p.data_byte?.length) continue;
    if (p.payload_unit_start_indicator) { finish(); started = p.data_byte.subarray(0, 3).equals(Buffer.from([0, 0, 1])); }
    if (started) parts.push(p.data_byte);
  }
  finish();
  const descriptors = (b: Buffer) => {
    const out: { tag: number; hex: string }[] = [];
    for (let i = 0; i + 2 <= b.length;) { const end = i + 2 + b[i + 1]; if (end > b.length) throw new Error("Invalid PMT descriptor"); out.push({ tag: b[i], hex: b.subarray(i + 2, end).toString("hex") }); i = end; }
    return out;
  };
  const pmts = sections.map(s => {
    const programLength = ((s[10] & 15) << 8) | s[11];
    const streams: { pid: number; streamType: number; descriptors: ReturnType<typeof descriptors> }[] = [];
    for (let i = 12 + programLength; i + 5 <= s.length - 4;) {
      const length = ((s[i + 3] & 15) << 8) | s[i + 4];
      if (i + 5 + length > s.length - 4) throw new Error("Invalid PMT ES loop");
      streams.push({ pid: ((s[i + 1] & 31) << 8) | s[i + 2], streamType: s[i], descriptors: descriptors(s.subarray(i + 5, i + 5 + length)) }); i += 5 + length;
    }
    return { version: (s[5] >> 1) & 31, programDescriptors: descriptors(s.subarray(12, 12 + programLength)), audio: streams.filter(s => s.pid === pid) };
  });
  const times = pes.flatMap(p => p.pts === undefined ? [] : [p.pts]);
  const deltas = times.slice(1).map((t, i) => ((t - times[i] + 2 ** 32) % (2 ** 33) + 2 ** 33) % (2 ** 33) - 2 ** 32);
  return { packetSize: ts.packetSize, audioPid: pid, pmts, psiStats: assembler.stats, pes: { count: pes.length, streamIds: [...new Set(pes.map(p => p.streamId))], firstPtsSeconds: times[0] / 90000, lastPtsSeconds: times.at(-1)! / 90000, ptsIntervalsMs: deltas.length ? { min: Math.min(...deltas) / 90, max: Math.max(...deltas) / 90, negative: deltas.filter(d => d < 0).length } : null, incompleteExcluded: incompletePes }, adts: auditAdts(Buffer.concat(pes.map(p => p.bytes))) };
}
