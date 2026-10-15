import test from "node:test";
import assert from "node:assert/strict";
import { experimentalVideoArguments } from "../src/prepare-experimental-video.js";
import { experimentalFormat, type ExperimentalMediaConfig } from "../src/experimental-media.js";
test("video-only CFR preparation copies existing audio and timestamps without an audio offset/filter", () => {
  const args = experimentalVideoArguments("audio-success.m2ts", "derived.ts", "60000/1001"), get = (key: string) => args[args.indexOf(key) + 1];
  assert.equal(get("-c:a"), "copy"); assert.ok(args.includes("-copyts")); assert.equal(get("-mpegts_copyts"), "1"); assert.equal(get("-avoid_negative_ts"), "disabled");
  assert.ok(!args.some(a => ["-af", "-itsoffset", "-ar", "-ac", "-b:a"].includes(a)));
  assert.equal(get("-vf"), "fps=60000/1001:round=near,format=yuv420p"); assert.equal(get("-c:v"), "h264_nvenc");
  assert.equal(get("-fps_mode"), "passthrough", "CFR comes from fps filter, avoiding copyts output padding from zero");
  assert.equal(get("-profile:v"), "main"); assert.equal(get("-level:v"), "4.2"); assert.equal(get("-g"), "120"); assert.equal(get("-bf"), "0"); assert.equal(get("-refs"), "1");
  assert.equal(get("-forced-idr"), "1"); assert.equal(get("-aud"), "1"); assert.ok(get("-bsf:v").includes("dump_extra=freq=keyframe")); assert.ok(args.includes("-n"));
});
test("29.97 mode has a corresponding GOP and level without changing audio", () => {
  const args = experimentalVideoArguments("input", "output", "30000/1001"); assert.equal(args[args.indexOf("-g") + 1], "60"); assert.equal(args[args.indexOf("-level:v") + 1], "4.1");
});
test("29.97 diagnostic keeps Level4.2, VBR and audio; only fps and GOP frame counts differ", () => {
  const fast = experimentalVideoArguments("input", "output", "60000/1001", "4.2");
  const slow = experimentalVideoArguments("input", "output", "30000/1001", "4.2");
  const differences = fast.flatMap((v, i) => v === slow[i] ? [] : [fast[i - 1]]);
  assert.deepEqual(differences, ["-vf", "-g", "-keyint_min"]);
  assert.equal(slow[slow.indexOf("-level:v") + 1], "4.2");
  assert.equal(slow[slow.indexOf("-force_key_frames") + 1], fast[fast.indexOf("-force_key_frames") + 1]);
});
test("pre-generated video treatment preserves URL and HTTP/DLNA declaration", () => {
  const config: ExperimentalMediaConfig = { file: "test.m2ts", title: "test", durationSeconds: 150, address: "127.0.0.1", port: 19093, udn: "uuid:1111", mode: "remux", contentPacket: true, audioTreatment: "mpeg2-aac-lc" };
  const before = experimentalFormat(config), after = experimentalFormat({ ...config, videoTreatment: "cfr-idr" });
  for (const key of ["mime", "features", "protocolInfo", "uri", "objectId"] as const) assert.equal(after[key], before[key]);
  assert.equal(after.strategy.copyVideo, false); assert.equal(after.strategy.copyAudio, true);
});
