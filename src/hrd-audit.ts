/** Offline single-SPS/NAL-HRD diagnostic. No streaming or encoder parameters are changed. */
export interface HrdPicture {
  bits: number; removalDelay: number; outputDelay: number;
  initialDelay?: number; initialOffset?: number;
}
export function parseHrdTrace(trace: string) {
  const field = (s: string, name: string): number | undefined => {
    const m = s.match(new RegExp(`\\b${name}(?:\\[0\\])?\\s+[01]+\\s*=\\s*(\\d+)`));
    return m ? Number(m[1]) : undefined;
  };
  const required = (s: string, name: string) => { const n = field(s, name); if (n === undefined) throw new Error(`Missing HRD ${name}`); return n; };
  const chunks = trace.split(/(?=\[trace_headers[^\r\n]*Packet:)/), sps = chunks.shift()!;
  if (required(sps, "nal_hrd_parameters_present_flag") !== 1 || required(sps, "vcl_hrd_parameters_present_flag") !== 0 || required(sps, "cpb_cnt_minus1") !== 0)
    throw new Error("Only one NAL HRD schedule supported");
  const names = ["num_units_in_tick", "time_scale", "bit_rate_scale", "cpb_size_scale", "bit_rate_value_minus1", "cpb_size_value_minus1",
    "nal_hrd_parameters_present_flag", "vcl_hrd_parameters_present_flag", "cpb_cnt_minus1", "cbr_flag", "low_delay_hrd_flag",
    "max_num_ref_frames", "max_num_reorder_frames", "max_dec_frame_buffering"];
  for (const n of names) {
    const values = [...trace.matchAll(new RegExp(`\\b${n}(?:\\[0\\])?\\s+[01]+\\s*=\\s*(\\d+)`, "g"))].map(m=>Number(m[1]));
    if (new Set(values).size !== 1) throw new Error(`Changing SPS ${n} requires separate audit`);
  }
  const rate = (required(sps, "bit_rate_value_minus1") + 1) * 2 ** (6 + required(sps, "bit_rate_scale"));
  const capacity = (required(sps, "cpb_size_value_minus1") + 1) * 2 ** (4 + required(sps, "cpb_size_scale"));
  const clock = required(sps, "num_units_in_tick") / required(sps, "time_scale");
  const pictures: HrdPicture[] = chunks.map(s => ({ bits: Number(s.match(/Packet: (\d+) bytes/)?.[1]) * 8,
    removalDelay: required(s, "cpb_removal_delay"), outputDelay: required(s, "dpb_output_delay"),
    initialDelay: field(s, "initial_cpb_removal_delay"), initialOffset: field(s, "initial_cpb_removal_delay_offset") }));
  return { rate, capacity, clock, cbr: required(sps, "cbr_flag") === 1, lowDelay: required(sps, "low_delay_hrd_flag") === 1,
    dpb: { refs: required(sps, "max_num_ref_frames"), reorder: required(sps, "max_num_reorder_frames"), frames: required(sps, "max_dec_frame_buffering") }, pictures };
}
export interface ArrivalSpan { start: number; end: number; bits: number }
/** Annex C nominal times / single VBR schedule; underflow is reported, never hidden by rebuffering. */
export function hrdSchedule(pictures: HrdPicture[], rate: number, clock: number, cbr = false) {
  if (!pictures.length || !(rate > 0) || !(clock > 0) || pictures[0].initialDelay === undefined) throw new Error("Initial buffering period required");
  let base = pictures[0].initialDelay / 90000, delay = pictures[0].initialDelay, offset = pictures[0].initialOffset ?? 0, previousEnd = 0;
  const schedule = pictures.map((p, i) => {
    if (!(p.bits > 0) || !Number.isFinite(p.bits) || p.removalDelay < 0 || p.outputDelay < 0) throw new Error("Invalid AU fields");
    const removal = i === 0 ? base : base + clock * p.removalDelay;
    const period = p.initialDelay !== undefined;
    if (period) { delay = p.initialDelay!; offset = p.initialOffset ?? 0; }
    const earliest = removal - (period ? delay : delay + offset) / 90000;
    const start = i === 0 ? 0 : cbr ? previousEnd : Math.max(previousEnd, earliest);
    const end = start + p.bits / rate; previousEnd = end;
    if (period) base = removal;
    return { start, end, bits: p.bits, removal, output: removal + clock * p.outputDelay, margin: removal - end, period };
  });
  if (schedule.some((s,i)=>!Number.isFinite(s.removal) || (i && s.removal <= schedule[i-1].removal))) throw new Error("Non-monotonic HRD nominal removal (wrap/reset needs separate audit)");
  return schedule;
}
/** Continuous arrival integration; capacity checks do not claim receiver CPB behavior. */
export function bufferOccupancy(arrivals: ArrivalSpan[], removals: { time: number; bits: number }[], capacity: number) {
  if (!(capacity > 0) || arrivals.some((a,i)=>a.end<a.start || a.bits<0 || !Number.isFinite(a.start+a.end+a.bits) || (i && a.start<arrivals[i-1].end-1e-9)) ||
    removals.some((r,i)=>!Number.isFinite(r.time+r.bits) || r.bits<0 || (i && r.time<removals[i-1].time))) throw new Error("Ordered finite arrivals/removals required");
  const events = arrivals.flatMap(a=>[a.start,a.end]).concat(removals.map(r=>r.time)).sort((a,b)=>a-b);
  const prefix = [0]; for (const a of arrivals) prefix.push(prefix.at(-1)!+a.bits);
  const arrived = (time: number) => {
    let lo=0,hi=arrivals.length; while(lo<hi){const m=(lo+hi)>>>1;if(arrivals[m].end<=time)lo=m+1;else hi=m;}
    let bits=prefix[lo];const a=arrivals[lo];if(a && time>=a.start)bits+=a.end===a.start?a.bits:a.bits*(time-a.start)/(a.end-a.start);return bits;
  };
  let removed=0,j=0,maxBits=0,minBits=0;const points:{time:number;before:number;after:number}[]=[];
  for (const time of [...new Set(events)]) {
    const before=arrived(time)-removed;maxBits=Math.max(maxBits,before);
    while(j<removals.length && removals[j].time<=time){removed+=removals[j++].bits;}
    const after=arrived(time)-removed;minBits=Math.min(minBits,after);points.push({time,before,after});
  }
  return { capacity, maxBits, minBits, overflows: points.filter(p=>p.before>capacity+1), underflows: points.filter(p=>p.after< -1), points };
}
