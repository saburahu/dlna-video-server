/** Offline MPEG-TS mux experiment; no normal playback settings are involved. */
export const EXPERIMENTAL_CBR_RATE = 12_500_000;
export function experimentalCbrArguments(input: string, output: string) {
  return ["-hide_banner", "-nostdin", "-n", "-copyts", "-i", input,
    "-map", "0:v:0", "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
    "-c", "copy", "-mpegts_copyts", "0", "-muxdelay", "0.7", "-avoid_negative_ts", "disabled",
    "-pcr_period", "50", "-muxrate", String(EXPERIMENTAL_CBR_RATE), "-f", "mpegts", output];
}
export interface CopiedPacket {
  stream_index: number; pts: number | string; dts: number | string;
  size: number | string; data_hash: string; flags: string;
}
/** One common 90kHz offset is allowed; per-stream offsets and any ES change are rejected. */
export function validateCopiedTimeline(before: CopiedPacket[], after: CopiedPacket[]) {
  if (!before.length || before.length !== after.length) throw new Error("Packet count changed");
  const firstBefore = before.find(p => p.stream_index === 0), firstAfter = after.find(p => p.stream_index === 0);
  if (!firstBefore || !firstAfter) throw new Error("Video missing");
  const shiftTicks = Number(firstAfter.pts) - Number(firstBefore.pts);
  if (!Number.isSafeInteger(shiftTicks)) throw new Error("Invalid timestamp offset");
  for (const stream of new Set(before.map(p => p.stream_index))) {
    const a = before.filter(p => p.stream_index === stream), b = after.filter(p => p.stream_index === stream);
    if (a.length !== b.length) throw new Error("Stream packet count changed");
    a.forEach((p, i) => {
      const q = b[i];
      if (!p.data_hash || p.data_hash !== q.data_hash || Number(p.size) !== Number(q.size) || p.flags !== q.flags)
        throw new Error("ES bytes or flags changed");
      for (const field of ["pts", "dts"] as const) {
        if (!Number.isSafeInteger(Number(p[field])) || !Number.isSafeInteger(Number(q[field])) ||
            Number(q[field]) - Number(p[field]) !== shiftTicks) throw new Error("Relative VFR/AV timeline changed");
      }
    });
  }
  return { shiftTicks, shiftSeconds: shiftTicks / 90_000,
    videoPackets: before.filter(p => p.stream_index === 0).length,
    audioPackets: before.filter(p => p.stream_index === 1).length };
}
