import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Tts192Transform } from "../src/tts.js";

test('DLNA TTSは30bit境界で折り返さず32bit境界で折り返す（Rangeでも同値）', async () => {
  const source = Buffer.alloc(188 * 6); for (let i=0;i<6;i++) source[i*188]=0x47;
  for (const boundary of [2**30,2**32]) {
    const index = { pid:256,packetCount:6,discontinuities:0,invalidIntervals:0,firstPacket:0,lastPacket:5,durationSeconds:5000/27000000,averageBitrate:40608000,
      points:[{packet:0,pcr:boundary-2500,unwrappedPcr:boundary-2500,discontinuityBefore:false},{packet:5,pcr:boundary+2500,unwrappedPcr:boundary+2500,discontinuityBefore:false}] };
    async function run(input:Buffer,first:number,length:number) { const parts:Buffer[]=[]; for await(const c of Readable.from([input]).pipe(new Tts192Transform(first,1,0,length,index))) parts.push(c); return Buffer.concat(parts); }
    const full=await run(source,0,6*192);
    for(let i=0;i<6;i++){assert.equal(full.readUInt32BE(i*192),(boundary-2500+i*1000)%(2**32));if(i)assert.equal((full.readUInt32BE(i*192)-full.readUInt32BE((i-1)*192)+2**32)%2**32,1000);assert.ok(source.subarray(i*188,(i+1)*188).equals(full.subarray(i*192+4,(i+1)*192)));}
    assert.deepEqual(await run(source.subarray(2*188),2,4*192),full.subarray(2*192));
  }
});

test('DLNA32bit時刻はPCR索引なしと負オフセットでも正しいmoduloを使う', async () => {
  const source=Buffer.alloc(188);source[0]=0x47;
  const parts:Buffer[]=[];for await(const c of Readable.from([source]).pipe(new Tts192Transform(700000,24000000,0,192)))parts.push(c);
  assert.equal(Buffer.concat(parts).readUInt32BE(0),700000*1692);
  const shifted:Buffer[]=[];for await(const c of Readable.from([source]).pipe(new Tts192Transform(0,24000000,0,192,null,{atsOffsetMs:-500,atsByteOrder:'big-endian',atsClock:'27mhz',atsOrigin:'pcr-absolute',atsTopBits:0})))shifted.push(c);
  assert.equal(Buffer.concat(shifted).readUInt32BE(0),2**32-13500000);
});

async function convert(source: Buffer, packetIndex = 0, skip = 0, length = source.length / 188 * 192) {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from([source]).pipe(new Tts192Transform(packetIndex, 24_000_000, skip, length))) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

test("188バイトTSへATSを付加して192バイトTTSにする", async () => {
  const source = Buffer.alloc(188 * 2);
  source[0] = 0x47;
  source[188] = 0x47;
  const result = await convert(source);
  assert.equal(result.length, 192 * 2);
  assert.equal(result.readUInt32BE(0), 0);
  assert.equal(result[4], 0x47);
  assert.equal(result.readUInt32BE(192), 1692);
  assert.equal(result[196], 0x47);
});

test("変換後Rangeの途中だけを正確に切り出す", async () => {
  const source = Buffer.alloc(188 * 3);
  for (let i = 0; i < 3; i++) source[i * 188] = 0x47;
  const full = await convert(source);
  const ranged = await convert(source.subarray(188), 1, 13, 250);
  assert.deepEqual(ranged, full.subarray(192 + 13, 192 + 13 + 250));
});

test("PCR時間軸を指定するとPCR同期ATSを使う", async () => {
  const source = Buffer.alloc(188 * 2);
  source[0] = source[188] = 0x47;
  const index = {
    pid: 256, packetCount: 100, discontinuities: 0, invalidIntervals: 0,
    firstPacket: 0, lastPacket: 100, durationSeconds: 0.0062666667, averageBitrate: 24_000_000,
    points: [
      { packet: 0, pcr: 90_000_000, unwrappedPcr: 90_000_000, discontinuityBefore: false },
      { packet: 100, pcr: 90_169_200, unwrappedPcr: 90_169_200, discontinuityBefore: false }
    ]
  };
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from([source]).pipe(new Tts192Transform(0, 1, 0, 384, index))) chunks.push(chunk);
  const result = Buffer.concat(chunks);
  assert.equal(result.readUInt32BE(0), 90_000_000);
  assert.equal(result.readUInt32BE(192), 90_001_692);
});

test("ATSをPCRより指定時間前へずらす", async () => {
  const source = Buffer.alloc(188);
  source[0] = 0x47;
  const index = {
    pid: 256, packetCount: 100, discontinuities: 0, invalidIntervals: 0,
    firstPacket: 0, lastPacket: 100, durationSeconds: 0.0062666667, averageBitrate: 24_000_000,
    points: [
      { packet: 0, pcr: 90_000_000, unwrappedPcr: 90_000_000, discontinuityBefore: false },
      { packet: 100, pcr: 90_169_200, unwrappedPcr: 90_169_200, discontinuityBefore: false }
    ]
  };
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from([source]).pipe(new Tts192Transform(0, 1, 0, 192, index, {
    atsOffsetMs: -500, atsByteOrder: "big-endian", atsClock: "27mhz",
    atsOrigin: "pcr-absolute", atsTopBits: 0
  }))) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).readUInt32BE(0), 76_500_000);
});

test("ATS上位2bitとリトルエンディアンを切り替えられる", async () => {
  const source = Buffer.alloc(188);
  source[0] = 0x47;
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from([source]).pipe(new Tts192Transform(0, 24_000_000, 0, 192, null, {
    atsOffsetMs: 0, atsByteOrder: "little-endian", atsClock: "27mhz",
    atsOrigin: "pcr-absolute", atsTopBits: 1
  }))) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks).subarray(0, 4), Buffer.from([0, 0, 0, 0x40]));
});

test("ATSを90kHz値かつPCR先頭を原点として生成できる", async () => {
  const source = Buffer.alloc(188 * 2);
  source[0] = source[188] = 0x47;
  const index = {
    pid: 256, packetCount: 100, discontinuities: 0, invalidIntervals: 0,
    firstPacket: 0, lastPacket: 100, durationSeconds: 0.0062666667, averageBitrate: 24_000_000,
    points: [
      { packet: 0, pcr: 90_000_000, unwrappedPcr: 90_000_000, discontinuityBefore: false },
      { packet: 100, pcr: 90_169_200, unwrappedPcr: 90_169_200, discontinuityBefore: false }
    ]
  };
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from([source]).pipe(new Tts192Transform(0, 1, 0, 384, index, {
    atsOffsetMs: 0, atsByteOrder: "big-endian", atsClock: "90khz",
    atsOrigin: "zero-based", atsTopBits: 0
  }))) chunks.push(chunk);
  const result = Buffer.concat(chunks);
  assert.equal(result.readUInt32BE(0), 0);
  assert.equal(result.readUInt32BE(192), 5);
});
