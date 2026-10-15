/** Offline diagnostic of presentation timing, not a complete CPB conformance test. */
export function auditVideoClock(trace: string, packets: { pts: number; key: boolean }[]) {
  const values = (field: string) => [...trace.matchAll(new RegExp(`\\d+\\s+${field}\\s+[01]+\\s+=\\s+(\\d+)`, "g"))].map(m => Number(m[1]));
  const unique = (field: string) => [...new Set(values(field))];
  const tick = unique("num_units_in_tick"), scale = unique("time_scale"), removal = values("cpb_removal_delay"), output = values("dpb_output_delay");
  if (tick.length !== 1 || scale.length !== 1 || tick[0] <= 0 || scale[0] <= 0 || !packets.length || removal.length !== packets.length || output.length !== packets.length)
    throw new Error("Single audited SPS clock and one HRD picture timing per packet required");
  if (!packets.every(p => Number.isSafeInteger(p.pts))) throw new Error("Invalid packet timestamp");
  const mismatches: { index: number; ptsIntervalMs: number; hrdIntervalMs: number }[] = [];
  let resets = 0;
  for (let i = 1; i < packets.length; i++) {
    const elapsed = (packets[i].pts - packets[i - 1].pts) / 90000;
    if (elapsed <= 0) throw new Error("Non-monotonic presentation timestamp");
    const delta = removal[i] - removal[i - 1];
    if (delta < 0) {
      // The audited encoders start a new buffering period at an IDR. Its delay
      // counter can reset on that IDR or on the following picture.
      if (!packets[i].key && !packets[i - 1].key) throw new Error("Unexpected HRD reset/wrap; requires separate audit");
      resets++; continue;
    }
    const hrd = (delta + output[i] - output[i - 1]) * tick[0] / scale[0];
    if (Math.abs(hrd - elapsed) > 2 / 90000) mismatches.push({ index: i, ptsIntervalMs: elapsed * 1000, hrdIntervalMs: hrd * 1000 });
  }
  return { frames: packets.length, clockTickSeconds: tick[0] / scale[0], fixedFrameRateValues: unique("fixed_frame_rate_flag"), resets, mismatchCount: mismatches.length, mismatchExamples: mismatches.slice(0, 10) };
}
