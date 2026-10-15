import test from "node:test";
import assert from "node:assert/strict";
import { insertExperimentalPcr } from "../src/experimental-pcr-insertion.js";
import { PCR_WRAP, readPcr, type PcrIndex } from "../src/core.js";

function fixture(delta: number, start = 27000000) {
  const packets = Array.from({ length: 121 }, (_, i) => {
    const p = Buffer.alloc(188, i & 255); p[0] = 0x47; p[1] = 1; p[2] = 0; p[3] = 0x10 | i % 16; return p;
  });
  const index: PcrIndex = { pid: 256, packetCount: packets.length, points: [
    { packet: 0, pcr: start % PCR_WRAP, unwrappedPcr: start, discontinuityBefore: false },
    { packet: 120, pcr: (start + delta) % PCR_WRAP, unwrappedPcr: start + delta, discontinuityBefore: false }
  ], discontinuities: 0, invalidIntervals: 0, firstPacket: 0, lastPacket: 120, durationSeconds: delta / 27000000, averageBitrate: 1 };
  return { source: Buffer.concat(packets), index };
}
test("PCR insertion retains all original packets and uses non-incrementing adaptation-only continuity", () => {
  const { source, index } = fixture(3150000), r = insertExperimentalPcr(source, index);
  assert.equal(r.insertedPackets, 2);
  let original = 0; const times = [index.points[0].unwrappedPcr];
  for (let i = 0; i < r.output.length; i += 188) {
    const p = r.output.subarray(i, i + 188);
    if ((p[3] & 0x30) === 0x20) {
      assert.equal(p[4], 183); assert.equal(p[3] & 15, (original - 1) % 16);
      assert.equal(p[5], 0x10); times.push(readPcr(p, 0)!);
    } else { assert.deepEqual(p, source.subarray(original * 188, ++original * 188)); }
  }
  assert.equal(original, index.packetCount); times.push(index.points[1].unwrappedPcr);
  assert.ok(times.slice(1).every((t, i) => t > times[i] && t - times[i] <= 50 * 27000));
});
test("short PCR intervals add no packets; PCR wrap encodes modulo the full PCR clock", () => {
  const short = fixture(50 * 27000); assert.deepEqual(insertExperimentalPcr(short.source, short.index).output, short.source);
  const wrapped = fixture(117 * 27000, PCR_WRAP - 20 * 27000), r = insertExperimentalPcr(wrapped.source, wrapped.index);
  const added = r.output.subarray(40 * 188, 41 * 188); assert.equal(readPcr(added, 0), 19 * 27000);
});
test("invalid/discontinuous/unaligned diagnostic samples fail closed", () => {
  const { source, index } = fixture(3150000);
  assert.throws(() => insertExperimentalPcr(source, { ...index, discontinuities: 1 }));
  assert.throws(() => insertExperimentalPcr(source.subarray(1), index));
  assert.throws(() => insertExperimentalPcr(source, index, 0));
});
