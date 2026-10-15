import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { syntheticTs } from './ts-fixture.js';
import { Tts192Transform } from '../src/tts.js';
import { fileFingerprint } from '../src/file-fingerprint.js';
import { runShadow, snapshotHash, SHADOW_VERSION } from '../src/playback-shadow.js';
import { initialShadowPolicy } from '../src/shadow-profile-policy.js';
import { prepareDecisionPlan } from '../src/prepare-media.js';
import { cachedPlanFingerprint, cadencePlanFingerprint, validateArtifact } from '../src/verified-artifact.js';
import { prepareArtifact, type ArtifactIdentity } from '../src/artifact-registry.js';
import { publishPreparedResource } from '../src/registry-adapter.js';
import { createExperimentalCatalog, CATALOG_VERSION, experimentalObjectId } from '../src/experimental-catalog.js';

test('explicit registry publication exposes only committed PC-validated output and preserves existing adapter', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-adapter-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const previous = process.env.PT3_EXPERIMENTAL_CATALOG_DIR; process.env.PT3_EXPERIMENTAL_CATALOG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PT3_EXPERIMENTAL_CATALOG_DIR; else process.env.PT3_EXPERIMENTAL_CATALOG_DIR = previous; });
  const sourceFile = path.join(dir, 'source.mp4'); await fs.writeFile(sourceFile, 'unit-test source placeholder, never decoded');
  const fingerprint = await fileFingerprint(sourceFile), deviceId = 'uuid:fixture', sink = 'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T;DLNA.ORG_OP=10';
  const policy = initialShadowPolicy(); policy.profiles = policy.profiles.slice(0, 1); policy.executionCapabilitiesStatus = 'verified';
  policy.capabilities = { encoders: [{ codec: 'h264', available: true }, { codec: 'aac', available: true }], decoders: [{ codec: 'h264', available: true }, { codec: 'aac', available: true }] };
  policy.observations = [{ deviceId, sinkHash: snapshotHash(sink), testedMediaCharacteristics: 'synthetic fixture', observation: { profileId: policy.profiles[0].id, outcome: 'success', framing: 'jp-content-packet', videoCodec: 'h264', videoProfile: 'Main', maxLevel: 40, audioFormat: 'mpeg2-aac-lc', evidence: { status: 'experimentally-confirmed', reference: 'synthetic fixture only', scope: 'unit test' } } }];
  const source = { version: SHADOW_VERSION, fingerprint, analyzedAt: new Date().toISOString(), scanScope: 'synthetic', characteristics: {
    transport: { container: 'mp4', framing: 'file' as const, mime: 'video/mp4', seek: 'byte' as const },
    video: { codec: 'h264', profile: 'High', level: 42, codedWidth: 1920, codedHeight: 1088, bitDepth: 8, chroma: '420', scan: 'progressive', displayTicks: [0, 1502, 3003, 7508], timebase: 90000 },
    audio: { codec: 'aac', format: 'mpeg4-aac-lc', channels: 2, sampleRate: 48000 }, validation: { value: true, evidence: { status: 'experimentally-confirmed' as const, reference: 'unit fixture', scope: 'synthetic' } } } };
  const decision = await runShadow({ fingerprint, remoteIp: '192.168.1.2', method: 'prepare', headers: {}, actualPlaybackPath: 'not applied' }, { source: async () => source,
    capability: async () => ({ deviceId, remoteIp: '192.168.1.2', controlUrl: 'http://192.168.1.2/cm', sink, sinkHash: snapshotHash(sink), acquiredAt: new Date().toISOString(), origin: 'current-read' }),
    policy: async () => policy, record: () => {} });
  const plan = prepareDecisionPlan(decision);
  const identity: ArtifactIdentity = { sourceFingerprint: fingerprint, capabilitySnapshotHash: snapshotHash(sink), decisionFingerprint: 'semantic decision',
    transformPlanFingerprint: cachedPlanFingerprint(plan.selected), cadencePlanFingerprint: cadencePlanFingerprint(plan.cadence), targetProfile: plan.selected.targetProfileId, targetPolicy: {}, encoderCompatibility: {} };
  const registryDirectory = path.join(dir, 'registry');
  const result = await prepareArtifact(registryDirectory, identity, 'software', {
    generate: async d => { const chunks: Buffer[] = []; for await (const b of Readable.from([syntheticTs(1500, 500)]).pipe(new Tts192Transform(0, 752000, 0, 1500 * 192))) chunks.push(Buffer.from(b)); const file = path.join(d, 'media.m2ts'); await fs.writeFile(file, Buffer.concat(chunks)); return file; },
    // Registry integration fixture deliberately mocks validator evidence; real validator has separate E2E verification.
    validate: async () => ({ passed: true, evidence: { decodeSeconds: 3, http: { bodyExact: true }, hrd: { violations: 0 }, duplicate: 0, selectionEvidence: { retainedDecodedSourcePixelHashesExact: true } } })
  });
  const objectId = experimentalObjectId(sourceFile), catalogFile = path.join(dir, 'catalog.json');
  await fs.writeFile(catalogFile, JSON.stringify({ version: CATALOG_VERSION, enabled: true, generatedAt: new Date().toISOString(), entries: [{ objectId, fingerprint, filename: 'source.mp4', sourceState: 'cached', decisions: [] }] }));
  const auditFile = path.join(dir, 'audit.json'); await fs.writeFile(auditFile, '{}');
  const publication = await publishPreparedResource(registryDirectory, result.record, decision, auditFile); assert.equal(publication.published, true);
  const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8')), adapter = catalog.entries[0].adapter;
  assert.equal(adapter.verificationStatus, 'pc-validated'); assert.ok(await validateArtifact(adapter));
  const controller = createExperimentalCatalog(dir, () => {}, () => []);
  const page = await controller.browse({ objectId: 'experimental', metadata: false, start: 0, count: 0 }, '192.168.1.2', 'http://example', () => { throw Error('normal untouched'); });
  assert.ok(page!.didl.includes('<res')); assert.ok(page!.didl.includes('AVC_TS_JP_AAC_T;DLNA.ORG_OP=10'));
  const prior = await fs.readFile(catalogFile);
  assert.equal((await publishPreparedResource(registryDirectory, result.record, decision, auditFile)).published, false);
  assert.deepEqual(await fs.readFile(catalogFile), prior);
  await assert.rejects(publishPreparedResource(registryDirectory, { ...result.record, verificationStatus: 'experimentally-confirmed' }, decision, auditFile));
  const registryFile = path.join(registryDirectory, 'records', result.record.artifactId + '.json'); await fs.rename(registryFile, registryFile + '.missing');
  const stale = await controller.browse({ objectId: 'experimental', metadata: false, start: 0, count: 0 }, '192.168.1.2', 'http://example', () => { throw Error('normal untouched'); });
  assert.ok(!stale!.didl.includes('<res'));
});
