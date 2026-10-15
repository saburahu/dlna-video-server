import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { REGZA_BUFFERED_PROFILE } from './playback-policy.js';

export type ProfileName = "standard" | "regza-zp2" | "regza-zp2-192" |
  "regza-zp2-192-paced" | "regza-zp2-192-paced-ats-minus-100ms" |
  "regza-zp2-192-paced-ats-minus-500ms" | "regza-zp2-192-paced-ats-minus-1000ms" |
  "regza-zp2-ats-cpi-01" | "regza-zp2-ats-little-endian" |
  "regza-zp2-ats-90khz" | "regza-zp2-ats-zero-based" |
  "container-188-tts" | "container-188-mpeg" | "container-192-mpeg" |
  "container-192-no-pn" | "container-192-op00" |
  "minimal" | "diagnostic" | typeof REGZA_BUFFERED_PROFILE;

export type AtsByteOrder = "big-endian" | "little-endian";
export type AtsClock = "27mhz" | "90khz";
export type AtsOrigin = "pcr-absolute" | "zero-based";

export interface Profile {
  name: ProfileName;
  label: string;
  mime: string;
  pn: string;
  itemClass: string;
  transferMode: "Streaming" | "Interactive";
  op: string;
  ci: string;
  flags: string;
  packetization: "source" | "tts-192";
  pacing: boolean;
  atsOffsetMs: number;
  atsByteOrder: AtsByteOrder;
  atsClock: AtsClock;
  atsOrigin: AtsOrigin;
  atsTopBits: 0 | 1 | 2 | 3;
}

const atsDefaults = {
  atsByteOrder: "big-endian" as const,
  atsClock: "27mhz" as const,
  atsOrigin: "pcr-absolute" as const,
  atsTopBits: 0 as const
};

