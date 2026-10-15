import test from "node:test";
import assert from "node:assert/strict";
import { patchFixedFrameRateTts } from "../src/experimental-vui.js";
import {patchMainLevel42} from '../src/experimental-level.js';
import { experimentalFormat, type ExperimentalMediaConfig } from "../src/experimental-media.js";
const sps = Buffer.from("6764002aac2ca401e0089f9701b5010101400000fa4000753021", "hex");
const start = Buffer.from([0, 0, 0, 1]), aud = Buffer.from([9, 0xf0]);
test('level-only control patches repeated and split SPS without changing any other byte',()=>{
  const main=Buffer.from(sps);main[1]=77;main[3]=40;
  const input=tts(Buffer.concat([start,main,start,aud,start,main,start,aud]),11),saved=Buffer.from(input),r=patchMainLevel42(input,256,main);
  assert.deepEqual(input,saved);assert.equal(r.output.length,input.length);assert.equal(r.offsets.length,2);
  const changed=Array.from(input.keys()).filter(i=>input[i]!==r.output[i]);assert.deepEqual(changed,r.offsets);
  for(const i of changed){assert.equal(input[i],40);assert.equal(r.output[i],42);}
  for(let i=0;i<input.length;i+=192)assert.deepEqual(input.subarray(i,i+4),r.output.subarray(i,i+4));
  const bad=Buffer.from(main);bad[3]=41;assert.throws(()=>patchMainLevel42(input,256,bad),/Level 4.0/);
  bad[3]=40;bad[1]=100;assert.throws(()=>patchMainLevel42(input,256,bad),/Main/);
  const mixed=tts(Buffer.concat([start,main,start,sps,start,aud]));assert.throws(()=>patchMainLevel42(mixed,256,main),/Unexpected SPS/);
});
function tts(es: Buffer, chunkSize = 31) {
  const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0, 0]), es]), packets: Buffer[] = [];
  for (let i = 0; i < pes.length; i += chunkSize) {
    const payload = pes.subarray(i, i + chunkSize), p = Buffer.alloc(192, 0xff), adaptation = 183 - payload.length;
    p.writeUInt32BE(0xf0000000 + packets.length, 0); p[4] = 0x47; p[5] = (i === 0 ? 0x40 : 0) | 1; p[6] = 0; p[7] = 0x30 | (packets.length & 15);
    p[8] = adaptation; if (adaptation) p[9] = 0; payload.copy(p, 9 + adaptation); packets.push(p);
  }
  return Buffer.concat(packets);
}
test("VUI experiment changes only one mapped bit in each repeated SPS even across TS boundaries", () => {
  const input = tts(Buffer.concat([start, sps, start, aud, start, sps, start, aud])), original = Buffer.from(input);
  const result = patchFixedFrameRateTts(input, 256, sps, 202);
  assert.deepEqual(input, original); assert.equal(result.output.length, input.length); assert.equal(result.offsets.length, 2);
  const differences = Array.from(input.keys()).filter(i => input[i] !== result.output[i]); assert.deepEqual(differences, result.offsets);
  for (const offset of differences) { assert.equal(input[offset], 0x21); assert.equal(result.output[offset], 1); assert.equal(offset % 192 >= 4, true); }
  for (let i = 0; i < input.length; i += 192) assert.deepEqual(input.subarray(i, i + 4), result.output.subarray(i, i + 4));
});
test("VUI experiment rejects unknown SPS and missing video rather than editing unverified streams", () => {
  const changed = Buffer.from(sps); changed[3]--;
  assert.throws(() => patchFixedFrameRateTts(tts(Buffer.concat([start, changed, start, aud])), 256, sps, 202), /Unexpected SPS/);
  assert.throws(() => patchFixedFrameRateTts(tts(Buffer.concat([start, aud])), 256, sps, 202), /No SPS/);
  assert.throws(() => patchFixedFrameRateTts(Buffer.alloc(193), 256, sps, 202), /Invalid/);
  const already = Buffer.from(sps); already[25] = 1;
  assert.throws(() => patchFixedFrameRateTts(tts(Buffer.concat([start, already, start, aud])), 256, already, 202), /not one/);
});
test("VUI experiment refuses changes requiring new emulation prevention bytes", () => {
  const special = Buffer.from([0x67, 0, 0, 4, 0x80]);
  assert.throws(() => patchFixedFrameRateTts(tts(Buffer.concat([start, special, start, aud])), 256, special, 29), /emulation prevention/);
});
test("VUI experiment marker does not change the HTTP/DLNA format or playback URL", () => {
  const config: ExperimentalMediaConfig = { file: "test.m2ts", title: "test", durationSeconds: 150, address: "127.0.0.1", port: 19093, udn: "uuid:1111", mode: "remux", contentPacket: true, audioTreatment: "mpeg2-aac-lc" };
  assert.deepEqual(experimentalFormat({ ...config, videoTreatment: "vui-variable" }), experimentalFormat(config));
});
