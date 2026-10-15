import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runShadow, attachShadow, summarizeShadow, SHADOW_VERSION, snapshotHash, matchingFingerprint, type ShadowRequest, type ShadowDependencies, type CapabilitySnapshot } from '../src/playback-shadow.js';
import { createShadowStore, sourceCacheFile, saveShadowJson, sourceFromProbe, acquireCapability } from '../src/playback-shadow-store.js';
import { initialShadowPolicy } from '../src/shadow-profile-policy.js';
const request: ShadowRequest = { fingerprint: { path: '/recording.ts', size: 10, mtimeMs: 123 }, remoteIp: '192.168.1.2', method: 'GET', headers: {}, actualPlaybackPath: { handler: 'legacy', pacing: 'unchanged' } };
const capability: CapabilitySnapshot = { deviceId: 'uuid:actual-dmp', remoteIp: request.remoteIp, controlUrl: 'http://192.168.1.2/cm', sink: 'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T', sinkHash: '', acquiredAt: new Date().toISOString(), origin: 'current-read' };
capability.sinkHash = snapshotHash(capability.sink);
const source = { version: SHADOW_VERSION, fingerprint: request.fingerprint, analyzedAt: new Date().toISOString(), scanScope: 'test-only', characteristics: {
  transport: { container: 'mp4', framing: 'file' as const, mime: 'video/mp4', seek: 'byte' as const },
  video: { codec: 'h264', profile: 'High', level: 42, codedWidth: 1920, codedHeight: 1088, bitDepth: 8, chroma: '420', scan: 'progressive', displayTicks: [0, 1502, 3003, 7508], timebase: 90000 },
  audio: { codec: 'aac', format: 'mpeg4-aac-lc', channels: 2, sampleRate: 48000 },
  validation: { value: false, evidence: { status: 'inferred' as const, reference: 'fixture', scope: 'test' } }
} };
const deps: ShadowDependencies = { source: async () => source, capability: async () => capability, policy: async () => initialShadowPolicy(), record: () => {} };
test('missing or stale source fingerprints are incomplete, size/mtime/path all matter', async () => {
  for (const field of ['size', 'mtimeMs', 'path'] as const) {
    const wrong = { ...request.fingerprint, [field]: field === 'path' ? '/other.ts' : 999 };
    assert.equal(matchingFingerprint(request.fingerprint, wrong), false);
    assert.equal((await runShadow(request, { ...deps, source: async () => ({ ...source, fingerprint: wrong }) })).decisionStatus, 'incomplete');
  }
  assert.equal((await runShadow(request, { ...deps, source: async () => undefined })).decisionStatus, 'incomplete');
});
test('exceptions, timeout and storage failure never reject or apply a playback decision', async () => {
  const fail = await runShadow(request, { ...deps, source: async () => { throw new Error('broken cache'); }, record: () => { throw new Error('disk failure'); } });
  assert.equal(fail.decisionStatus, 'error'); assert.equal(fail.applied, false);
  const timed = await runShadow(request, { ...deps, capability: () => new Promise(() => {}) }, 10);
  assert.equal(timed.decisionStatus, 'timeout'); assert.deepEqual(timed.actualPlaybackPath, request.actualPlaybackPath);
});
test('shadow executes once after response completion; never waits on startup or reads response', async () => {
  const res = new EventEmitter() as ServerResponse; let calls = 0;
  attachShadow(res, request, async r => { calls++; assert.ok(r.decisionId); await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(calls, 0); res.emit('finish'); res.emit('close');
  assert.equal(calls, 0); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});
test('observations scoped by both DMP identity and exact Sink snapshot; no normative promotion', async () => {
  const policy = initialShadowPolicy();
  const observation = { profileId: policy.profiles[0].id, framing: 'jp-content-packet' as const, outcome: 'success' as const, videoCodec: 'h264', videoProfile: 'Main', maxLevel: 40,
    audioFormat: 'mpeg2-aac-lc', evidence: { status: 'experimentally-confirmed' as const, reference: 'specific trial', scope: 'bounded150s' } };
  policy.observations = [{ deviceId: capability.deviceId, sinkHash: capability.sinkHash, observation, testedMediaCharacteristics: { codec: 'h264', scan: 'progressive' } }];
  const hit = await runShadow(request, { ...deps, policy: async () => policy });
  assert.equal(hit.policySnapshot!.observations.length, 1);
  assert.equal(hit.shadowDecision!.candidates[0].target.video.evidence.status, 'experimentally-confirmed');
  for (const cap of [{ ...capability, deviceId: 'uuid:another' }, { ...capability, sink: capability.sink + ';NEW=1', sinkHash: snapshotHash(capability.sink + ';NEW=1') }]) {
    const miss = await runShadow(request, { ...deps, capability: async () => cap, policy: async () => policy });
    assert.equal(miss.policySnapshot!.observations.length, 0);
    assert.equal(miss.shadowDecision!.candidates[0].target.video.evidence.status, 'inferred');
  }
});
test('bounded cache-only store persists incomplete/error records without changing source', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-cache-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'media', 'recording.ts'); await fs.mkdir(path.dirname(file)); await fs.writeFile(file, 'unchanged');
  const st = await fs.stat(file), root = path.join(dir, 'shadow');
  const r = { ...request, fingerprint: { path: file, size: st.size, mtimeMs: st.mtimeMs } };
  const run = createShadowStore(root, () => [path.dirname(file)]);
  const missing = await run(r); assert.equal(missing.decisionStatus, 'incomplete');
  await fs.mkdir(path.dirname(sourceCacheFile(root, file)), { recursive: true }); await fs.writeFile(sourceCacheFile(root, file), '{bad JSON');
  const bad = await run(r); assert.equal(bad.decisionStatus, 'error');
  const rows = (await fs.readFile(path.join(root, 'logs', 'diagnostics.jsonl'), 'utf8')).trim().split('\n').map(x => JSON.parse(x));
  assert.equal(rows.length, 2); assert.notEqual(rows[0].decisionId, rows[1].decisionId);
  assert.equal(await fs.readFile(file, 'utf8'), 'unchanged'); assert.equal((await fs.stat(file)).mtimeMs, st.mtimeMs);
  assert.equal(summarizeShadow(rows).status.incomplete, 2);
});
test('probe adapter preserves display timestamps, codec-specific levels, and unknown HRD/audio ID', () => {
  const parsed = sourceFromProbe('sample.mkv', { size: 1, mtimeMs: 2 }, { format: { format_name: 'matroska,webm' }, streams: [
    { codec_type: 'video', codec_name: 'hevc', profile: 'Main', level: 123, width: 1920, height: 1080, pix_fmt: 'yuv420p', field_order: 'progressive' },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }], frames: [{ media_type: 'video', pts_time: '0' }, { media_type: 'video', pts_time: '.017' }] });
  assert.equal(parsed.characteristics.video.level, 123); assert.deepEqual(parsed.characteristics.video.displayTicks, [0, 1530]);
  assert.equal(parsed.characteristics.audio!.format, 'aac-unspecified-mpeg-id'); assert.equal(parsed.characteristics.video.removalTicks, undefined);
});
test('current GetProtocolInfo, cached timestamp, changed Sink hash and DMP identity rejection', async t => {
  let advertised = capability.sink, calls = 0;
  const server = createServer((req, res) => {
    calls++; res.setHeader('Content-Type', 'text/xml');
    if (req.url === '/description') res.end('<root><device><UDN>uuid:actual-dmp</UDN></device></root>');
    else { assert.equal(req.headers.soapaction, '"urn:schemas-upnp-org:service:ConnectionManager:1#GetProtocolInfo"'); res.end(`<GetProtocolInfoResponse><Sink>${advertised}</Sink></GetProtocolInfoResponse>`); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const device = { remoteIp: '127.0.0.1', deviceId: capability.deviceId, descriptionUrl: base + '/description', controlUrl: base + '/cm' };
  await assert.rejects(acquireCapability({ ...device, deviceId: 'uuid:wrong' }, AbortSignal.timeout(1000)), /identity changed/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-cap-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const media = path.join(dir, 'media'), root = path.join(dir, 'shadow'); await fs.mkdir(media); const file = path.join(media, 'fixture.ts'); await fs.writeFile(file, 'read-only');
  const st = await fs.stat(file), r = { ...request, remoteIp: '127.0.0.1', fingerprint: { path: file, size: st.size, mtimeMs: st.mtimeMs } };
  await saveShadowJson(path.join(root, 'devices.json'), [device]); await saveShadowJson(path.join(root, 'policy.json'), initialShadowPolicy());
  await saveShadowJson(sourceCacheFile(root, file), { ...source, fingerprint: r.fingerprint });
  const run = createShadowStore(root, () => [media]), first = await run(r), count = calls;
  const second = await run(r);
  assert.equal(first.capabilitySnapshot!.origin, 'current-read'); assert.equal(second.capabilitySnapshot!.origin, 'cached-read');
  assert.equal(second.capabilitySnapshot!.acquiredAt, first.capabilitySnapshot!.acquiredAt); assert.equal(calls, count);
  const cache = path.join(root, 'capabilities', `${snapshotHash(device.deviceId)}.json`);
  await saveShadowJson(cache, { ...first.capabilitySnapshot, acquiredAt: '2000-01-01T00:00:00Z' });
  advertised += ';UPDATED=1'; const third = await run(r);
  assert.notEqual(third.capabilitySnapshot!.sinkHash, first.capabilitySnapshot!.sinkHash); assert.equal(third.capabilitySnapshot!.origin, 'current-read');
  advertised='';await assert.rejects(acquireCapability(device,AbortSignal.timeout(1000)),/Empty Sink/);
  const empty=await acquireCapability({...device,allowEmptySink:true},AbortSignal.timeout(1000));assert.equal(empty.sink,'');assert.equal(empty.sinkHash,snapshotHash(''));
  await assert.rejects(acquireCapability({...device,allowEmptySink:true,deviceId:'uuid:wrong'},AbortSignal.timeout(1000)),/identity changed/);
});