export const profiles: Record<ProfileName, Profile> = {
  [REGZA_BUFFERED_PROFILE]: {
    name: REGZA_BUFFERED_PROFILE, label: 'REGZA ZP2（局所PCR＋先行バッファ）',
    mime: 'video/vnd.dlna.mpeg-tts', pn: 'MPEG_TS_JP_T',
    itemClass: 'object.item.videoItem.videoBroadcast', transferMode: 'Streaming',
    op: '10', ci: '0', flags: '01700000000000000000000000000000',
    packetization: 'tts-192', pacing: true, atsOffsetMs: -500, ...atsDefaults
  },
  standard: {
    name: "standard", label: "標準DLNA", mime: "video/vnd.dlna.mpeg-tts",
    pn: "", itemClass: "object.item.videoItem", transferMode: "Streaming",
    op: "01", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "source", pacing: false, atsOffsetMs: 0, ...atsDefaults
  },
  "regza-zp2": {
    name: "regza-zp2", label: "REGZA ZP2実験用", mime: "video/vnd.dlna.mpeg-tts",
    pn: "MPEG_TS_JP_T", itemClass: "object.item.videoItem.videoBroadcast",
    transferMode: "Streaming", op: "01", ci: "0",
    flags: "01700000000000000000000000000000",
    packetization: "source", pacing: false, atsOffsetMs: 0, ...atsDefaults
  },
  "regza-zp2-192": {
    name: "regza-zp2-192", label: "REGZA ZP2実験用（192変換）", mime: "video/vnd.dlna.mpeg-tts",
    pn: "MPEG_TS_JP_T", itemClass: "object.item.videoItem.videoBroadcast",
    transferMode: "Streaming", op: "01", ci: "0",
    flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: false, atsOffsetMs: 0, ...atsDefaults
  },
  "regza-zp2-192-paced": {
    name: "regza-zp2-192-paced", label: "REGZA ZP2実験用（PCR同期192変換＋実時間配信）",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast",
    transferMode: "Streaming", op: "01", ci: "0",
    flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: 0, ...atsDefaults
  },
  "regza-zp2-192-paced-ats-minus-100ms": {
    name: "regza-zp2-192-paced-ats-minus-100ms",
    label: "REGZA ZP2実験用（ATSをPCRより100ms前）",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast",
    transferMode: "Streaming", op: "01", ci: "0",
    flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -100, ...atsDefaults
  },
  "regza-zp2-192-paced-ats-minus-500ms": {
    name: "regza-zp2-192-paced-ats-minus-500ms",
    label: "REGZA ZP2実験用（ATSをPCRより500ms前）",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast",
    transferMode: "Streaming", op: "01", ci: "0",
    flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -500, ...atsDefaults
  },
  "regza-zp2-192-paced-ats-minus-1000ms": {
    name: "regza-zp2-192-paced-ats-minus-1000ms",
    label: "REGZA ZP2実験用（ATSをPCRより1秒前）",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast",
    transferMode: "Streaming", op: "01", ci: "0",
    flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -1000, ...atsDefaults
  },
  "regza-zp2-ats-cpi-01": {
    name: "regza-zp2-ats-cpi-01", label: "ATS表現実験（上位2bit＝01）",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast", transferMode: "Streaming",
    op: "01", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -500,
    ...atsDefaults, atsTopBits: 1
  },
  "regza-zp2-ats-little-endian": {
    name: "regza-zp2-ats-little-endian", label: "ATS表現実験（リトルエンディアン）",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast", transferMode: "Streaming",
    op: "01", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -500,
    ...atsDefaults, atsByteOrder: "little-endian"
  },
  "regza-zp2-ats-90khz": {
    name: "regza-zp2-ats-90khz", label: "ATS表現実験（90kHz値）",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast", transferMode: "Streaming",
    op: "01", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -500,
    ...atsDefaults, atsClock: "90khz"
  },
  "regza-zp2-ats-zero-based": {
    name: "regza-zp2-ats-zero-based", label: "ATS表現実験（0付近から開始）",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast", transferMode: "Streaming",
    op: "01", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -500,
    ...atsDefaults, atsOrigin: "zero-based"
  },
  "container-188-tts": {
    name: "container-188-tts", label: "【基準】188バイト＋従来TTS宣言",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast", transferMode: "Streaming",
    op: "01", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "source", pacing: true, atsOffsetMs: -500, ...atsDefaults
  },
  "container-188-mpeg": {
    name: "container-188-mpeg", label: "188バイト＋video/mpeg",
    mime: "video/mpeg", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast", transferMode: "Streaming",
    op: "01", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "source", pacing: true, atsOffsetMs: -500, ...atsDefaults
  },
  "container-192-mpeg": {
    name: "container-192-mpeg", label: "192バイトTTS＋video/mpeg",
    mime: "video/mpeg", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast", transferMode: "Streaming",
    op: "01", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -500, ...atsDefaults
  },
  "container-192-no-pn": {
    name: "container-192-no-pn", label: "192バイトTTS＋プロファイル名なし",
    mime: "video/vnd.dlna.mpeg-tts", pn: "",
    itemClass: "object.item.videoItem.videoBroadcast", transferMode: "Streaming",
    op: "01", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -500, ...atsDefaults
  },
  "container-192-op00": {
    name: "container-192-op00", label: "192バイトTTS＋OP=00",
    mime: "video/vnd.dlna.mpeg-tts", pn: "MPEG_TS_JP_T",
    itemClass: "object.item.videoItem.videoBroadcast", transferMode: "Streaming",
    op: "00", ci: "0", flags: "01700000000000000000000000000000",
    packetization: "tts-192", pacing: true, atsOffsetMs: -500, ...atsDefaults
  },
  minimal: {
    name: "minimal", label: "最小構成", mime: "video/mpeg",
    pn: "", itemClass: "object.item.videoItem", transferMode: "Streaming",
    op: "", ci: "", flags: "", packetization: "source", pacing: false, atsOffsetMs: 0, ...atsDefaults
  },
  diagnostic: {
    name: "diagnostic", label: "詳細診断", mime: "video/vnd.dlna.mpeg-tts",
    pn: "MPEG_TS_JP_T", itemClass: "object.item.videoItem",
    transferMode: "Streaming", op: "01", ci: "0",
    flags: "01700000000000000000000000000000",
    packetization: "source", pacing: false, atsOffsetMs: 0, ...atsDefaults
  }
};

