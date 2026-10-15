import { test } from "node:test";
import assert from "node:assert/strict";
import { experimentalCbrArguments, validateCopiedTimeline } from "../src/experimental-cbr.js";
const packets = [
  { stream_index: 0, pts: 90000, dts: 90000, size: 100, data_hash: "SHA256:a", flags: "K_" },
  { stream_index: 1, pts: 88080, dts: 88080, size: 20, data_hash: "SHA256:b", flags: "K_" },
  { stream_index: 0, pts: 93003, dts: 93003, size: 50, data_hash: "SHA256:c", flags: "__" },
  { stream_index: 0, pts: 97508, dts: 97508, size: 30, data_hash: "SHA256:d", flags: "__" },
];
const shifted = () => packets.map(p => ({ ...p, pts: p.pts + 126000, dts: p.dts + 126000 }));
test("CBR uses standard muxer only and copies both ES without fps or hardware encoder", () => {
  const args = experimentalCbrArguments("input.m2ts", "new.ts");
  assert.ok(args.includes("-copyts"));
  assert.equal(args[args.indexOf("-mpegts_copyts") + 1], "0");
  assert.equal(args[args.indexOf("-muxrate") + 1], "12500000");
  assert.equal(args[args.indexOf("-muxdelay") + 1], "0.7");
  assert.equal(args[args.indexOf("-c") + 1], "copy");
  assert.ok(!args.includes("-r") && !args.includes("-vf") && !args.includes("-output_ts_offset"));
});
test("one common shift preserves irregular VFR intervals and AV relative synchronization", () => {
  assert.deepEqual(validateCopiedTimeline(packets, shifted()), { shiftTicks: 126000, shiftSeconds: 1.4, videoPackets: 3, audioPackets: 1 });
});
test("audio-only offsets, VFR changes, byte changes and missing packets cannot pass", () => {
  for (const change of [(p: ReturnType<typeof shifted>) => p[1].pts++,
    (p: ReturnType<typeof shifted>) => p[2].dts++,
    (p: ReturnType<typeof shifted>) => p[0].data_hash = "different",
    (p: ReturnType<typeof shifted>) => p.pop()]) {
    const p = shifted(); change(p); assert.throws(() => validateCopiedTimeline(packets, p));
  }
});
