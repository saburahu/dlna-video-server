import test from "node:test";
import assert from "node:assert/strict";
import { auditAdts, auditExperimentalAudio } from "../src/experimental-audio-audit.js";
import { experimentalAudioArguments, experimentalAudioMuxArguments } from "../src/prepare-experimental-audio.js";
import { sectionCrc } from "../src/arib-metadata.js";
import { syntheticTs } from "./ts-fixture.js";

const frame = (id = 1) => Buffer.from([255, 0xf1 | (id << 3), 0x4c, 0x80, 1, 0x3f, 0xfc, 0xaa, 0xbb]);
test("audio-only preparation uses MPEG-2 LC/PNS off and ADTS MPEG-2 without any video encoding", () => {
  const audio = experimentalAudioArguments("source.mp4", "derived.aac"), mux = experimentalAudioMuxArguments("source.mp4", "derived.aac", "derived.ts");
  assert.equal(audio[audio.indexOf("-profile:a") + 1], "mpeg2_aac_low");
  assert.equal(audio[audio.indexOf("-aac_pns") + 1], "0"); assert.equal(audio[audio.indexOf("-write_mpeg2") + 1], "1");
  assert.equal(mux[mux.indexOf("-c:v") + 1], "copy"); assert.equal(mux[mux.indexOf("-c:a") + 1], "copy");
  assert.equal(Number(mux[mux.indexOf("-itsoffset") + 1]), -1024 / 48000);
  assert.ok(audio.includes("-n") && mux.includes("-n"));
  assert.ok(!mux.some(a => /nvenc|amf|qsv|x264|mpeg2video|^-r$|^-vf$|^-profile:v$|^-level:v$/.test(a)));
});
test("ADTS audit distinguishes MPEG ID/profile/rate/channels and catches interior corruption", () => {
  const mixed = auditAdts(Buffer.concat([frame(1), frame(0)]));
  assert.equal(mixed.frames, 2); assert.equal(Object.keys(mixed.kinds).length, 2);
  assert.deepEqual(mixed.first, { mpegId: 1, profile: 2, sampleFrequencyIndex: 3, channelConfiguration: 2, hex: "fff94c80013ffc" });
  assert.equal(auditAdts(Buffer.concat([frame(), Buffer.alloc(7), frame()])).invalidInterior, true);
  const length = frame(); length[4] = 0; length[5] = 0; assert.throws(() => auditAdts(length), /length/);
});
test("bounded ADTS audit reports partial start/end rather than claiming complete bitstream", () => {
  const r = auditAdts(Buffer.concat([Buffer.from([0xaa, 0xbb]), frame(), frame().subarray(0, 8)]));
  assert.equal(r.frames, 1); assert.equal(r.leadingBytes, 2); assert.equal(r.trailingBytes, 8); assert.equal(r.invalidInterior, false);
});

function audioTs(times = [90000, 91920]) {
  const ts = syntheticTs(50), section = Buffer.from([2, 0xb0, 0, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, 0x1b, 0xe1, 0x11, 0xf0, 0, 15, 0xe1, 2, 0xf0, 3, 0x52, 1, 0x10, 0, 0, 0, 0]);
  section[2] = section.length - 3; section.writeUInt32BE(sectionCrc(section.subarray(0, -4)), section.length - 4); section.copy(ts, 188 + 5);
  for (let i = 0; i < times.length; i++) {
    const p = ts.subarray((i + 3) * 188, (i + 4) * 188), value = times[i];
    p[0] = 0x47; p[1] = 0x41; p[2] = 2; p[3] = 0x10 | i;
    Buffer.from([0, 0, 1, 0xc0, 0, 17, 0x80, 0x80, 5]).copy(p, 4);
    p[13] = 0x21 | ((Math.floor(value / 2 ** 30) & 7) << 1); p[14] = Math.floor(value / 2 ** 22) & 255;
    p[15] = ((Math.floor(value / 2 ** 15) & 127) << 1) | 1; p[16] = Math.floor(value / 2 ** 7) & 255; p[17] = ((value & 127) << 1) | 1;
    frame().copy(p, 18);
  }
  return ts;
}
test("audio TS audit reconstructs CRC PMT/descriptors/PES/PTS and preserves input", () => {
  const bytes = audioTs(), original = Buffer.from(bytes), result = auditExperimentalAudio(bytes);
  assert.equal(result.audioPid, 258); assert.equal(result.pmts[0].audio[0].streamType, 15);
  assert.deepEqual(result.pmts[0].audio[0].descriptors, [{ tag: 82, hex: "10" }]);
  assert.deepEqual(result.pes.streamIds, [192]); assert.equal(result.pes.ptsIntervalsMs!.min, 1024 / 48000 * 1000);
  assert.equal(result.adts.frames, 2); assert.deepEqual(bytes, original);
});
test("audio PTS audit treats genuine 33bit wrap as forward and detects reverse time", () => {
  const wrapped = auditExperimentalAudio(audioTs([2 ** 33 - 960, 960])); assert.equal(wrapped.pes.ptsIntervalsMs!.negative, 0);
  assert.ok(Math.abs(wrapped.pes.ptsIntervalsMs!.min - 21.333333) < .001);
  assert.equal(auditExperimentalAudio(audioTs([91920, 90000])).pes.ptsIntervalsMs!.negative, 1);
});
test("audio audit refuses an input without TS/PMT/audio rather than guessing a codec", () => {
  assert.throws(() => auditExperimentalAudio(Buffer.alloc(1000)), /not found/);
});
