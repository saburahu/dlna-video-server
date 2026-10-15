import test from "node:test";
import assert from "node:assert/strict";
import { hrdSchedule, bufferOccupancy, parseHrdTrace } from "../src/hrd-audit.js";
test("buffering period boundary uses previous clock base then resets for following AU", () => {
  const s=hrdSchedule([{bits:100,removalDelay:0,outputDelay:0,initialDelay:90000,initialOffset:0},
    {bits:100,removalDelay:100,outputDelay:2}, {bits:100,removalDelay:200,outputDelay:0,initialDelay:45000,initialOffset:45000},
    {bits:100,removalDelay:100,outputDelay:0}],1000,.001);
  assert.deepEqual(s.map(p=>p.removal),[1,1.1,1.2,1.3]);assert.equal(s[1].output,1.102);
  assert.ok(s.every(p=>p.margin>0));
});
test("large AU exposes deadline miss rather than silently moving removal time", () => {
  const s=hrdSchedule([{bits:2000,removalDelay:0,outputDelay:0,initialDelay:90000}],1000,.001);
  assert.equal(s[0].margin,-1);assert.equal(s[0].removal,1);
});
test("occupancy detects overflow and incomplete arrival at removal, including partial AU", () => {
  const a=[{start:0,end:1,bits:1000},{start:1,end:2,bits:1000}];
  const ok=bufferOccupancy(a,[{time:1,bits:1000},{time:2,bits:1000}],1000);assert.equal(ok.maxBits,1000);assert.equal(ok.underflows.length,0);assert.equal(ok.overflows.length,0);
  assert.ok(bufferOccupancy(a,[{time:2,bits:2000}],1000).overflows.length);
  const early=bufferOccupancy(a,[{time:.5,bits:1000},{time:2,bits:1000}],1000);assert.equal(early.minBits,-500);
});
test("instantaneous burst and impossible time ordering are handled explicitly", () => {
  assert.equal(bufferOccupancy([{start:0,end:0,bits:1000}],[{time:1,bits:1000}],1000).maxBits,1000);
  assert.throws(()=>bufferOccupancy([{start:1,end:0,bits:1}],[],100));
  assert.throws(()=>hrdSchedule([{bits:1,removalDelay:0,outputDelay:0}],1000,.001));
  assert.throws(()=>parseHrdTrace("truncated"));
});
test("trace parsing derives scaled CPB limits and rejects changing SPS schedules", () => {
  const fields={nal_hrd_parameters_present_flag:1,vcl_hrd_parameters_present_flag:0,cpb_cnt_minus1:0,
    num_units_in_tick:1,time_scale:180000,bit_rate_scale:1,cpb_size_scale:3,bit_rate_value_minus1:78124,
    cpb_size_value_minus1:78124,cbr_flag:0,low_delay_hrd_flag:0,max_num_ref_frames:1,max_num_reorder_frames:0,max_dec_frame_buffering:1};
  const trace=Object.entries(fields).map(([k,v])=>`0 ${k} 0 = ${v}`).join("\n")+
    "\n[trace_headers @ test] Packet: 100 bytes\n24 cpb_removal_delay 0 = 0\n48 dpb_output_delay 0 = 0\n25 initial_cpb_removal_delay[0] 0 = 90000\n25 initial_cpb_removal_delay_offset[0] 0 = 0";
  const r=parseHrdTrace(trace);assert.equal(r.rate,10000000);assert.equal(r.capacity,10000000);assert.equal(r.pictures[0].bits,800);
  assert.throws(()=>parseHrdTrace(trace+"\n0 bit_rate_scale 0 = 2"),/Changing SPS/);
});
