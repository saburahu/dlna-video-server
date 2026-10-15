import test from "node:test";
import assert from "node:assert/strict";
import { auditVideoClock } from "../src/experimental-video-clock.js";
import { softwareVideoArguments } from "../src/prepare-experimental-software.js";
import { experimentalFormat, type ExperimentalMediaConfig } from "../src/experimental-media.js";
const trace = (removal: number[], output = removal.map(() => 0), tick = 1, scale = 180000) => `0 num_units_in_tick 1 = ${tick}\n1 time_scale 1 = ${scale}\n2 fixed_frame_rate_flag 0 = 0\n` + removal.map((r, i) => `24 cpb_removal_delay 1 = ${r}\n48 dpb_output_delay 1 = ${output[i]}`).join("\n");
test("VFR HRD clock agrees with nonuniform PTS", () => {
  assert.equal(auditVideoClock(trace([0, 6006, 15016]), [{ pts: 0, key: true }, { pts: 3003, key: false }, { pts: 7508, key: false }]).mismatchCount, 0);
});
test("constant NVENC removal clock does not pass VFR timing gate", () => {
  assert.equal(auditVideoClock(trace([0, 2, 4], [2, 2, 2], 1001, 120000), [{ pts: 0, key: true }, { pts: 3003, key: false }, { pts: 7508, key: false }]).mismatchCount, 2);
});
test("DPB delay contributes to presentation clock; missing SEI and unexpected resets fail", () => {
  const p = [{ pts: 0, key: true }, { pts: 3003, key: false }, { pts: 6006, key: false }];
  assert.equal(auditVideoClock(trace([0, 3003, 6006], [0, 3003, 6006]), p).mismatchCount, 0);
  assert.throws(() => auditVideoClock(trace([0]), p));
  assert.throws(() => auditVideoClock(trace([0, 6006, 0]), p), /reset/);
});
test("software pair keeps copied audio and common encoder settings; VFR does not pad frames", () => {
  const vfr = softwareVideoArguments("input", "output", true), cfr = softwareVideoArguments("input", "output", false);
  const get = (a: string[], k: string) => a[a.indexOf(k) + 1];
  assert.equal(get(vfr, "-vf"), "format=yuv420p"); assert.equal(get(cfr, "-vf"), "fps=60000/1001:round=near,format=yuv420p");
  for (const a of [vfr, cfr]) { assert.equal(get(a, "-c:a"), "copy"); assert.equal(get(a, "-c:v"), "libx264"); assert.equal(get(a, "-enc_time_base:v"), "1:90000"); assert.ok(!a.includes("-af")); assert.ok(a.includes("-n")); }
  assert.deepEqual(vfr.flatMap((v, i) => v === cfr[i] ? [] : [vfr[i - 1]]), ["-vf", "-x264-params"]);
});
test("encoder diagnostic annotation changes no media URL or DLNA declaration", () => {
  const config: ExperimentalMediaConfig = { file: "bounded.m2ts", title: "test", durationSeconds: 150, address: "127.0.0.1", port: 19093, udn: "uuid:1234", mode: "remux", contentPacket: true, videoTreatment: "cfr-idr" };
  assert.deepEqual(experimentalFormat(config), experimentalFormat({ ...config, videoEncoder: "libx264" }));
});
test("VFR experiment declares video transcoding while preserving CFR HTTP/DLNA identity", () => {
  const config: ExperimentalMediaConfig = { file: "bounded.m2ts", title: "test", durationSeconds: 150, address: "127.0.0.1", port: 19093, udn: "uuid:1234", mode: "remux", contentPacket: true, videoTreatment: "cfr-idr", videoEncoder: "libx264", contentPacketBlockBytes: 5568 };
  assert.deepEqual(experimentalFormat(config), experimentalFormat({ ...config, videoTreatment: "vfr-idr" }));
  assert.equal(experimentalFormat({ ...config, videoTreatment: "vfr-idr" }).strategy.copyVideo, false);
});