export function contentFeatures(p: Profile): string {
  const parts = [
    p.pn && `DLNA.ORG_PN=${p.pn}`,
    p.op && `DLNA.ORG_OP=${p.op}`,
    p.ci && `DLNA.ORG_CI=${p.ci}`,
    p.flags && `DLNA.ORG_FLAGS=${p.flags}`
  ].filter(Boolean);
  return parts.join(";");
}

export function protocolInfo(p: Profile): string {
  return `http-get:*:${p.mime}:${contentFeatures(p) || "*"}`;
}

export function mediaSize(sourceSize: number, profile: Profile): number {
  return profile.packetization === "tts-192"
    ? Math.floor(sourceSize / 188) * 192
    : sourceSize;
}

export function atsForPacket(packetIndex: number, bitrate: number): number {
  return timestampTicksForPacket(packetIndex, bitrate) % 0x40000000;
}

export function timestampTicksForPacket(packetIndex: number, bitrate: number): number {
  const safeBitrate = Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 24_000_000;
  const ticksPerPacket = 188 * 8 * 27_000_000 / safeBitrate;
  return Math.floor(packetIndex * ticksPerPacket);
}

export function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export interface ByteRange { start: number; end: number; }

export interface TsInspection {
  packetSize: 188 | 192 | 204 | null;
  syncOffset: number | null;
  patFound: boolean;
  pmtPid: number | null;
  pmtFound: boolean;
  videoPids: number[];
  audioPids: number[];
  pcrPid: number | null;
  streams: { pid: number; streamType: number; kind: "video" | "audio" | "other"; codec: string }[];
  pcr: PcrTimeline | null;
}

export interface PcrTimeline {
  pid: number;
  firstPacket: number;
  firstPcr: number;
  lastPacket: number;
  lastPcr: number;
  sampleCount: number;
  ticksPerPacket: number;
  estimatedBitrate: number;
}

export interface PcrIndexPoint {
  packet: number;
  pcr: number;
  unwrappedPcr: number;
  discontinuityBefore: boolean;
}

export interface PcrIndex {
  pid: number;
  packetCount: number;
  points: PcrIndexPoint[];
  discontinuities: number;
  invalidIntervals: number;
  firstPacket: number;
  lastPacket: number;
  durationSeconds: number;
  averageBitrate: number;
}

export const PCR_WRAP = 2 ** 33 * 300;
const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);
const STREAM_NAMES: Record<number, string> = {
  0x01: "MPEG-1 Video", 0x02: "MPEG-2 Video", 0x03: "MPEG-1 Audio",
  0x04: "MPEG-2 Audio", 0x0f: "AAC", 0x10: "MPEG-4 Video",
  0x11: "HE-AAC", 0x1b: "H.264/AVC", 0x24: "H.265/HEVC",
  0x81: "AC-3", 0x87: "E-AC-3"
};

export function readPcr(packet: Buffer, sync: number): number | null {
  const adaptation = (packet[sync + 3] >> 4) & 0x03;
  if (adaptation !== 2 && adaptation !== 3) return null;
  const length = packet[sync + 4];
  if (length < 7 || sync + 11 >= packet.length || (packet[sync + 5] & 0x10) === 0) return null;
  const p = sync + 6;
  const base = packet[p] * 2 ** 25 + packet[p + 1] * 2 ** 17 +
    packet[p + 2] * 2 ** 9 + packet[p + 3] * 2 + (packet[p + 4] >> 7);
  const extension = ((packet[p + 4] & 1) << 8) | packet[p + 5];
  return base * 300 + extension;
}

export function atsFromTimeline(packetIndex: number, timeline: PcrTimeline): number {
  const ticks = timeline.firstPcr + (packetIndex - timeline.firstPacket) * timeline.ticksPerPacket;
  return ((Math.round(ticks) % 0x40000000) + 0x40000000) % 0x40000000;
}

