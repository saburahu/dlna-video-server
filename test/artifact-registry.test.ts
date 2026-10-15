import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactKey, prepareArtifact, type ArtifactIdentity } from '../src/artifact-registry.js';
import { prepareBackend, plannedVideoArguments } from '../src/prepare-executor.js';
import { encoders, type Capabilities } from '../src/transcode-capabilities.js';
import { planCadenceNormalization } from '../src/cadence-plan.js';
import { initialShadowPolicy } from '../src/shadow-profile-policy.js';
import { prepareDecisionPlan } from '../src/prepare-media.js';
import { runShadow, snapshotHash, SHADOW_VERSION } from '../src/playback-shadow.js';
import { cachedExperimentalDecision } from '../src/experimental-catalog.js';
import { verifySelectedPixels } from '../src/prepare-validator.js';

async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-registry-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.mp4'); await fs.writeFile(source, 'original'); const s = await fs.stat(source);
  const identity: ArtifactIdentity = { sourceFingerprint: { path: source, size: s.size, mtimeMs: s.mtimeMs }, capabilitySnapshotHash: 'sink', decisionFingerprint: 'semantic-decision', transformPlanFingerprint: 'transforms', cadencePlanFingerprint: 'cadence', targetProfile: 'target', targetPolicy: { level: 40 }, encoderCompatibility: { version: 1 } };
  let generations = 0, validations = 0;
  const jobs = { generate: async (d: string) => { generations++; const f = path.join(d, 'artifact.m2ts'); await fs.writeFile(f, 'new completed artifact'); return f; }, validate: async () => { validations++; return { passed: true as const, evidence: { realValidatorMock: true } }; } };
  return { directory: path.join(directory, 'registry'), identity, jobs, counts: () => ({ generations, validations }), source };
}
test('registry atomic publication, cache hit and validator-version revalidation without regenerate', async t => {
  const f = await fixture(t), first = await prepareArtifact(f.directory, f.identity, 'software', f.jobs);
  assert.equal(first.cacheHit, false); assert.equal(first.record.verificationStatus, 'pc-validated');
  assert.ok(!first.record.artifactPath.includes(path.join('registry', 'work')));
  const hit = await prepareArtifact(f.directory, f.identity, 'software', f.jobs); assert.equal(hit.cacheHit, true); assert.deepEqual(f.counts(), { generations: 1, validations: 1 });
  const newer = await prepareArtifact(f.directory, f.identity, 'software', f.jobs, 'v2'); assert.equal(newer.revalidated, true); assert.deepEqual(f.counts(), { generations: 1, validations: 2 });
  assert.equal(await fs.readFile(f.source, 'utf8'), 'original');
});
test('registry hash mismatch/missing stale artifacts generate distinct revisions; keep older files', async t => {
  const f = await fixture(t), first = await prepareArtifact(f.directory, f.identity, 'software', f.jobs);
  const old = first.record.artifactFingerprint; await fs.writeFile(old.path, 'different completed art'); await fs.utimes(old.path, old.mtimeMs / 1000, old.mtimeMs / 1000);
  const second = await prepareArtifact(f.directory, f.identity, 'software', f.jobs); assert.equal(second.cacheHit, false); assert.notEqual(second.record.artifactPath, old.path); assert.ok(await fs.stat(old.path));
  await fs.rename(second.record.artifactPath, second.record.artifactPath + '.missing');
  const third = await prepareArtifact(f.directory, f.identity, 'software', f.jobs); assert.equal(third.cacheHit, false); assert.equal(f.counts().generations, 3);
});
test('validator/generation failure never replaces an existing verified registry record', async t => {
  const f = await fixture(t), prior = await prepareArtifact(f.directory, f.identity, 'software', f.jobs);
  const filename = path.join(f.directory, 'records', prior.record.artifactId + '.json'), saved = await fs.readFile(filename);
  await assert.rejects(prepareArtifact(f.directory, f.identity, 'software', { ...f.jobs, validate: async () => { throw Error('HRD failed'); } }, 'new-version'), /HRD failed/);
  assert.deepEqual(await fs.readFile(filename), saved);
  const changed = { ...f.identity, targetProfile: 'different' };
  await assert.rejects(prepareArtifact(f.directory, changed, 'software', { ...f.jobs, generate: async () => { throw Error('encoding failed'); } }), /encoding failed/);
  await assert.rejects(fs.stat(path.join(f.directory, 'records', artifactKey(changed) + '.json')));
});
test('same artifact concurrent prepares excluded; source mutation and escaped generator blocked', async t => {
  const f = await fixture(t); let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => entered = r), hold = new Promise<void>(r => release = r);
  const first = prepareArtifact(f.directory, f.identity, 'software', { ...f.jobs, generate: async d => { entered(); await hold; return f.jobs.generate(d); } }); await ready;
  await assert.rejects(prepareArtifact(f.directory, f.identity, 'software', f.jobs), /already preparing/); release(); await first;
  await fs.appendFile(f.source, 'mutation'); await assert.rejects(prepareArtifact(f.directory, f.identity, 'software', f.jobs), /Source fingerprint changed/);
  const s = await fs.stat(f.source), id = { ...f.identity, sourceFingerprint: { ...f.identity.sourceFingerprint, size: s.size, mtimeMs: s.mtimeMs } };
  await assert.rejects(prepareArtifact(f.directory, id, 'software', { ...f.jobs, generate: async () => f.source }), /escaped/);
});
test('artifact identity includes source, cadence, target, plan and encoder conditions', async t => {
  const f = await fixture(t), key = artifactKey(f.identity);
  for (const changed of [{ ...f.identity, cadencePlanFingerprint: 'changed' }, { ...f.identity, targetPolicy: { level: 42 } }, { ...f.identity, decisionFingerprint: 'new' }, { ...f.identity, encoderCompatibility: { version: 2 } }, { ...f.identity, encoderCompatibility: { version: 1, sampleSeconds: 150.05 } }, { ...f.identity, capabilitySnapshotHash: 'new-sink' }]) assert.notEqual(artifactKey(changed), key);
});

