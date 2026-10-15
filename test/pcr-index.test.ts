import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { atsFromPcrIndex } from "../src/core.js";
import { buildPcrIndex, clearPcrIndexCache } from "../src/pcr-index.js";
import { syntheticTs } from "./ts-fixture.js";

function packet(pid: number, pcr?: number) {
  const out = Buffer.alloc(188, 0xff);
  out[0] = 0x47;
  out[1] = (pid >> 8) & 0x1f;
  out[2] = pid & 0xff;
  if (pcr === undefined) {
    out[3] = 0x10;
    return out;
  }
  out[3] = 0x20;
  out[4] = 7;
  out[5] = 0x10;
  const base = Math.floor(pcr / 300);
  const ext = pcr % 300;
  out[6] = Math.floor(base / 2 ** 25) & 0xff;
  out[7] = Math.floor(base / 2 ** 17) & 0xff;
  out[8] = Math.floor(base / 2 ** 9) & 0xff;
  out[9] = Math.floor(base / 2) & 0xff;
  out[10] = ((base & 1) << 7) | 0x7e | ((ext >> 8) & 1);
  out[11] = ext & 0xff;
  return out;
}

function pat() {
  const out = packet(0);
  out[1] |= 0x40;
  out[4] = 0;
  Buffer.from([0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0x01, 0, 0, 0, 0]).copy(out, 5);
  return out;
}

function pmt() {
  const out = packet(257);
  out[1] |= 0x40;
  out[4] = 0;
  Buffer.from([0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0,
    0x02, 0xe1, 0x11, 0xf0, 0, 0, 0, 0]).copy(out, 5);
  return out;
}

test("全体走査したPCR索引で異なる傾きの区間を別々に補間する", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pcr-index-"));
  const file = path.join(dir, "variable.ts");
  const packets: Buffer[] = [pat(), pmt()];
  for (let i = 2; i < 302; i++) {
    const pcr = i === 10 ? 27_000_000
      : i === 110 ? 27_169_200
      : i === 210 ? 27_507_600
      : undefined;
    packets.push(packet(pcr === undefined ? 0x1fff : 256, pcr));
  }
  await fs.writeFile(file, Buffer.concat(packets));
  clearPcrIndexCache();
  const index = await buildPcrIndex(file);
  assert.ok(index);
  assert.equal(index.points.length, 3);
  assert.equal(atsFromPcrIndex(60, index), 27_084_600);
  assert.equal(atsFromPcrIndex(160, index), 27_338_400);
  await fs.rm(dir, { recursive: true });
});

test("元から192バイトのTTSではPCR速度も192バイト単位で計算する", async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pcr-native-tts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ts = syntheticTs(1000, 5000), tts = Buffer.alloc(1000 * 192);
  for (let i = 0; i < 1000; i++) ts.copy(tts, i * 192 + 4, i * 188, (i + 1) * 188);
  const file = path.join(dir, "synthetic.m2ts"); await fs.writeFile(file, tts);
  const index = await buildPcrIndex(file);
  assert.ok(index); assert.equal(index.packetCount, 1000);
  assert.ok(Math.abs(index.averageBitrate / (5000 * 192 * 8) - 1) < 0.0001);
});