function normalizedAts(ticks: number): number {
  return ((Math.round(ticks) % 0x40000000) + 0x40000000) % 0x40000000;
}

export function offsetAts(ats: number, offsetMs: number): number {
  return normalizedAts(ats + offsetMs * 27_000);
}

export function atsFromPcrIndex(packetIndex: number, index: PcrIndex): number {
  return normalizedAts(timestampTicksFromPcrIndex(packetIndex, index));
}

// Keep the unwrapped 27MHz clock until the output format selects its counter width.
export function timestampTicksFromPcrIndex(packetIndex: number, index: PcrIndex): number {
  const points = index.points;
  if (points.length < 2) throw new Error("PCR索引に補間可能な標本がありません");

  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (points[mid].packet <= packetIndex) low = mid + 1;
    else high = mid - 1;
  }

  let leftIndex = Math.max(0, Math.min(points.length - 2, high));
  let rightIndex = leftIndex + 1;

  // 不連続をまたぐ補間は禁止し、要求位置と同じ側にある健全な区間を使う。
  if (points[rightIndex].discontinuityBefore) {
    if (packetIndex < points[rightIndex].packet && leftIndex > 0) {
      rightIndex = leftIndex;
      leftIndex--;
    } else if (rightIndex + 1 < points.length) {
      leftIndex = rightIndex;
      rightIndex++;
    }
  }

  const left = points[leftIndex];
  const right = points[rightIndex];
  const packetDelta = right.packet - left.packet;
  if (packetDelta <= 0) throw new Error("PCR索引のパケット位置が不正です");
  const slope = (right.unwrappedPcr - left.unwrappedPcr) / packetDelta;
  if (!Number.isFinite(slope) || slope <= 0) throw new Error("PCR索引の時間軸が不正です");
  return Math.round(left.unwrappedPcr + (packetIndex - left.packet) * slope);
}

function payloadOffset(packet: Buffer, sync: number): number | null {
  const adaptation = (packet[sync + 3] >> 4) & 0x03;
  if (adaptation === 0 || adaptation === 2) return null;
  let offset = sync + 4;
  if (adaptation === 3) offset += 1 + packet[offset];
  return offset < packet.length ? offset : null;
}

function psiSection(packet: Buffer, sync: number): Buffer | null {
  if ((packet[sync + 1] & 0x40) === 0) return null;
  const offset = payloadOffset(packet, sync);
  if (offset === null || offset >= packet.length) return null;
  const start = offset + 1 + packet[offset];
  return start + 3 <= packet.length ? packet.subarray(start) : null;
}

/**
 * DLNAへ送る前の軽量診断用。先頭バッファだけからTSのパケット間隔と
 * PAT/PMTを調べるため、番組本体には一切変更を加えない。
 */
