import test from "node:test";
import assert from "node:assert/strict";
import { atsForPacket, atsFromPcrIndex, atsFromTimeline, escapeXml, inspectTs, mediaSize, offsetAts, parseRange, profiles } from "../src/core.js";

test("XML特殊文字をエスケープする", () => {
  assert.equal(escapeXml(`A&B <番組> "新"`), "A&amp;B &lt;番組&gt; &quot;新&quot;");
});
test("ファイル全体PCR索引は前後標本で区間補間する", () => {
  const index = {
    pid: 256, packetCount: 1000, discontinuities: 0, invalidIntervals: 0,
    firstPacket: 0, lastPacket: 200, durationSeconds: 0.0188, averageBitrate: 16_000_000,
    points: [
      { packet: 0, pcr: 27_000_000, unwrappedPcr: 27_000_000, discontinuityBefore: false },
      { packet: 100, pcr: 27_169_200, unwrappedPcr: 27_169_200, discontinuityBefore: false },
      { packet: 200, pcr: 27_507_600, unwrappedPcr: 27_507_600, discontinuityBefore: false }
    ]
  };
  assert.equal(atsFromPcrIndex(50, index), 27_084_600);
  assert.equal(atsFromPcrIndex(150, index), 27_338_400);
});
test("通常Rangeを解析する", () => assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 }));
test("末尾Rangeを解析する", () => assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 }));
test("範囲外Rangeは416向け例外", () => assert.throws(() => parseRange("bytes=100-120", 100), RangeError));
test("188バイトTSを判定する", () => {
  const data = Buffer.alloc(188 * 5);
  for (let i = 0; i < 5; i++) data[i * 188] = 0x47;
  assert.deepEqual(inspectTs(data), {
    packetSize: 188, syncOffset: 0, patFound: false, pmtPid: null, pmtFound: false,
    videoPids: [], audioPids: [], pcrPid: null, streams: [], pcr: null
  });
});
test("192バイトTSの4バイトオフセットを判定する", () => {
  const data = Buffer.alloc(192 * 5);
  for (let i = 0; i < 5; i++) data[i * 192 + 4] = 0x47;
  assert.equal(inspectTs(data).packetSize, 192);
  assert.equal(inspectTs(data).syncOffset, 4);
});
test("同期が続かないデータはTSと判定しない", () => {
  assert.equal(inspectTs(Buffer.from([0x47, 0, 0, 0])).packetSize, null);
});
test("188バイトTSの配信サイズを192バイト単位へ変換する", () => {
  assert.equal(mediaSize(188 * 10, profiles["regza-zp2-192"]), 192 * 10);
  assert.equal(mediaSize(188 * 10, profiles["regza-zp2"]), 188 * 10);
});
test("コンテナ・DLNA宣言実験プロファイルを独立して切り替える", () => {
  const sourceSize = 188 * 10;
  assert.equal(mediaSize(sourceSize, profiles["container-188-tts"]), sourceSize);
  assert.equal(profiles["container-188-mpeg"].mime, "video/mpeg");
  assert.equal(mediaSize(sourceSize, profiles["container-192-mpeg"]), 192 * 10);
  assert.equal(profiles["container-192-no-pn"].pn, "");
  assert.equal(profiles["container-192-op00"].op, "00");
});
test("ATSは27MHzクロック・30bitで決定的に生成する", () => {
  assert.equal(atsForPacket(0, 24_000_000), 0);
  assert.equal(atsForPacket(1, 24_000_000), 1692);
  assert.ok(atsForPacket(1_000_000, 24_000_000) < 0x40000000);
});
test("ATSオフセットは27MHz換算し30bitで折り返す", () => {
  assert.equal(offsetAts(27_000_000, -100), 24_300_000);
  assert.equal(offsetAts(1_000, -100), 0x40000000 - 2_699_000);
});
test("PCR時間軸からRange位置に依存しないATSを生成する", () => {
  const timeline = {
    pid: 256, firstPacket: 100, firstPcr: 27_000_000, lastPacket: 200,
    lastPcr: 27_169_200, sampleCount: 2, ticksPerPacket: 1692, estimatedBitrate: 24_000_000
  };
  assert.equal(atsFromTimeline(100, timeline), 27_000_000);
  assert.equal(atsFromTimeline(101, timeline), 27_001_692);
  assert.equal(atsFromTimeline(500, timeline), 27_676_800);
});
