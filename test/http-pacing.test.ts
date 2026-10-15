import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";
import { syntheticTs } from "./ts-fixture.js";
import { summarize } from "../src/log-summary.js";

test("実HTTP経路: PCR速度の188/192配信、Range、切断、試行ログ、再起動", { timeout: 90_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pt3-http-"));
  const dataDir = path.join(dir, "data"), logDir = path.join(dir, "logs");
  await fs.mkdir(dataDir);
  const source = syntheticTs(); // 9.4 MB / 10 seconds, includes PCR beyond the initial 8 MiB.
  let child: ChildProcess | undefined;
  let url = "";
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
    child = undefined;
  }
  t.after(async () => { await stop(); await fs.rm(dir, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(), env: { ...process.env, PT3_DATA_DIR: dataDir, PT3_LOG_DIR: logDir, PT3_DISABLE_SSDP: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${output}`)), 15_000);
      child!.once("error", e => { clearTimeout(timer); reject(e); });
      child!.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      child!.stderr!.on("data", b => { output += b.toString(); });
      child!.stdout!.on("data", b => {
        output += b.toString(); const found = /管理画面: http:\/\/localhost:(\d+)/.exec(output);
        if (found && output.includes("スキャン完了")) { clearTimeout(timer); resolve(`http://127.0.0.1:${found[1]}`); }
      });
    });
  }
  async function api(route: string, body?: unknown) {
    const res = await fetch(url + route, body === undefined ? undefined : {
      method: "POST", headers: { 'X-PT3-Management':'1',"Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    assert.equal(res.status, 200, await res.clone().text()); return res.json();
  }
  // Allow startup to load the synthetic entry without ffprobe or touching real recordings.
  await fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ port: 0, interfaceAddress: "127.0.0.1", folders: [path.join(dir, "media")], profile: "container-188-mpeg" }));
  await fs.mkdir(path.join(dir, "media"));
  await fs.writeFile(path.join(dir, "media", "synthetic.ts"), source);
  const stat = await fs.stat(path.join(dir, "media", "synthetic.ts"));
  // Scan uses cached metadata with deliberately incorrect bitrate/duration to prove PCR precedence.
  async function seededStart() {
    await fs.writeFile(path.join(dataDir, "programs.json"), JSON.stringify([{ id: "abcdef", filePath: path.join(dir, "media", "synthetic.ts"), title: "synthetic", size: source.length, modified: stat.mtime.toISOString(), published: true, analysis: "ok", duration: 1, bitrate: 44_000_000 }]));
    await start();
  }
  await seededStart();
  const listed = await api("/api/programs");
  assert.equal(listed.length, 1);
  const id = listed[0].id;
  assert.equal((await api("/api/status")).running, true);
  const browseRequest = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>all</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>0</RequestedCount><SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`;
  const browseResponse = await fetch(url + "/upnp/control/content-directory", {
    method: "POST", headers: { "Content-Type": "text/xml", SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' }, body: browseRequest
  });
  assert.equal(browseResponse.status, 200);
  const browseXml = await browseResponse.text();
  assert.ok(browseXml.includes("MPEG_TS_JP_T"));
  const browseLog = (await api("/api/logs")).find((entry: any) => entry.category === "SOAP" && entry.message === "Browse");
  assert.equal(browseLog.detail.requestXml, browseRequest);
  assert.equal(browseLog.detail.responseXml, browseXml);
  assert.equal(browseLog.detail.responseXmlTruncated, false);
  assert.equal(browseLog.detail.responseBytes, Buffer.byteLength(browseXml));
  assert.equal(browseLog.detail.declaredPacketization, "source");
  const diagnostic = await api(`/api/programs/${id}/diagnostic`, {});
  assert.equal(diagnostic.startup.firstPatPacket, 0);
  assert.equal(diagnostic.startup.syncErrors, 0);
  assert.equal(diagnostic.startup.firstPcr.packet, 2);
  const trials: string[] = [];
  let baseline192: Buffer = Buffer.alloc(0);
  for (const [profile, packetSize] of [["container-188-mpeg", 188], ["container-192-mpeg", 192]] as const) {
    await api("/api/settings", { profile });
    const trial = await api("/api/trials", { programId: id, note: "synthetic HTTP test" }); trials.push(trial.id);
    const head = await fetch(`${url}/media/${id}`, { method: "HEAD" }); assert.equal(head.status, 200);
    const started = performance.now();
    const response = await fetch(`${url}/media/${id}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "video/mpeg");
    const received = Buffer.from(await response.arrayBuffer());
    const elapsedMs = performance.now() - started;
    assert.equal(received.length, source.length / 188 * packetSize);
    if (packetSize === 188) assert.deepEqual(received, source);
    else {
      baseline192 = received;
      for (let i = 0; i < source.length / 188; i++) assert.deepEqual(received.subarray(i * 192 + 4, i * 192 + 192), source.subarray(i * 188, (i + 1) * 188));
    }
    const entries = await api("/api/logs");
    const begin = entries.reverse().find((e: any) => e.trialId === trial.id && e.category === "HTTP_MEDIA" && e.method === "GET");
    const target = begin.detail.targetBitsPerSecond;
    assert.equal(begin.detail.bitrateSource, "whole-file-pcr");
    assert.ok(Math.abs(target / (5000 * packetSize * 8) - 1) < 0.0001);
    const actual = received.length * 8 * 1000 / elapsedMs;
    assert.ok(actual / target > 0.85 && actual / target < 1.12, `received ${actual}, target ${target}`);
    console.log(`HTTP ${packetSize}: target ${(target / 1e6).toFixed(3)}Mbps, received ${(actual / 1e6).toFixed(3)}Mbps / ${elapsedMs.toFixed(0)}ms`);
    const offset = packetSize * 1000 + 13, length = packetSize * 10_000;
    const ranged = await fetch(`${url}/media/${id}`, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    assert.equal(ranged.status, 206);
    const rangeStart = performance.now();
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), received.subarray(offset, offset + length));
    const rangeSpeed = length * 8 * 1000 / (performance.now() - rangeStart);
    assert.ok(rangeSpeed / target > 0.8 && rangeSpeed / target < 1.2);
    const controller = new AbortController();
    const interrupted = await fetch(`${url}/media/${id}`, { signal: controller.signal });
    await interrupted.body!.getReader().read(); controller.abort();
    await api(`/api/trials/${trial.id}/observation`, { video: null, audio: null, note: "合成TSなので実機映像未確認" });
  }
  // Exercise the diagnostic envelope through the real server and TCP receiver.
  const invalidIds = await fetch(url + "/api/settings", { method: "POST", headers: { 'X-PT3-Management':'1',"Content-Type": "application/json" }, body: JSON.stringify({ contentPacketProgramIds: ["missing"] }) });
  assert.equal(invalidIds.status, 400); await invalidIds.json();
  await api("/api/settings", { contentPacketProgramIds: [id] });
  const envelopeTrial = await api("/api/trials", { programId: id, note: "synthetic Content Packet HTTP test" });
  const publishedResponse = await fetch(url + "/upnp/control/content-directory", {
    method: "POST", headers: { "Content-Type": "text/xml", SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' }, body: browseRequest
  });
  assert.equal(publishedResponse.status, 200);
  const publishedXml = (await publishedResponse.text()).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const envelopeUrl = /<res [^>]*>([^<]+)<\/res>/.exec(publishedXml)![1];
  assert.equal(new URL(envelopeUrl).searchParams.get("encapsulation"), "arib-content-packet");
  const publishedSize = Number(/<res [^>]*size="(\d+)"/.exec(publishedXml)![1]);
  const envelopeHead = await fetch(envelopeUrl, { method: "HEAD" }); assert.equal(envelopeHead.status, 200);
  const envelopeStart = performance.now();
  const envelopeResponse = await fetch(envelopeUrl); assert.equal(envelopeResponse.status, 200);
  const wire = Buffer.from(await envelopeResponse.arrayBuffer()), unwrapped: Buffer[] = [];
  const envelopeElapsed = performance.now() - envelopeStart;
  let position = 0, blockCount = 0;
  while (position < wire.length) {
    assert.ok(position + 14 <= wire.length);
    assert.deepEqual(wire.subarray(position, position + 10), Buffer.alloc(10));
    const length = wire.readUInt32BE(position + 10); assert.ok(length > 0 && length % 192 === 0);
    assert.ok(position + 14 + length <= wire.length);
    unwrapped.push(wire.subarray(position + 14, position + 14 + length));
    position += 14 + length; blockCount++;
  }
  const payload = Buffer.concat(unwrapped); assert.equal(payload.length, source.length / 188 * 192);
  assert.deepEqual(payload, baseline192, "All ATS and TS bytes remain exact through the published resource");
  for (let i = 0; i < source.length / 188; i++)
    assert.deepEqual(payload.subarray(i * 192 + 4, i * 192 + 192), source.subarray(i * 188, (i + 1) * 188));
  assert.equal(Number(envelopeHead.headers.get("content-length")), wire.length);
  assert.equal(publishedSize, wire.length);
  assert.equal(Number(envelopeResponse.headers.get("content-length")), wire.length);
  const envelopeEntries = await api("/api/logs");
  const envelopeLog = envelopeEntries.find((e: any) => e.trialId === envelopeTrial.id && e.category === "HTTP_MEDIA" && e.method === "GET");
  assert.equal(envelopeLog.detail.encapsulation.blocks, blockCount);
  assert.equal(envelopeLog.detail.encapsulation.payloadBytes, payload.length);
  const envelopeTarget = envelopeLog.detail.targetBitsPerSecond;
  assert.ok(Math.abs(envelopeTarget / (5000 * 192 * 8 * wire.length / payload.length) - 1) < 0.0001);
  const envelopeSpeed = wire.length * 8 * 1000 / envelopeElapsed;
  assert.ok(envelopeSpeed / envelopeTarget > 0.85 && envelopeSpeed / envelopeTarget < 1.12);
  console.log(`HTTP Content Packet: target ${(envelopeTarget / 1e6).toFixed(3)}Mbps, received ${(envelopeSpeed / 1e6).toFixed(3)}Mbps / ${envelopeElapsed.toFixed(0)}ms`);
  const unsupportedRange = await fetch(envelopeUrl, { headers: { Range: "bytes=0-191" } });
  assert.equal(unsupportedRange.status, 400); await unsupportedRange.json();
  // One opt-in resource: time-seek declarations and actual bounded TCP payload.
  await api('/api/settings', { timeSeekProgramIds: [id] });
  const seekUrl = envelopeUrl + '&seek=pcr';
  const seekHead = await fetch(seekUrl, { method: 'HEAD' });
  assert.equal(seekHead.status, 200);
  assert.equal(seekHead.headers.get('accept-ranges'), 'none');
  assert.ok(seekHead.headers.get('contentfeatures.dlna.org')!.includes('DLNA.ORG_OP=10'));
  assert.ok(seekHead.headers.get('contentfeatures.dlna.org')!.includes('DLNA.ORG_FLAGS=01700000'));
  assert.equal(seekHead.headers.get('vary'), 'TimeSeekRange.dlna.org');
  assert.ok(seekHead.headers.get('availableseekrange.dlna.org')!.includes('npt=0.000-10.000'));
  const seekBrowse = await fetch(url + '/upnp/control/content-directory', { method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' }, body: browseRequest });
  const seekXml = await seekBrowse.text();
  assert.ok(seekXml.includes('DLNA.ORG_OP=10'));
  assert.ok(seekXml.includes('seek=pcr'));
  const cm = await fetch(url + '/upnp/control/connection-manager', { method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: '"urn:schemas-upnp-org:service:ConnectionManager:1#GetProtocolInfo"' },
    body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetProtocolInfo xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1"/></s:Body></s:Envelope>' });
  const cmXml = await cm.text(); assert.equal(cm.status, 200); assert.ok(cmXml.includes('DLNA.ORG_OP=10')); assert.ok(cmXml.includes('DLNA.ORG_OP=01'));
  const seekTrial = await api('/api/trials', { programId: id, note: 'PC synthetic time-seek test' });
  const unchanged = await fetch(seekUrl);
  assert.equal(unchanged.headers.get('timeseekrange.dlna.org'), `npt=0.000-10.000/10.000 bytes=0-${wire.length-1}/${wire.length}`);
  assert.equal(seekHead.headers.get('timeseekrange.dlna.org'),unchanged.headers.get('timeseekrange.dlna.org'));
  assert.deepEqual(Buffer.from(await unchanged.arrayBuffer()), wire, 'Opt-in normal GET body must remain exact');
  for (const header of ['npt=2.000-4.000', 'npt=00:00:06.000-00:00:08.000', 'npt=9.000-', 'npt=0-0.5']) {
    const seekStart = performance.now();
    const r = await fetch(seekUrl, { headers: { 'TimeSeekRange.dlna.org': header } });
    assert.equal(r.status, 200);
    const received = Buffer.from(await r.arrayBuffer());
    const elapsed = performance.now() - seekStart;
    const result = /npt=([\d.]+)-([\d.]+)\/([\d.]+) bytes=(\d+)-(\d+)\/(\d+)/.exec(r.headers.get('timeseekrange.dlna.org')!)!;
    assert.ok(result);
    const offset = Number(result[4]), end = Number(result[5]);
    assert.equal(Number(result[6]), wire.length);
    assert.equal(Number(r.headers.get('content-length')), received.length);
    assert.deepEqual(received, wire.subarray(offset, end + 1), 'Time slice must be exact original Content Packets including ATS');
    assert.equal(received[0], 0); assert.equal(received[18], 0x47);
    const requestedStart = header.includes('06.000') ? 6 : Number(/^npt=([\d.]+)/.exec(header)![1]);
    assert.ok(Number(result[1]) <= requestedStart && requestedStart - Number(result[1]) < 0.501);
    assert.ok(Number(result[2]) > requestedStart);
    const speed = received.length * 8000 / elapsed;
    assert.ok(speed / envelopeTarget > 0.8 && speed / envelopeTarget < 1.2);
  }
  const seekHead30 = await fetch(seekUrl, { method: 'HEAD', headers: { 'TimeSeekRange.dlna.org': 'npt=3-' } });
  assert.equal(seekHead30.status, 200); assert.ok(seekHead30.headers.get('timeseekrange.dlna.org'));
  for (const header of ['npt=10-', 'npt=999-', 'npt=4-3', 'npt=abc-', 'npt=00:61:00-', 'npt=NaN-']) {
    const r = await fetch(seekUrl, { headers: { 'TimeSeekRange.dlna.org': header } });
    assert.equal(r.status, 416); assert.equal((await r.arrayBuffer()).byteLength, 0);
  }
  const mixed = await fetch(seekUrl, { headers: { 'TimeSeekRange.dlna.org': 'npt=2-', Range: 'bytes=0-191' } });
  assert.equal(mixed.status, 400); await mixed.json();
  const disabled = await fetch(envelopeUrl, { headers: { 'TimeSeekRange.dlna.org': 'npt=2-' } });
  assert.equal(disabled.status, 400); await disabled.json();
  const seekLogs = await api('/api/logs');
  assert.equal(seekLogs.filter((l: any) => l.trialId === seekTrial.id && l.category === 'HTTP_MEDIA' && l.method === 'GET').length, 5);
  const fullHead = await fetch(envelopeUrl, { method: 'HEAD' });
  assert.equal(fullHead.headers.get('contentfeatures.dlna.org'), envelopeHead.headers.get('contentfeatures.dlna.org'));
  let memory: any[] = [];
  for (let i = 0; i < 50; i++) {
    memory = await api("/api/logs");
    if (memory.filter(e => e.detail?.outcome === "client-disconnected").length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(memory.filter(e => e.detail?.outcome === "client-disconnected").length, 2);
  const disk = (await fs.readFile(path.join(logDir, "diagnostics.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(disk, JSON.parse(JSON.stringify(memory)));
  const summary = summarize(disk);
  for (const id of trials) {
    const trial = summary.find(t => t.trialId === id)!;
    assert.equal(trial.getCount, 3); assert.equal(trial.regetCount, 2); assert.equal(trial.observation.source, "human");
    assert.equal(new Set(trial.connections.map((c: any) => c.connectionId)).size, 4);
  }
  // Missing PCR must not silently select a metadata/fixed speed.
  const noPcr = Buffer.from(source);
  for (let offset = 2 * 188; offset < noPcr.length; offset += 188) noPcr[offset + 5] = 0;
  await fs.writeFile(path.join(dir, "media", "no-pcr.ts"), noPcr);
  const rescanned = await api("/api/scan", {});
  const noPcrId = rescanned.find((p: any) => p.title === "no-pcr").id;
  await api("/api/trials", { programId: noPcrId });
  const rejected = await fetch(`${url}/media/${noPcrId}`); assert.equal(rejected.status, 422); await rejected.json();
  const badFolders = await fetch(url + "/api/settings", { method: "POST", headers: { 'X-PT3-Management':'1',"Content-Type": "application/json" }, body: JSON.stringify({ folders: [dir] }) });
  assert.equal(badFolders.status, 400); await badFolders.json();
  await api("/api/settings", { profile: "container-192-no-pn" });
  const noGet = await api("/api/trials", { programId: id, note: "GETなしも識別可能" });
  const invalidObservation = await fetch(`${url}/api/trials/${noGet.id}/observation`, { method: "POST", headers: { 'X-PT3-Management':'1',"Content-Type": "application/json" }, body: JSON.stringify({ video: "yes", audio: true }) });
  assert.equal(invalidObservation.status, 400); await invalidObservation.json();
  const allEntries = await api("/api/logs");
  assert.equal(summarize(allEntries).find(trial => trial.trialId === noGet.id)!.getCount, 0);
  assert.ok(allEntries.some((e: any) => e.detail?.outcome === "pcr-unavailable"));
  const cli = spawn(process.execPath, ["--import", "tsx", "src/log-summary.ts", logDir, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  let cliOutput = ""; cli.stdout.on("data", b => { cliOutput += b.toString(); });
  const [cliCode] = await once(cli, "exit"); assert.equal(cliCode, 0);
  assert.deepEqual(JSON.parse(cliOutput), JSON.parse(JSON.stringify(summarize(allEntries))));
  const previous = await fs.readFile(path.join(logDir, "diagnostics.jsonl"), "utf8");
  await stop(); await seededStart();
  assert.ok((await fs.readFile(path.join(logDir, "diagnostics.jsonl"), "utf8")).startsWith(previous));
  assert.equal((await api("/api/status")).running, true);
  assert.deepEqual((await api("/api/status")).settings.contentPacketProgramIds, [id]);
  assert.deepEqual((await api('/api/status')).settings.timeSeekProgramIds, [id]);
});