export function inspectTs(data: Buffer): TsInspection {
  let packetSize: TsInspection["packetSize"] = null;
  let syncOffset: number | null = null;
  let bestHits = 0;

  for (const size of [188, 192, 204] as const) {
    for (let offset = 0; offset < Math.min(size, data.length); offset++) {
      let hits = 0;
      for (let pos = offset; pos < data.length && hits < 8; pos += size) {
        if (data[pos] !== 0x47) break;
        hits++;
      }
      if (hits > bestHits) {
        bestHits = hits;
        packetSize = size;
        syncOffset = offset;
      }
    }
  }
  if (bestHits < 3 || packetSize === null || syncOffset === null) {
    return { packetSize: null, syncOffset: null, patFound: false, pmtPid: null, pmtFound: false,
      videoPids: [], audioPids: [], pcrPid: null, streams: [], pcr: null };
  }

  let patFound = false;
  let pmtPid: number | null = null;
  let pmtFound = false;
  let pcrPid: number | null = null;
  const videoPids = new Set<number>();
  const audioPids = new Set<number>();
  const streams = new Map<number, TsInspection["streams"][number]>();
  const pcrSamples: { packet: number; value: number }[] = [];

  for (let pos = syncOffset; pos + 4 <= data.length; pos += packetSize) {
    if (data[pos] !== 0x47) continue;
    const pid = ((data[pos + 1] & 0x1f) << 8) | data[pos + 2];
    const packet = data.subarray(pos, Math.min(pos + packetSize, data.length));
    const pcr = readPcr(packet, 0);
    if (pcr !== null) pcrSamples.push({ packet: Math.floor((pos - syncOffset) / packetSize), value: pcr });
    const section = psiSection(packet, 0);
    if (!section) continue;

    if (pid === 0 && section[0] === 0x00 && section.length >= 12) {
      patFound = true;
      const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
      const end = Math.min(section.length - 4, 3 + sectionLength - 4);
      for (let i = 8; i + 3 < end; i += 4) {
        const programNumber = (section[i] << 8) | section[i + 1];
        if (programNumber !== 0) {
          pmtPid = ((section[i + 2] & 0x1f) << 8) | section[i + 3];
          break;
        }
      }
    } else if (pmtPid !== null && pid === pmtPid && section[0] === 0x02 && section.length >= 16) {
      pmtFound = true;
      const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
      pcrPid = ((section[8] & 0x1f) << 8) | section[9];
      const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
      const end = Math.min(section.length - 4, 3 + sectionLength - 4);
      for (let i = 12 + programInfoLength; i + 4 < end;) {
        const streamType = section[i];
        const elementaryPid = ((section[i + 1] & 0x1f) << 8) | section[i + 2];
        const esInfoLength = ((section[i + 3] & 0x0f) << 8) | section[i + 4];
        const kind = VIDEO_TYPES.has(streamType) ? "video" : AUDIO_TYPES.has(streamType) ? "audio" : "other";
        if (kind === "video") videoPids.add(elementaryPid);
        if (kind === "audio") audioPids.add(elementaryPid);
        streams.set(elementaryPid, {
          pid: elementaryPid, streamType, kind, codec: STREAM_NAMES[streamType] || `不明 (0x${streamType.toString(16).padStart(2, "0")})`
        });
        i += 5 + esInfoLength;
      }
    }
  }
  const selected = pcrPid === null ? [] : pcrSamples.filter(x => {
    const pos = syncOffset! + x.packet * packetSize!;
    return (((data[pos + 1] & 0x1f) << 8) | data[pos + 2]) === pcrPid;
  });
  let pcr: PcrTimeline | null = null;
  if (pcrPid !== null && selected.length >= 2) {
    const first = selected[0];
    const last = selected[selected.length - 1];
    let delta = last.value - first.value;
    if (delta < 0) delta += PCR_WRAP;
    const ticksPerPacket = delta / (last.packet - first.packet);
    if (Number.isFinite(ticksPerPacket) && ticksPerPacket > 0) {
      pcr = {
        pid: pcrPid, firstPacket: first.packet, firstPcr: first.value,
        lastPacket: last.packet, lastPcr: last.value, sampleCount: selected.length,
        ticksPerPacket, estimatedBitrate: 188 * 8 * 27_000_000 / ticksPerPacket
      };
    }
  }
  return { packetSize, syncOffset, patFound, pmtPid, pmtFound, videoPids: [...videoPids],
    audioPids: [...audioPids], pcrPid, streams: [...streams.values()], pcr };
}

export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) throw new RangeError("Invalid Range");
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeError("Invalid suffix");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new RangeError("Unsatisfiable Range");
  }
  return { start, end: Math.min(end, size - 1) };
}

export function stableId(path: string): string {
  return createHash("sha1").update(path).digest("hex").slice(0, 20);
}

export function formatDuration(seconds?: number): string {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000`;
}

export function isPrivateAddress(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/, "");
  return clean === "127.0.0.1" || clean === "::1" ||
    /^10\./.test(clean) || /^192\.168\./.test(clean) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(clean) || /^169\.254\./.test(clean);
}

export function safeStat(path: string) {
  try { return statSync(path); } catch { return null; }
}
