import { inspectTs, PCR_WRAP, readPcr } from "./core.js";

function timestamp(bytes: Buffer, offset: number): number | null {
  if (offset + 5 > bytes.length || !(bytes[offset] & 1) || !(bytes[offset + 2] & 1) || !(bytes[offset + 4] & 1)) return null;
  return ((bytes[offset] >> 1) & 7) * 2 ** 30 + bytes[offset + 1] * 2 ** 22 +
    (bytes[offset + 2] >> 1) * 2 ** 15 + bytes[offset + 3] * 2 ** 7 + (bytes[offset + 4] >> 1);
}

/** Read-only, bounded startup inspection. This is structural evidence, not a decoder verdict. */
export function inspectStartup(data: Buffer) {
  const ts = inspectTs(data);
  if (!ts.packetSize || ts.syncOffset === null) return { inspectedBytes: data.length, ts, error: "TS同期が見つかりません" };
  const size = ts.packetSize, sync = ts.syncOffset;
  const byPid = new Map<number, { pid: number; packets: number; scrambled: number; transportErrors: number;
    continuityErrors: number; duplicateCounters: number; lastCounter?: number;
    firstPacket: number; firstPes?: { packet: number; ptsSeconds: number | null; dtsSeconds: number | null; ptsMinusPcrMs: number | null };
    chunks: { offset: number; sourceOffset: number; data: Buffer }[]; payloadBytes: number }>();
  let firstPatPacket: number | null = null, firstPmtPacket: number | null = null;
  let firstPcr: { packet: number; seconds: number } | null = null;
  let syncErrors = 0;
  for (let base = 0, packetNumber = 0; base + size <= data.length; base += size, packetNumber++) {
    const packet = data.subarray(base + sync, base + sync + 188);
    if (packet[0] !== 0x47) { syncErrors++; continue; }
    const pid = ((packet[1] & 31) << 8) | packet[2], adaptation = (packet[3] >> 4) & 3;
    let state = byPid.get(pid);
    if (!state) {
      state = { pid, packets: 0, scrambled: 0, transportErrors: 0, continuityErrors: 0,
        duplicateCounters: 0, firstPacket: packetNumber, chunks: [], payloadBytes: 0 };
      byPid.set(pid, state);
    }
    state.packets++;
    if (packet[3] & 0xc0) state.scrambled++;
    if (packet[1] & 0x80) state.transportErrors++;
    const discontinuity = (adaptation === 2 || adaptation === 3) && packet[4] > 0 && !!(packet[5] & 0x80);
    if (discontinuity) state.lastCounter = undefined;
    const pcr = readPcr(packet, 0);
    if (pid === ts.pcrPid && pcr !== null && !firstPcr) firstPcr = { packet: packetNumber, seconds: pcr / 27_000_000 };
    if (adaptation !== 1 && adaptation !== 3) continue;
    const counter = packet[3] & 15;
    if (pid !== 0x1fff && state.lastCounter !== undefined) {
      if (counter === state.lastCounter) state.duplicateCounters++;
      else if (counter !== ((state.lastCounter + 1) & 15)) state.continuityErrors++;
    }
    state.lastCounter = counter;
    const payloadStart = adaptation === 3 ? 5 + packet[4] : 4;
    if (payloadStart >= 188) continue;
    const payload = packet.subarray(payloadStart);
    if (packet[1] & 0x40) {
      if (pid === 0 && firstPatPacket === null) firstPatPacket = packetNumber;
      if (pid === ts.pmtPid && firstPmtPacket === null) firstPmtPacket = packetNumber;
      if (!state.firstPes && payload.length >= 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
        const pts = payload[7] & 0x80 ? timestamp(payload, 9) : null;
        const dts = (payload[7] & 0xc0) === 0xc0 ? timestamp(payload, 14) : null;
        const predictedPcr = ts.pcr ? ts.pcr.firstPcr + (packetNumber - ts.pcr.firstPacket) * ts.pcr.ticksPerPacket : null;
        const difference = pts === null || predictedPcr === null ? null :
          ((pts * 300 - predictedPcr + PCR_WRAP / 2) % PCR_WRAP + PCR_WRAP) % PCR_WRAP - PCR_WRAP / 2;
        state.firstPes = { packet: packetNumber, ptsSeconds: pts === null ? null : pts / 90_000,
          dtsSeconds: dts === null ? null : dts / 90_000, ptsMinusPcrMs: difference === null ? null : difference / 27_000 };
      }
    }
    if (ts.videoPids.includes(pid)) {
      state.chunks.push({ offset: state.payloadBytes, sourceOffset: base + sync + payloadStart, data: payload });
      state.payloadBytes += payload.length;
    }
  }
  const pids = [...byPid.values()].map(({ chunks, payloadBytes, lastCounter, ...state }) => {
    if (!chunks.length) return state;
    const payload = Buffer.concat(chunks.map(chunk => chunk.data));
    const location = (offset: number) => {
      const chunk = chunks.find(chunk => offset >= chunk.offset && offset < chunk.offset + chunk.data.length)!;
      return { sourceOffset: chunk.sourceOffset + offset - chunk.offset, packet: Math.floor(chunk.sourceOffset / size) };
    };
    const sequence = payload.indexOf(Buffer.from([0, 0, 1, 0xb3]));
    let firstIFrame = -1;
    for (let offset = 0; offset < payload.length - 6;) {
      const picture = payload.indexOf(Buffer.from([0, 0, 1, 0]), offset);
      if (picture < 0) break;
      if (picture + 6 <= payload.length && ((payload[picture + 5] >> 3) & 7) === 1) { firstIFrame = picture; break; }
      offset = picture + 4;
    }
    return { ...state,
      firstMpeg2Sequence: sequence >= 0 && sequence + 7 <= payload.length ? { ...location(sequence),
        width: (payload[sequence + 4] << 4) | (payload[sequence + 5] >> 4),
        height: ((payload[sequence + 5] & 15) << 8) | payload[sequence + 6] } : null,
      firstMpeg2IFrame: firstIFrame < 0 ? null : location(firstIFrame) };
  });
  return { inspectedBytes: data.length, packetSize: size, syncErrors, firstPatPacket, firstPmtPacket, firstPcr,
    ts, pids, caveat: "先頭範囲のみの構造検査。PTS-PCR差は初期PCR傾きから推定。カウンター重複はパケット重複の証明ではない。" };
}
