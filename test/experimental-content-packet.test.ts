import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { PcrIndex } from "../src/core.js";
import { createExperimentalServer, experimentalFormat, type ExperimentalMediaConfig } from "../src/experimental-media.js";
import { contentPacketRange, experimentalLayout, pcrBoundedBlockBytes } from "../src/experimental-content-packet.js";

test("PCR block bound uses the slowest full-index interval, accepts unwrapped clocks and rejects discontinuities", () => {
  const index = { discontinuities: 0, invalidIntervals: 0, points: [
    { packet: 0, unwrappedPcr: 2 ** 33 * 300 - 27000000 },
    { packet: 1000, unwrappedPcr: 2 ** 33 * 300 },
    { packet: 1100, unwrappedPcr: 2 ** 33 * 300 + 27000000 }
  ] } as PcrIndex;
  const bound = pcrBoundedBlockBytes(index, .5);
  assert.equal(bound.blockBytes, 50 * 192);
  assert.equal(bound.guaranteedMaxSeconds, .5);
  assert.throws(() => pcrBoundedBlockBytes({ ...index, discontinuities: 1 }, .5));
  assert.throws(() => pcrBoundedBlockBytes({ ...index, invalidIntervals: 1 }, .5));
  assert.throws(() => pcrBoundedBlockBytes({ ...index, points: [] }, .5));
  assert.throws(() => pcrBoundedBlockBytes(index, NaN));
  assert.throws(() => experimentalLayout(1920, 1000, false, 192));
  assert.throws(() => experimentalLayout(1920, 1000, true, 193));
});

test("wrapper Range mapping retains enclosing blocks including header-only and short final block", () => {
  assert.deepEqual(contentPacketRange(192 * 5, 384, 399, 410), { sourceStart: 384, sourceEnd: 767, skip: 1, length: 12 });
  assert.deepEqual(contentPacketRange(960, 384, 793, 800), { sourceStart: 384, sourceEnd: 959, skip: 395, length: 8 });
  assert.equal(experimentalLayout(960, 6144, true).servedBytes, 960 + 3 * 14);
  assert.equal(experimentalLayout(960, 0, false).servedBytes, 960);
  assert.throws(() => experimentalLayout(961, 6144, true));
});

test("Content Packet flag cannot apply broadcast framing to MP4 Direct Play", () => {
  assert.throws(() => createExperimentalServer({ file: "source.mp4", title: "test", durationSeconds: 4, address: "127.0.0.1", port: 0, udn: "uuid:1111", contentPacket: true }, () => {}), /requires remux/);
});

