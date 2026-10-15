import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { BitratePacingTransform } from "../src/pacing.js";

test("指定ビットレートより大幅に速く送信しない", async () => {
  const source = Buffer.alloc(20_000);
  const started = performance.now();
  let bytes = 0;
  for await (const chunk of Readable.from([source]).pipe(new BitratePacingTransform(800_000))) {
    bytes += chunk.length;
  }
  const elapsed = performance.now() - started;
  assert.equal(bytes, source.length);
  assert.ok(elapsed >= 170, `elapsed=${elapsed}ms`);
  assert.ok(elapsed < 1000, `elapsed=${elapsed}ms`);
});

test("192バイト配信速度は188バイトPCR速度の192/188倍にできる", () => {
  const sourceBitrate = 13_489_639;
  const outputBitrate = sourceBitrate * 192 / 188;
  assert.equal(Math.round(outputBitrate), 13_776_653);
});
