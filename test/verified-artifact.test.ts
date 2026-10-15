import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { syntheticTs } from './ts-fixture.js';
import { Tts192Transform } from '../src/tts.js';
import { buildPcrIndex } from '../src/pcr-index.js';
import { timeSeekSlice } from '../src/time-seek.js';
import { experimentalLayout } from '../src/experimental-content-packet.js';
import { experimentalFormat } from '../src/experimental-media.js';
import { fileFingerprint } from '../src/file-fingerprint.js';
import { cadencePlanFingerprint, cachedPlanFingerprint, validateArtifact, matchesArtifactDecision, type ArtifactVerification, type VerifiedArtifactAdapter } from '../src/verified-artifact.js';
import { initialShadowPolicy } from '../src/shadow-profile-policy.js';
import { planCadenceNormalization } from '../src/cadence-plan.js';
import { createExperimentalCatalog, experimentalObjectId, CATALOG_VERSION, type ExperimentalCatalog, type CachedExperimentalDecision } from '../src/experimental-catalog.js';

test('verified adapter: five entries, only bound target resource, GET/HEAD/TimeSeek byte-exact; stale inputs isolated', { timeout: 15000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verified-artifact-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourceFile = path.join(dir, 'SampleB.MP4'); await fs.writeFile(sourceFile, 'source MP4 placeholder, never served or decoded');
  const artifactFile = path.join(dir, 'derived.m2ts'), ts = syntheticTs(1500, 500), parts: Buffer[] = [];
  for await (const b of Readable.from([ts]).pipe(new Tts192Transform(0, 752000, 0, 1500 * 192))) parts.push(Buffer.from(b));
  const artifactBytes = Buffer.concat(parts); await fs.writeFile(artifactFile, artifactBytes);
  const sourceFingerprint = await fileFingerprint(sourceFile), artifactFingerprint = await fileFingerprint(artifactFile), index = (await buildPcrIndex(artifactFile))!;
  assert.ok(index);
  const config = { file: artifactFile, title: 'fixture', durationSeconds: 3, address: '127.0.0.1', port: 0, udn: 'uuid:00000000-0000-4000-8000-000000000003', mode: 'remux' as const, contentPacket: true, contentPacketBlockBytes: 5568, timeSeek: true };
  const transport = { container: 'mpegts', framing: 'jp-content-packet' as const, mime: 'video/vnd.dlna.mpeg-tts', profileName: 'AVC_TS_JP_AAC_T', seek: 'time' as const };
  const plan = { strategy: 'full-transcode', targetProfileId: 'jp', transport, transforms: [{ kind: 'resize' }], cadenceRequired: false, verification: 'supported-candidate' };
  const decision: CachedExperimentalDecision = { remoteIp: '127.0.0.1', deviceId: 'uuid:fixture', sinkHash: 'sink', acquiredAt: new Date().toISOString(), decisionId: 'fixture', decisionFingerprint: 'decision-hash', sourceFingerprint, sourceCharacteristics: {}, decisionStatus: 'complete', disposition: 'executable', selected: plan, candidateStrategies: [], unknowns: [] };
  const size = experimentalLayout(artifactBytes.length, index.averageBitrate, true, 5568).servedBytes;
  const proofFile = path.join(dir, 'verification.json'), preparationFile = path.join(dir, 'preparation.json'), observationFile = path.join(dir, 'observation.json');
  await fs.writeFile(preparationFile, '{}'); await fs.writeFile(observationFile, '{}');
  const verification = { version: 'verified-artifact-v1', sourceFingerprint, artifactFingerprint, decisionFingerprint: decision.decisionFingerprint, targetProfile: 'jp', verificationStatus: 'experimentally-confirmed',
    config, index, servedBytes: size, preparationFingerprint: await fileFingerprint(preparationFile), observationFingerprint: await fileFingerprint(observationFile), transformPlan: plan.transforms, planFingerprint: cachedPlanFingerprint(plan) };
  await fs.writeFile(proofFile, JSON.stringify(verification));
  const adapter: VerifiedArtifactAdapter = { kind: 'verified-artifact', sourceFingerprint, artifactFingerprint, decisionFingerprint: decision.decisionFingerprint!, verificationRecord: await fileFingerprint(proofFile), targetProfile: 'jp', transport, verificationStatus: 'experimentally-confirmed', deviceId: decision.deviceId, sinkHash: decision.sinkHash, size, durationSeconds: 3, protocolInfo: experimentalFormat(config).protocolInfo, planFingerprint: verification.planFingerprint };
  const entry = { objectId: experimentalObjectId(sourceFile), filename: 'SampleB.MP4', fingerprint: sourceFingerprint, sourceState: 'cached' as const, decisions: [decision], adapter };
  const catalog: ExperimentalCatalog = { version: CATALOG_VERSION, enabled: true, generatedAt: new Date().toISOString(), entries: [entry] };
  for (const name of ['SampleA.mp4', 'サンプル映像C.mkv', 'サンプル音声欠損.mp4', 'サンプル映像D.mkv']) {
    const file = path.join(dir, name); await fs.writeFile(file, 'placeholder'); catalog.entries.push({ objectId: experimentalObjectId(file), filename: name, fingerprint: await fileFingerprint(file), sourceState: 'unanalysed', decisions: [] });
  }
  await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  const controller = createExperimentalCatalog(dir, () => {});
  const page = () => controller.browse({ objectId: 'experimental', start: 0, count: 0, metadata: false }, '127.0.0.1', 'http://fixture', () => { throw Error('not normal root'); });
  const result = (await page())!; assert.equal(result.total, 5); assert.equal((result.didl.match(/<res /g) || []).length, 1); assert.ok(result.didl.includes('AVC_TS_JP_AAC_T')); assert.ok(!result.didl.includes('video/mp4'));
  assert.deepEqual(await controller.protocolInfos('127.0.0.1'), [adapter.protocolInfo]);
  assert.deepEqual(await controller.protocolInfos('192.168.1.50'), []);
  assert.ok(await validateArtifact(adapter));
  const server = createServer((req, res) => { void controller.media(req, res, entry.objectId.split('/').at(-1)!); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/experimental/media/${entry.objectId.split('/').at(-1)}`;
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(size)); assert.equal(head.headers.get('accept-ranges'), 'none'); assert.equal(head.headers.get('contentfeatures.dlna.org'), adapter.protocolInfo.split(':').slice(3).join(':'));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(url, { headers: { Range: 'bytes=0-191' } }); assert.equal(range.status, 400); await range.arrayBuffer();
  function unwrap(wire: Buffer) { const blocks: Buffer[] = []; let offset = 0; while (offset < wire.length) { assert.deepEqual(wire.subarray(offset, offset + 10), Buffer.alloc(10)); const n = wire.readUInt32BE(offset + 10); blocks.push(wire.subarray(offset + 14, offset + 14 + n)); offset += 14 + n; } assert.equal(offset, wire.length); return Buffer.concat(blocks); }
  const seekHeader = 'npt=1-1.2', slice = timeSeekSlice(index, 5568, seekHeader), seek = await fetch(url, { headers: { 'TimeSeekRange.dlna.org': seekHeader } });
  assert.equal(seek.status, 200); assert.ok(seek.headers.has('timeseekrange.dlna.org')); assert.deepEqual(unwrap(Buffer.from(await seek.arrayBuffer())), artifactBytes.subarray(slice.firstPacket * 192, slice.endPacket * 192));
  const get = await fetch(url); assert.equal(get.status, 200); assert.deepEqual(unwrap(Buffer.from(await get.arrayBuffer())), artifactBytes);
  // No media changes, executor or encoder launches in this path.
  assert.equal((await fs.stat(sourceFile)).mtimeMs, sourceFingerprint.mtimeMs);
  assert.equal(matchesArtifactDecision(entry, { ...decision, decisionFingerprint: 'changed' }, adapter), false);
  assert.equal(matchesArtifactDecision(entry, { ...decision, selected: { ...plan, transforms: [] } }, adapter), false);
  const auditedCandidate: CachedExperimentalDecision = { ...decision, selected: undefined, disposition: 'diagnostic-only', artifactCandidate: { ...plan, verification: 'diagnostic-only' }, unknowns: ['source dpbFrames unknown; output audit required', 'named DLNA profile full conformance unconfirmed'] };
  assert.equal(matchesArtifactDecision(entry, auditedCandidate, adapter), true);
  assert.equal(matchesArtifactDecision(entry, { ...auditedCandidate, unknowns: ['source bitDepth unknown'] }, adapter), false);
  assert.equal(matchesArtifactDecision(entry, { ...auditedCandidate, artifactCandidate: { ...plan, verification: 'blocked' } }, adapter), false);
  assert.equal(matchesArtifactDecision({ ...entry, fingerprint: { ...sourceFingerprint, size: 999 } }, decision, adapter), false);
  assert.equal(await validateArtifact({ ...adapter, artifactFingerprint: { ...artifactFingerprint, mtimeMs: 0 } }), undefined);
  assert.equal(await validateArtifact({ ...adapter, artifactFingerprint: { ...artifactFingerprint, sha256: 'changed' } }), undefined);
  // A second, cadence-required binding shares only the delivery contract, not the source/decision.
  const sampleA = catalog.entries.find(e => e.filename === 'SampleA.mp4')!;
  const policy = initialShadowPolicy(), timing = policy.profiles[0].video.value.timing!;
  const ticks = [0, 1502, 3003, 4505, 6006], cadence = planCadenceNormalization(ticks, timing);
  const cadenceFingerprint = cadencePlanFingerprint(cadence);
  const sampleAPlan = { ...plan, cadenceRequired: true, cadenceFingerprint, transforms: [{ kind: 'cadence-normalization' }] };
  const sampleADecision = { ...decision, sourceFingerprint: sampleA.fingerprint, decisionFingerprint: 'sampleA-decision', selected: sampleAPlan };
  const sampleAProofFile = path.join(dir, 'sampleA-proof.json');
  const sampleAProof = { ...verification, sourceFingerprint: sampleA.fingerprint, decisionFingerprint: sampleADecision.decisionFingerprint, planFingerprint: cachedPlanFingerprint(sampleAPlan), cadenceFingerprint,
    sourceSnapshot: { characteristics: { video: { displayTicks: ticks } } }, policy: { ...policy, profiles: [{ ...policy.profiles[0], id: 'jp' }] } };
  await fs.writeFile(sampleAProofFile, JSON.stringify(sampleAProof));
  const sampleAAdapter = { ...adapter, sourceFingerprint: sampleA.fingerprint, decisionFingerprint: sampleADecision.decisionFingerprint, planFingerprint: sampleAProof.planFingerprint, cadenceFingerprint, verificationRecord: await fileFingerprint(sampleAProofFile) };
  sampleA.sourceState = 'cached'; sampleA.decisions = [sampleADecision]; sampleA.adapter = sampleAAdapter;
  await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  assert.equal((await page())!.didl.match(/<res /g)?.length, 2);
  assert.ok(await validateArtifact(sampleAAdapter));
  assert.equal(matchesArtifactDecision(sampleA, sampleADecision, sampleAAdapter), true);
  assert.equal(matchesArtifactDecision(sampleA, { ...sampleADecision, selected: { ...sampleAPlan, cadenceFingerprint: 'stale-selection' } }, sampleAAdapter), false);
  assert.equal(matchesArtifactDecision(sampleA, sampleADecision, { ...sampleAAdapter, cadenceFingerprint: undefined }), false);
  assert.equal(await validateArtifact({ ...sampleAAdapter, cadenceFingerprint: 'stale-selection' }), undefined);
  const savedSampleB = JSON.stringify(entry.adapter);
  for (const invalid of [
    { ...sampleAAdapter, sourceFingerprint: { ...sampleA.fingerprint, size: 0 } },
    { ...sampleAAdapter, decisionFingerprint: 'changed' },
    { ...sampleAAdapter, cadenceFingerprint: 'changed' },
    { ...sampleAAdapter, artifactFingerprint: { ...artifactFingerprint, sha256: 'changed' } },
    { ...sampleAAdapter, artifactFingerprint: { ...artifactFingerprint, path: path.join(dir, 'missing') } }
  ]) {
    sampleA.adapter = invalid; await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
    assert.equal((await page())!.didl.match(/<res /g)?.length, 1);
    assert.equal(JSON.stringify(entry.adapter), savedSampleB);
  }
  sampleA.adapter = sampleAAdapter; await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  const sampleAServer = createServer((req, res) => { void controller.media(req, res, sampleA.objectId.split('/').at(-1)!); });
  sampleAServer.listen(0, '127.0.0.1'); await once(sampleAServer, 'listening');
  t.after(async () => { sampleAServer.closeAllConnections(); await new Promise<void>(resolve => sampleAServer.close(() => resolve())); });
  const sampleAUrl = `http://127.0.0.1:${(sampleAServer.address() as import('node:net').AddressInfo).port}/experimental/media/${sampleA.objectId.split('/').at(-1)}`;
  const sampleAGet = await fetch(sampleAUrl); assert.equal(sampleAGet.status, 200); assert.deepEqual(unwrap(Buffer.from(await sampleAGet.arrayBuffer())), artifactBytes);
  // Third binding: independent HEVC source, codec/audio/cadence transforms and proof.
  const hevc = catalog.entries.find(e => e.filename === 'サンプル映像C.mkv')!;
  const hevcPlan = { ...sampleAPlan, transforms: [{ kind: 'video-codec', reason: 'hevc -> h264' }, { kind: 'audio-format-normalization', reason: 'source AAC -> MPEG-2 AAC' }, { kind: 'cadence-normalization', reason: 'target removal interval' }] };
  const hevcDecision = { ...sampleADecision, sourceFingerprint: hevc.fingerprint, decisionFingerprint: 'hevc-decision', selected: hevcPlan };
  const hevcProofFile = path.join(dir, 'hevc-proof.json');
  await fs.writeFile(hevcProofFile, JSON.stringify({ ...sampleAProof, sourceFingerprint: hevc.fingerprint, decisionFingerprint: hevcDecision.decisionFingerprint, transformPlan: hevcPlan.transforms, planFingerprint: cachedPlanFingerprint(hevcPlan) }));
  const hevcAdapter = { ...sampleAAdapter, sourceFingerprint: hevc.fingerprint, decisionFingerprint: hevcDecision.decisionFingerprint, planFingerprint: cachedPlanFingerprint(hevcPlan), verificationRecord: await fileFingerprint(hevcProofFile) };
  hevc.sourceState = 'cached'; hevc.decisions = [hevcDecision]; hevc.adapter = hevcAdapter;
  await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  assert.equal((await page())!.didl.match(/<res /g)?.length, 3);
  assert.ok(await validateArtifact(hevcAdapter));
  assert.equal(matchesArtifactDecision(hevc, { ...hevcDecision, selected: { ...hevcPlan, transforms: [] } }, hevcAdapter), false);
  const preserved = JSON.stringify([entry.adapter, sampleA.adapter]);
  for (const invalid of [
    { ...hevcAdapter, sourceFingerprint: { ...hevc.fingerprint, size: 0 } },
    { ...hevcAdapter, decisionFingerprint: 'changed' },
    { ...hevcAdapter, planFingerprint: 'changed' },
    { ...hevcAdapter, cadenceFingerprint: 'changed' },
    { ...hevcAdapter, artifactFingerprint: { ...artifactFingerprint, sha256: 'changed' } },
    { ...hevcAdapter, artifactFingerprint: { ...artifactFingerprint, path: path.join(dir, 'missing') } }
  ]) {
    hevc.adapter = invalid; await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
    assert.equal((await page())!.didl.match(/<res /g)?.length, 2);
    assert.equal(JSON.stringify([entry.adapter, sampleA.adapter]), preserved);
  }
  hevc.adapter = hevcAdapter; await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  const hevcServer = createServer((req, res) => { void controller.media(req, res, hevc.objectId.split('/').at(-1)!); });
  hevcServer.listen(0, '127.0.0.1'); await once(hevcServer, 'listening');
  t.after(async () => { hevcServer.closeAllConnections(); await new Promise<void>(resolve => hevcServer.close(() => resolve())); });
  const hevcUrl = `http://127.0.0.1:${(hevcServer.address() as import('node:net').AddressInfo).port}/experimental/media/${hevc.objectId.split('/').at(-1)}`;
  const hevcGet = await fetch(hevcUrl); assert.equal(hevcGet.status, 200); assert.deepEqual(unwrap(Buffer.from(await hevcGet.arrayBuffer())), artifactBytes);
  // Generated outputs remain PC-validated, with a mandatory committed registry gate.
  const registryFile = path.join(dir, 'registry-record.json'), pcProofFile = path.join(dir, 'pc-proof.json');
  const registryRecord = { state: 'verified', verificationStatus: 'pc-validated', validatorVersion: 'prepare-validator-v2',
    sourceFingerprint: hevc.fingerprint, cadencePlanFingerprint: hevcAdapter.cadenceFingerprint,
    transformPlanFingerprint: hevcAdapter.planFingerprint, targetProfile: hevcAdapter.targetProfile, capabilitySnapshotHash: hevcAdapter.sinkHash,
    artifactFingerprint, validationEvidence: { http: { bodyExact: true }, hrd: { violations: 0 }, duplicate: 0, selectionEvidence: { retainedDecodedSourcePixelHashesExact: true } } };
  await fs.writeFile(registryFile, JSON.stringify(registryRecord));
  const pcProof = { ...JSON.parse(await fs.readFile(hevcProofFile, 'utf8')), verificationStatus: 'pc-validated', observationFingerprint: undefined, registryFingerprint: await fileFingerprint(registryFile) };
  await fs.writeFile(pcProofFile, JSON.stringify(pcProof));
  const pcAdapter = { ...hevcAdapter, verificationStatus: 'pc-validated' as const, verificationRecord: await fileFingerprint(pcProofFile) };
  assert.ok(await validateArtifact(pcAdapter)); assert.ok(matchesArtifactDecision(hevc, hevcDecision, pcAdapter));
  hevc.adapter = pcAdapter; await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  assert.equal((await page())!.didl.match(/<res /g)?.length, 3);
  await fs.writeFile(registryFile, JSON.stringify({ ...registryRecord, state: 'failed' }));
  assert.equal(await validateArtifact(pcAdapter), undefined); assert.equal((await page())!.didl.match(/<res /g)?.length, 2);
  assert.ok(await validateArtifact(sampleAAdapter)); assert.ok(await validateArtifact(adapter));
  hevc.adapter = hevcAdapter; await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  await fs.rename(artifactFile, artifactFile + '.saved');
  assert.ok(!(await page())!.didl.includes('<res'));
  assert.deepEqual(await controller.protocolInfos('127.0.0.1'), []);
  assert.equal((await fetch(url)).status, 409);
  assert.equal(await controller.browse({ objectId: 'all', start: 0, count: 0, metadata: false }, '', '', () => { throw Error('normal untouched'); }), undefined);
});
