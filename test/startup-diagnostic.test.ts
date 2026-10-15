import test from "node:test";
import assert from "node:assert/strict";
import { inspectStartup } from "../src/startup-diagnostic.js";
import { syntheticTs } from "./ts-fixture.js";

function videoPacket(payload: Buffer, counter: number, start = false) {
  const packet = Buffer.alloc(188, 0xff);
  packet[0] = 0x47; packet[1] = 1 | (start ? 0x40 : 0); packet[2] = 0x11;
  packet[3] = 0x30 | counter; packet[4] = 183 - payload.length;
  packet[5] = 0;
  payload.copy(packet, 5 + packet[4]);
  return packet;
}
test("TSパケットをまたぐMPEG-2ヘッダーの元ファイル位置と寸法を特定する", () => {
  const data = syntheticTs(20);
  // Prefix crosses packets; sequence size is 1440x1080 and first picture is I-coded.
  videoPacket(Buffer.from([0, 0]), 0).copy(data, 3 * 188);
  videoPacket(Buffer.from([1, 0xb3, 0x5a, 0x04, 0x38, 0, 0, 1, 0, 0, 8]), 1).copy(data, 4 * 188);
  const result = inspectStartup(data);
  assert.ok(result.pids);
  const video = result.pids.find(pid => pid.pid === 273)!;
  assert.ok("firstMpeg2Sequence" in video);
  assert.deepEqual(video.firstMpeg2Sequence, { sourceOffset: 3 * 188 + 186, packet: 3, width: 1440, height: 1080 });
  assert.equal(video.firstMpeg2IFrame?.packet, 4);
  assert.equal(video.continuityErrors, 0);
  assert.equal(result.firstPatPacket, 0); assert.equal(result.firstPmtPacket, 1);
});
test("冒頭のPTS、カウンター欠落、スクランブル・伝送エラーを分ける", () => {
  const data = syntheticTs(20);
  // PTS 90000 ticks = 1 second; marker bits must be valid.
  videoPacket(Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 5, 0xbf, 0x21]), 0, true).copy(data, 3 * 188);
  const next = videoPacket(Buffer.from([0xff]), 2); next[1] |= 0x80; next[3] |= 0x80;
  next.copy(data, 4 * 188);
  const result = inspectStartup(data); assert.ok(result.pids);
  const video = result.pids.find(pid => pid.pid === 273)!;
  assert.equal(video.firstPes?.ptsSeconds, 1);
  assert.equal(video.continuityErrors, 1); assert.equal(video.scrambled, 1); assert.equal(video.transportErrors, 1);
  assert.equal(video.firstPes?.dtsSeconds, null);
});
test("同期なしを正常なTS診断として扱わない", () => {
  assert.ok("error" in inspectStartup(Buffer.alloc(1000)));
});
