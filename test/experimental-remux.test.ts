import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { PcrIndex } from "../src/core.js";
import { createExperimentalServer, experimentalDidl, experimentalFormat, EXPERIMENTAL_REMUX_LEAD_MS, type ExperimentalMediaConfig } from "../src/experimental-media.js";
import { remuxArguments } from "../src/prepare-experimental-remux.js";
import { experimentalRendererTrial } from "../src/experimental-renderer.js";

test("remux command copies both codecs, changes framing only, refuses overwrite and is bounded", () => {
  const args = remuxArguments("source.mp4", "derived.ts");
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.equal(args[args.indexOf("-bsf:v") + 1], "h264_mp4toannexb");
  assert.equal(args[args.indexOf("-t") + 1], "150");
  assert.ok(args.includes("-n")); assert.ok(!args.includes("-y"));
  assert.ok(!args.some(a => /nvenc|amf|qsv|x264|mpeg2video/.test(a)));
});

const config: ExperimentalMediaConfig = { file: "derived.m2ts", title: "SampleA remux", durationSeconds: 150, address: "127.0.0.1", port: 19093, udn: "uuid:1111", mode: "remux", ssdp: false };
test("remux metadata/renderer use the actual TTS URI and experiment AVC declaration", async () => {
  const format = experimentalFormat(config);
  assert.match(format.protocolInfo, /video\/vnd\.dlna\.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T/);
  assert.equal(format.strategy.mode, "remux");
  assert.doesNotMatch(experimentalDidl(config, 1920).wrap(experimentalDidl(config, 1920).entries), /sampleA\.mp4|MPEG_TS_JP_T/);
  const calls: string[] = [];
  await experimentalRendererTrial(config, 1920, true, async (action, args) => {
    calls.push(action);
    if (action === "SetAVTransportURI") { assert.equal(args.CurrentURI, format.uri); assert.match(args.CurrentURIMetaData, /AVC_TS_JP_AAC_T/); }
    return "<CurrentTransportState>STOPPED</CurrentTransportState>";
  }, async () => "remux-trial");
  assert.deepEqual(calls, ["GetTransportInfo", "SetAVTransportURI", "Play"]);
});

test("remux server refuses missing/discontinuous PCR and wrong file extension", () => {
  assert.throws(() => createExperimentalServer(config, () => {}), /continuous PCR/);
  assert.throws(() => createExperimentalServer({ ...config, file: "source.mp4" }, () => {}), /Invalid media/);
});

test("remux real HTTP retains 192-byte bytes, supports HEAD/Range and schedules from PCR with lead", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pt3-remux-"));
  const file = path.join(directory, "test.m2ts"), packets = 2000, duration = 4;
  const bytes = Buffer.alloc(packets * 192);
  for (let p = 0; p < packets; p++) { bytes.writeUInt32BE((2 ** 30 + Math.round(p / packets * duration * 27000000)) >>> 0, p * 192); bytes[p * 192 + 4] = 0x47; }
  await writeFile(file, bytes); const before = await stat(file);
  const index: PcrIndex = { pid: 256, packetCount: packets, points: [0, packets - 1].map(p => ({ packet: p, pcr: p / packets * duration * 27000000, unwrappedPcr: p / packets * duration * 27000000, discontinuityBefore: false })), discontinuities: 0, invalidIntervals: 0, firstPacket: 0, lastPacket: packets - 1, durationSeconds: duration, averageBitrate: bytes.length * 8 / duration };
  assert.throws(() => createExperimentalServer({ ...config, file }, () => {}, { ...index, discontinuities: 1 }), /continuous PCR/);
  const logs: { category: string; detail: any }[] = [];
  const current = { ...config, file, port: 0 };
  const server = createExperimentalServer(current, (category, _message, detail) => logs.push({ category, detail }), index);
  server.listen(0, "127.0.0.1"); await once(server, "listening"); current.port = (server.address() as AddressInfo).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const uri = experimentalFormat(current).uri;
  const head = await fetch(uri, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.headers.get("content-type"), "video/vnd.dlna.mpeg-tts"); assert.equal(head.headers.get("content-length"), String(bytes.length));
  const range = await fetch(uri, { headers: { Range: "bytes=197-511" } });
  assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), `bytes 197-511/${bytes.length}`); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(197, 512));
  const bad = await fetch(uri, { headers: { Range: `bytes=${bytes.length}-` } }); assert.equal(bad.status, 416); await bad.arrayBuffer();
  const started = performance.now(); const response = await fetch(uri); const body = Buffer.from(await response.arrayBuffer()); const elapsed = (performance.now() - started) / 1000;
  assert.deepEqual(body, bytes); assert.equal(response.headers.get("transfer-encoding"), null);
  assert.ok(elapsed >= duration - EXPERIMENTAL_REMUX_LEAD_MS / 1000 - .15 && elapsed < duration + 1, `elapsed ${elapsed}`);
  const end = logs.filter(l => l.category === "HTTP_PACING_END").at(-1)!.detail;
  assert.equal(end.sentBytes, bytes.length); assert.equal(end.leadMs, 1100); assert.ok(Math.abs(end.scheduledPcrSeconds - duration) < .01);
  assert.ok(logs.some(l => l.category === "HTTP_MEDIA_PROGRESS"));
  const after = await stat(file); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
});
