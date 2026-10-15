import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExperimentalServer, experimentalDidl, byteRange, mp4ProtocolInfo, type ExperimentalMediaConfig } from "../src/experimental-media.js";
import { browseDIDL } from "../src/upnp.js";
import { profiles } from "../src/core.js";
import type { Program } from "../src/store.js";

test("single ranges include suffix, open-ended and clamp; malformed/multipart/outside rejected", () => {
  assert.deepEqual(byteRange("bytes=3-9", 20), { start: 3, end: 9 });
  assert.deepEqual(byteRange("bytes=-4", 20), { start: 16, end: 19 });
  assert.deepEqual(byteRange("bytes=3-", 20), { start: 3, end: 19 });
  assert.deepEqual(byteRange("bytes=3-100", 20), { start: 3, end: 19 });
  for (const range of ["bytes=-0", "bytes=20-", "bytes=4-3", "bytes=1-3,5-7", "bytes=-", "items=1-3", "bytes=999999999999999999999-"]) assert.equal(byteRange(range, 20), null);
});
test("MP4 actual HTTP GET/HEAD/Range has original bytes; readonly and no transcoder dependency", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pt3-mp4-"));
  const file = path.join(dir, "sampleA.mp4"), bytes = Buffer.from(Array.from({ length: 257 }, (_, i) => i % 256));
  await writeFile(file, bytes); const before = await stat(file);
  const logs: { category: string; detail: any }[] = [];
  const config: ExperimentalMediaConfig = { file, title: "SampleA & 第3話", durationSeconds: 1798.195, address: "127.0.0.1", port: 0, udn: "uuid:00000000-0000-4000-8000-000000000003" };
  const server = createExperimentalServer(config, (category, _message, detail) => logs.push({ category, detail }));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); config.port = (server.address() as import("node:net").AddressInfo).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${config.port}`;
  // No FFmpeg module/runner is injected or invoked in this server; nonexistent binaries are irrelevant.
  const oldFfmpeg = process.env.PT3_FFMPEG; process.env.PT3_FFMPEG = path.join(dir, "nonexistent-ffmpeg");
  t.after(() => { if (oldFfmpeg === undefined) delete process.env.PT3_FFMPEG; else process.env.PT3_FFMPEG = oldFfmpeg; });
  const get = await fetch(`${base}/media/sampleA.mp4`);
  assert.equal(get.status, 200); assert.equal(get.headers.get("content-type"), "video/mp4"); assert.equal(get.headers.get("content-length"), "257"); assert.equal(get.headers.get("accept-ranges"), "bytes");
  assert.equal(get.headers.get("transfer-encoding"), null); assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
  const head = await fetch(`${base}/media/sampleA.mp4`, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "257"); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const headRange = await fetch(`${base}/media/sampleA.mp4`, { method: "HEAD", headers: { Range: "bytes=5-13" } }); assert.equal(headRange.status, 200); assert.equal(headRange.headers.get("content-range"), null);
  for (const [range, start, end] of [["bytes=5-13", 5, 13], ["bytes=-4", 253, 256], ["bytes=250-", 250, 256]] as const) {
    const response = await fetch(`${base}/media/sampleA.mp4`, { headers: { Range: range } });
    assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/257`);
    assert.equal(response.headers.get("content-length"), String(end - start + 1)); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  const invalid = await fetch(`${base}/media/sampleA.mp4`, { headers: { Range: "bytes=999-" } }); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get("content-range"), "bytes */257"); await invalid.arrayBuffer();
  assert.equal((await fetch(`${base}/media/other.mkv`)).status, 404);
  assert.equal((await fetch(`${base}/media/sampleA.mp4`, { method: "POST" })).status, 405);
  const soap = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>exp</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>10</RequestedCount></u:Browse></s:Body></s:Envelope>`;
  const browse = await fetch(`${base}/upnp/control/content-directory`, { method: "POST", headers: { SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' }, body: soap });
  const text = await browse.text(); assert.match(text, /SampleA &amp;amp; 第3話/); assert.match(text, /video\/mp4/); assert.match(text, /sampleA\.mp4/); assert.doesNotMatch(text, /MPEG_TS_JP|AVC_TS_JP|pcrLead|pacing=/);
  const status = await (await fetch(`${base}/api/status`)).json() as { trialId: string };
  const subscription = await fetch(`${base}/upnp/event/content-directory`, { method: "SUBSCRIBE" }); assert.equal(subscription.status, 200); assert.match(subscription.headers.get("sid")!, /^uuid:/);
  const next = await (await fetch(`${base}/api/trials`, { method: "POST" })).json() as { trialId: string }; assert.notEqual(status.trialId, next.trialId);
  const after = await stat(file); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.deepEqual(await readFile(file), bytes);
  assert.equal(logs.filter(x => x.category === "HTTP_MEDIA").length, 7);
  assert.equal(logs.filter(x => x.category === "HTTP_MEDIA").every(x => x.detail.connectionId && x.detail.trialId && x.detail.strategy.mode === "direct"), true);
});
test("separate MP4 DIDL leaves normal TS resource/protocol unchanged", () => {
  const p: Program = { id: "ts1", filePath: "original.ts", title: "Original", size: 18800, modified: new Date(0).toISOString(), duration: 100, published: true, analysis: "ok" };
  const before = browseDIDL("all", 0, 10, [p], "http://localhost:19090", profiles.standard);
  const c: ExperimentalMediaConfig = { file: "sampleA.mp4", title: "SampleA", durationSeconds: 100, address: "localhost", port: 19092, udn: "uuid:1111" };
  const result = experimentalDidl(c, 100); assert.match(result.wrap(result.entries), /video\/mp4/);
  assert.doesNotMatch(mp4ProtocolInfo, /DLNA.ORG_PN/);
  assert.deepEqual(browseDIDL("all", 0, 10, [p], "http://localhost:19090", profiles.standard), before);
});