for (const blockMode of ["default", "bounded", "fixed", "lead3"] as const) test(`wrapped real HTTP preserves TTS, lead and Ranges (block mode=${blockMode})`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pt3-wrapper-"));
  const file = path.join(directory, "test.m2ts"), packets = 2100, duration = 4.2;
  const source = Buffer.alloc(packets * 192);
  for (let p = 0; p < packets; p++) { source.writeUInt32BE((2 ** 30 + Math.round(p * .002 * 27000000)) >>> 0, p * 192); source[p * 192 + 4] = 0x47; }
  await writeFile(file, source); const before = await stat(file);
  const index: PcrIndex = { pid: 256, packetCount: packets, points: [0, packets - 1].map(p => ({ packet: p, pcr: p * .002 * 27000000, unwrappedPcr: p * .002 * 27000000, discontinuityBefore: false })), discontinuities: 0, invalidIntervals: 0, firstPacket: 0, lastPacket: packets - 1, durationSeconds: duration, averageBitrate: source.length * 8 / duration };
  const config: ExperimentalMediaConfig = { file, title: "SampleA remux", durationSeconds: duration, address: "127.0.0.1", port: 0, udn: "uuid:1111", mode: "remux", ssdp: false, contentPacket: true, ...(blockMode === "bounded" ? { contentPacketMaxSeconds: .021 } : blockMode === "fixed" ? { contentPacketBlockBytes: 1920, videoTreatment: "cfr-idr", videoFrameRate: "30000/1001" } : blockMode === "lead3" ? { pcrLeadMs: 3000 } : {}) };
  const lead = blockMode === "lead3" ? 3 : 1.1;
  if (blockMode === "lead3") for (const pcrLeadMs of [-1, NaN, 10001]) assert.throws(() => createExperimentalServer({ ...config, pcrLeadMs }, () => {}, index), /Invalid experimental PCR lead/);
  if (blockMode === "fixed") assert.throws(() => createExperimentalServer({ ...config, contentPacketMaxSeconds: .021 }, () => {}, index), /without time override/);
  const logs: { category: string; detail: any }[] = [];
  const server = createExperimentalServer(config, (category, _message, detail) => logs.push({ category, detail }), index);
  server.listen(0, "127.0.0.1"); await once(server, "listening"); config.port = (server.address() as AddressInfo).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  // Independent reference: 250 complete packets per half-second, then the final 100.
  const block = (blockMode === "default" || blockMode === "lead3" ? 250 : 10) * 192, chunks: Buffer[] = [];
  for (let offset = 0; offset < source.length; offset += block) { const payload = source.subarray(offset, offset + block); const header = Buffer.alloc(14); header.writeUInt32BE(payload.length, 10); chunks.push(header, payload); }
  const expected = Buffer.concat(chunks), uri = experimentalFormat(config).uri;
  const status = await (await fetch(`http://127.0.0.1:${config.port}/api/status`)).json();
  assert.equal(status.blockBytes, block); assert.equal(status.servedBytes, expected.length); assert.equal(status.leadMs, lead * 1000);
  if (blockMode === "fixed") { assert.equal(status.videoFrameRate, "30000/1001"); assert.equal(status.contentPacketBlockBytes, block); assert.equal(status.contentPacketMaxSeconds, null); }
  assert.equal(experimentalFormat(config).protocolInfo, experimentalFormat({ ...config, contentPacket: false }).protocolInfo);
  assert.equal(experimentalFormat(config).uri, experimentalFormat({ ...config, contentPacket: false }).uri);
  const head = await fetch(uri, { method: "HEAD" }); assert.equal(head.headers.get("content-length"), String(expected.length)); assert.equal(head.headers.get("content-type"), "video/vnd.dlna.mpeg-tts");
  for (const [start, end] of [[0, 13], [197, 511], [block + 12, block + 30], [2 * (block + 14) + 1, 2 * (block + 14) + 10], [expected.length - 23, expected.length - 1]]) {
    const response = await fetch(uri, { headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${expected.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected.subarray(start, end + 1));
  }
  const bad = await fetch(uri, { headers: { Range: `bytes=${expected.length}-` } }); assert.equal(bad.status, 416); await bad.arrayBuffer();
  const soap = await fetch(`http://127.0.0.1:${config.port}/upnp/control/content-directory`, { method: "POST", headers: { SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' }, body: "<Browse><ObjectID>exp</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag></Browse>" });
  assert.ok((await soap.text()).includes(`size=&quot;${expected.length}&quot;`));
  const started = performance.now(), response = await fetch(uri); const body = Buffer.from(await response.arrayBuffer()); const elapsed = (performance.now() - started) / 1000;
  assert.deepEqual(body, expected); assert.equal(response.headers.get("transfer-encoding"), null);
  assert.ok(elapsed >= duration - lead - .15 && elapsed < duration - lead + .7, `elapsed ${elapsed}`);
  const pacing = logs.filter(l => l.category === "HTTP_PACING_END").at(-1)!.detail;
  assert.equal(pacing.sentBytes, expected.length); assert.ok(Math.abs(pacing.scheduledPcrSeconds - duration) < .01); assert.equal(pacing.leadMs, lead * 1000);
  assert.ok(logs.some(l => l.category === "HTTP_MEDIA" && l.detail.contentPacket));
  const after = await stat(file); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
});