test('disk full/interruption failures stay unverified and preserve earlier verified bytes',async t=>{const f=await fixture(t),previous=await prepareArtifact(f.directory,f.identity,'software',f.jobs),bytes=await fs.readFile(previous.record.artifactPath);for(const reason of ['ENOSPC disk full','Prepare interrupted']){const identity={...f.identity,encoderCompatibility:{scope:'full-duration',case:reason}};await assert.rejects(prepareArtifact(f.directory,identity,'software',{...f.jobs,generate:async()=>{throw Error(reason);}}),new RegExp(reason));await assert.rejects(fs.stat(path.join(f.directory,'records',artifactKey(identity)+'.json')));assert.deepEqual(await fs.readFile(previous.record.artifactPath),bytes);}});
test('a corrupted registry identity cannot reuse an otherwise intact artifact', async t => {
  const f = await fixture(t), prior = await prepareArtifact(f.directory, f.identity, 'software', f.jobs);
  await fs.writeFile(path.join(f.directory, 'records', prior.record.artifactId + '.json'), JSON.stringify({ ...prior.record, targetProfile: 'wrong-profile' }));
  const next = await prepareArtifact(f.directory, f.identity, 'software', f.jobs);
  assert.equal(next.cacheHit, false); assert.equal(next.record.targetProfile, f.identity.targetProfile); assert.equal(f.counts().generations, 2);
  assert.ok(await fs.stat(prior.record.artifactPath));
});
test('initialized hardware falls back for uncertified exact VFR/HRD contract, independent of decision', () => {
  const capabilities: Capabilities = { version: 'test', candidates: Object.fromEntries(Object.entries(encoders).map(([b, encoder]) => [b, { encoder, available: true, present: true }])) as Capabilities['candidates'] };
  for (const requested of ['auto', 'nvenc', 'amf', 'qsv', 'software'] as const) assert.equal(prepareBackend(capabilities, requested).backend, 'software');
  capabilities.candidates.software.available = false; assert.throws(() => prepareBackend(capabilities, 'nvenc'), /certified/);
});
test('validator rejects a substituted/duplicated source frame even if display PTS were restamped correctly', () => {
  verifySelectedPixels(['A', 'B', 'C', 'D'], ['A', 'C', 'D'], [0, 2, 3]);
  assert.throws(() => verifySelectedPixels(['A', 'B', 'C', 'D'], ['A', 'B', 'D'], [0, 2, 3]), /pixels differ/);
  assert.throws(() => verifySelectedPixels(['A', 'B', 'C', 'D'], ['A', 'C', 'C'], [0, 2, 3]), /pixels differ/);
});
test('prepare three source classes retains pure decision/transform plan; no CFR filter', async () => {
  const policy = initialShadowPolicy(); policy.profiles = policy.profiles.slice(0, 1); const profile = policy.profiles[0];
  const sink = 'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T;DLNA.ORG_OP=10', deviceId = 'uuid:fixture';
  policy.observations = [{ deviceId, sinkHash: snapshotHash(sink), testedMediaCharacteristics: 'synthetic fixture', observation: { profileId: profile.id, outcome: 'success', framing: 'jp-content-packet', videoCodec: 'h264', videoProfile: 'Main', maxLevel: 40, audioFormat: 'mpeg2-aac-lc', evidence: { status: 'experimentally-confirmed', reference: 'fixture', scope: 'bounded experimental output' } } }];
  policy.executionCapabilitiesStatus = 'verified'; policy.capabilities = { encoders: [{ codec: 'h264', available: true }, { codec: 'aac', available: true }], decoders: ['hevc', 'h264', 'aac', 'pcm'].map(codec => ({ codec, available: true })) };
  for (const [name, codec, level, width, audioCodec, ticks, required] of [
    ['SampleA', 'h264', 42, 1920, 'aac', [0, 1502, 3003, 7508], true],
    ['SampleB', 'h264', 51, 3840, 'pcm', [0, 3003, 6006], false],
    ['HEVC', 'hevc', 123, 1920, 'aac', [0, 1440, 2970, 5940, 9000], true]
  ] as const) {
    const fingerprint = { path: '/fixture/' + name, size: 1, mtimeMs: 1 };
    const source = { version: SHADOW_VERSION, fingerprint, analyzedAt: 'now', scanScope: 'synthetic', characteristics: {
      transport: { container: codec === 'hevc' ? 'matroska' : 'mp4', framing: 'file' as const, mime: 'video/mp4', seek: 'byte' as const },
      video: { codec, profile: codec === 'h264' ? 'High' : 'Main', level, codedWidth: width, codedHeight: width === 3840 ? 2160 : 1088, bitDepth: 8, chroma: '420', scan: 'progressive', timebase: 90000, displayTicks: [...ticks] },
      audio: { codec: audioCodec, format: audioCodec, channels: 2, sampleRate: 48000 }, validation: { value: true, evidence: { status: 'experimentally-confirmed' as const, reference: 'fixture', scope: 'bounded' } } } };
    const record = await runShadow({ fingerprint, remoteIp: '192.168.1.2', method: 'prepare', headers: {}, actualPlaybackPath: 'not applied' }, { source: async () => source, capability: async () => ({ deviceId, remoteIp: '192.168.1.2', controlUrl: 'http://192.168.1.2/cm', sink, sinkHash: snapshotHash(sink), acquiredAt: 'now', origin: 'current-read' }), policy: async () => policy, record: () => {} });
    const cached = cachedExperimentalDecision(record), before = structuredClone(record), result = prepareDecisionPlan(record);
    assert.equal(result.selected.strategy, 'full-transcode'); assert.equal(result.cadence.required, required); assert.deepEqual(result.selected, cached!.selected ?? cached!.artifactCandidate); assert.deepEqual(record, before);
    const args = plannedVideoArguments({ source: fingerprint.path, seconds: 150, sourceAudioStart: 0, sourceFrames: ticks.length, cadence: result.cadence }, '/output.ts');
    assert.ok(!args[args.indexOf('-vf') + 1].includes('fps=')); assert.equal(args[args.indexOf('-frames:v') + 1], String(result.cadence.retained.length));
    const incomplete = structuredClone(record); incomplete.unknowns.push('unknown decoder limit'); assert.throws(() => prepareDecisionPlan(incomplete), /Unresolved/);
  }
});
