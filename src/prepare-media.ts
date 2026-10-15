import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { acquireCapability, readShadowJson, saveShadowJson, sourceFromProbe, shadowDirectory, type RegisteredDmp } from './playback-shadow-store.js';
import { runShadow, snapshotHash, matchingFingerprint, type ShadowRecord } from './playback-shadow.js';
import { cachedExperimentalDecision, experimentalCatalogDirectory, type ExperimentalCatalog } from './experimental-catalog.js';
import { cachedPlanFingerprint, cadencePlanFingerprint, type ArtifactVerification } from './verified-artifact.js';
import { planCadenceNormalization } from './cadence-plan.js';
import { detectCapabilities, type BackendPreference } from './transcode-capabilities.js';
import { prepareBackend, ENCODE_RECIPE, execute, ffprobe, commandOptions, generatePreparedArtifact, type EncodeInput } from './prepare-executor.js';
import { validatePreparedArtifact } from './prepare-validator.js';
import { prepareArtifact, type ArtifactIdentity } from './artifact-registry.js';
import { DiagnosticLog } from './diagnostic-log.js';
import { publishPreparedResource } from './registry-adapter.js';

export function prepareDecisionPlan(record: ShadowRecord) {
  const cached = cachedExperimentalDecision(record), selected = cached?.selected ?? cached?.artifactCandidate;
  assert.ok(record.decisionStatus === 'complete' && selected, 'Decision incomplete/unsupported');
  assert.ok(record.unknowns.every(u => /^source (dpbFrames|bitrate|cpbBits) unknown; output audit required$/.test(u) || u === 'named DLNA profile full conformance unconfirmed'), `Unresolved decision unknown: ${record.unknowns.join('; ')}`);
  const target = record.policySnapshot?.profiles.find(p => p.id === selected.targetProfileId); assert.ok(target);
  const video = target.video.value, audio = target.audio.value, transport = target.transport.value;
  assert.ok(video.codec === 'h264' && video.profile === 'Main' && video.level === 40 && video.codedWidth === 1920 && video.codedHeight === 1088 && video.timing, 'Target not implemented by certified executor');
  assert.ok(video.bitDepth === 8 && video.chroma === '420' && video.scan === 'progressive' && video.maxDpbFrames! >= 1 && video.maxBitrate! >= ENCODE_RECIPE.vbvRate && video.maxCpbBits! >= ENCODE_RECIPE.vbvSize);
  assert.ok(video.timing.constraint.timebase === 90000 && video.timing.constraint.codedWidth === 1920 && video.timing.constraint.codedHeight === 1088);
  assert.ok(audio.codec === 'aac' && audio.format === 'mpeg2-aac-lc' && transport.profileName === 'AVC_TS_JP_AAC_T' && transport.container === 'mpegts' && transport.mime === 'video/vnd.dlna.mpeg-tts' && transport.framing === 'jp-content-packet' && transport.seek === 'time');
  assert.ok(audio.maxChannels! >= 2 && audio.sampleRates?.includes(48000));
  assert.ok(['video-transcode', 'full-transcode'].includes(selected.strategy), 'This first executor only implements H.264 video re-encode plus target AAC normalization');
  // Audio normalization must be a decision transform, rather than a silent executor change.
  assert.ok(Array.isArray(selected.transforms) && selected.transforms.some((t: any) => t.kind === 'audio-format-normalization'), 'Audio copy executor not yet implemented');
  const cadence = planCadenceNormalization(record.sourceSnapshot!.characteristics.video.displayTicks!, video.timing);
  assert.equal(selected.cadenceRequired, cadence.required);
  if (cadence.required) assert.equal(selected.cadenceFingerprint, cadencePlanFingerprint(cadence));
  return { selected, target, cadence };
}
export async function prepareMedia(options: { source: string; targetRecord: string; referenceRecord?: string; seconds: number; backend: BackendPreference; allowObservedProfile: boolean; publish?: boolean; planOnly?: boolean }) {
  assert.ok(options.allowObservedProfile, 'Explicit --allow-observed-profile required: full JP normative conformity remains unknown');
  assert.ok(options.seconds >= 120 && options.seconds <= 150.1, 'Initial executor supports a bounded 120..150s sample only');
  const data = path.resolve(process.env.PT3_DATA_DIR || 'data'), directory = path.join(data, 'artifact-registry');
  const file = path.resolve(options.source), before = await fs.stat(file), fingerprint = { path: file, size: before.size, mtimeMs: before.mtimeMs };
  new DiagnosticLog(directory).assertSeparate([path.dirname(file)]);
  const targetRecord = await readShadowJson<ArtifactVerification>(path.resolve(options.targetRecord)); assert.ok(targetRecord?.policy);
  const registered = await readShadowJson<RegisteredDmp[]>(path.join(shadowDirectory(), 'devices.json'));
  const device = registered?.find(d => d.remoteIp === targetRecord.capabilitySnapshot.remoteIp && (!d.deviceId || d.deviceId === targetRecord.capabilitySnapshot.deviceId)); assert.ok(device, 'Target DMP not registered');
  const capability = await acquireCapability(device, AbortSignal.timeout(10000));
  assert.equal(capability.sinkHash, targetRecord.capabilitySnapshot.sinkHash, 'Advertised capability changed; update observed target policy first');
  const probe = JSON.parse((await execute(ffprobe(), ['-v', 'error', '-read_intervals', `%+${options.seconds + 1}`, '-show_frames', '-show_streams', '-show_format', '-of', 'json', file], commandOptions)).stdout);
  const vs = probe.streams.find((s: any) => s.codec_type === 'video'), as = probe.streams.find((s: any) => s.codec_type === 'audio');
  assert.ok(vs && as && ['h264', 'hevc'].includes(vs.codec_name) && ['aac', 'pcm_s16be', 'pcm_s16le'].includes(as.codec_name), 'Source codecs not supported by initial executor');
  assert.ok(Number(as.sample_rate) === 48000 && as.channels === 2, 'Initial audio timeline reconstruction requires 48kHz stereo');
  const [num, den] = vs.time_base.split('/').map(Number); assert.ok(num > 0 && den > 0);
  const frames = probe.frames.filter((f: any) => f.media_type === 'video');
  assert.ok(frames.length && frames.every((f: any) => f.interlaced_frame === 0), 'Initial source policy requires decoded progressive frames');
  let ticks: number[] = frames.map((f: any) => { const pts = f.best_effort_timestamp ?? f.pts; assert.ok(Number.isSafeInteger(pts)); return Math.round(pts * num * 90000 / den); });
  ticks = ticks.filter(t => t < options.seconds * 90000);
  let reference: ArtifactVerification | undefined;
  if (options.referenceRecord) {
    reference = await readShadowJson<ArtifactVerification>(path.resolve(options.referenceRecord)); assert.ok(reference && matchingFingerprint(reference.sourceFingerprint, fingerprint));
    const previous = reference.sourceSnapshot.characteristics.video.displayTicks!;
    ticks = ticks.filter(t => t >= previous[0] && t <= previous.at(-1)!); assert.deepEqual(ticks, previous, 'Source display timeline no longer matches bounded reference');
  }
  assert.ok(ticks.length > 1 && ticks.every((t, i) => Number.isSafeInteger(t) && (!i || t > ticks[i - 1])));
  // First version avoids a generalized discontinuous-audio restamper. Fail closed on gaps.
  const af = probe.frames.filter((f: any) => f.media_type === 'audio' && Number(f.best_effort_timestamp_time ?? f.pts_time) < options.seconds);
  assert.ok(af.length);
  for (let i = 1; i < af.length; i++) {
    const delta = Number(af[i].best_effort_timestamp_time ?? af[i].pts_time) - Number(af[i - 1].best_effort_timestamp_time ?? af[i - 1].pts_time);
    assert.ok(Math.abs(delta - af[i - 1].nb_samples / 48000) <= .002, 'Source audio has a gap; timestamp-preserving executor unavailable');
  }
  const source = sourceFromProbe(file, before, probe); source.characteristics.video.displayTicks = ticks; source.characteristics.video.scan = 'progressive';
  source.scanScope = `${ticks[0]}..${ticks.at(-1)} /90000; explicit first bounded sample, not full duration`;
  source.characteristics.validation = { value: true, evidence: { status: 'experimentally-confirmed', reference: 'explicit ffprobe decoded source timeline', scope: `PC source metadata/display-order inspection only; no television or full syntax conformity claim. ${source.scanScope}` } };
  const capabilities = await detectCapabilities(), backend = prepareBackend(capabilities, options.backend);
  const policy = structuredClone(targetRecord.policy); policy.profiles = policy.profiles.filter(p => p.id === targetRecord.targetProfile);
  policy.capabilities = { encoders: [{ codec: 'h264', available: true }, { codec: 'aac', available: true }], decoders: [{ codec: vs.codec_name, available: true }, { codec: as.codec_name, available: true }] }; policy.executionCapabilitiesStatus = 'verified';
  const record = await runShadow({ fingerprint, remoteIp: capability.remoteIp, method: 'explicit-prepare', headers: {}, actualPlaybackPath: 'no-playback; opt-in offline prepare' },
    { source: async () => source, capability: async () => capability, policy: async () => policy, record: async () => {} });
  const { selected, target, cadence } = prepareDecisionPlan(record);
  if (reference) {
    const old = await runShadow({ fingerprint, remoteIp: capability.remoteIp, method: 'reference-comparison', headers: {}, actualPlaybackPath: 'not-applied' },
      { source: async () => reference!.sourceSnapshot, capability: async () => reference!.capabilitySnapshot, policy: async () => reference!.policy, record: async () => {} });
    const prior = prepareDecisionPlan(old);
    assert.deepEqual(selected.transforms, prior.selected.transforms); assert.equal(selected.strategy, prior.selected.strategy);
    assert.equal(cadencePlanFingerprint(cadence), cadencePlanFingerprint(prior.cadence));
  }
  const planFingerprint = cachedPlanFingerprint(selected);
  const input: EncodeInput = { source: file, seconds: options.seconds, sourceAudioStart: Number(af[0].best_effort_timestamp_time ?? af[0].pts_time), sourceFrames: ticks.length, cadence };
  // Reusable semantic execution decision; current device UUID/acquisition time/evidence annotations are audit context, not identity.
  const semanticDecisionFingerprint = snapshotHash(JSON.stringify({ plannerVersion: record.plannerVersion, source: source.characteristics, strategy: selected.strategy, transforms: selected.transforms, targetProfile: selected.targetProfileId }));
  const identity: ArtifactIdentity = { sourceFingerprint: fingerprint, capabilitySnapshotHash: capability.sinkHash, decisionFingerprint: semanticDecisionFingerprint,
    transformPlanFingerprint: planFingerprint, cadencePlanFingerprint: cadencePlanFingerprint(cadence), targetProfile: selected.targetProfileId,
    targetPolicy: { transport: target.transport.value, video: target.video.value, audio: target.audio.value },
    encoderCompatibility: { ...ENCODE_RECIPE, sampleSeconds: input.seconds, sourceAudioStart: input.sourceAudioStart, ffmpegBuild: capabilities.version } };
  if (options.planOnly) return { planOnly: true, strategy: selected.strategy, transforms: selected.transforms, sourceFrames: ticks.length, retained: cadence.retained.length,
    dropped: cadence.dropped.length, duplicate: 0, normalizationRequired: cadence.required, referenceMatched: !!reference, backend, noGeneration: true };
  const result = await prepareArtifact(directory, identity, backend.backend, {
    generate: d => generatePreparedArtifact(input, d), validate: (f, d) => validatePreparedArtifact(f, input, d)
  });
  const audit = { decision: record, input, selected, backend, capabilities, referenceMatched: !!reference, artifactId: result.record.artifactId,
    registration: result, experimentalPublication: 'registry-verified; existing resource bindings preserved; shadow comparison only',
    noTvCommands: true, fullProfileConformance: 'unknown', startupLoss: 'separate issue' };
  const auditFile = path.join(directory, 'audit', result.record.artifactId + '.json');
  // Immutable per invocation: a cache-hit audit must not invalidate an already published proof.
  const invocationAuditFile = path.join(directory, 'audit', result.record.artifactId + '-' + record.decisionId + '.json');
  await saveShadowJson(invocationAuditFile, audit); await saveShadowJson(auditFile, audit);
  // Explicit offline registry-to-existing-adapter comparison. No catalogue mutation or server restart.
  const catalog = await readShadowJson<ExperimentalCatalog>(path.join(experimentalCatalogDirectory(), 'catalog.json'));
  const entry = catalog?.entries.find(e => matchingFingerprint(e.fingerprint, fingerprint));
  const shadow = { objectId: entry?.objectId, existingResourcePreserved: !!entry?.adapter, registryVerified: true,
    cadenceMatch: !entry?.adapter?.cadenceFingerprint || entry.adapter.cadenceFingerprint === identity.cadencePlanFingerprint,
    transformsMatch: entry?.adapter?.planFingerprint === identity.transformPlanFingerprint,
    artifactDifferentRevision: entry?.adapter?.artifactFingerprint.sha256 !== result.record.artifactFingerprint.sha256,
    publicationStatus: 'shadow-only; current successful binding not replaced' };
  await saveShadowJson(path.join(directory, 'shadow', result.record.artifactId + '.json'), shadow);
  const publication = options.publish ? await publishPreparedResource(directory, result.record, record, invocationAuditFile) : { published: false, reason: 'explicit --publish not requested; registry shadow only' };
  return { artifactId: result.record.artifactId, cacheHit: result.cacheHit, revalidated: result.revalidated, selectedStrategy: selected.strategy, transforms: selected.transforms,
    sourceFrames: ticks.length, retained: cadence.retained.length, dropped: cadence.dropped.length, duplicate: 0, backend,
    artifactPath: result.record.artifactPath, validation: 'passed', verificationStatus: result.record.verificationStatus, publication, shadow };
}
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('prepare-media.ts')) {
  const args = process.argv.slice(2), value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const source = value('--source'), targetRecord = value('--target-record'); assert.ok(source && targetRecord, 'Use --source FILE --target-record VERIFIED_POLICY_JSON --allow-observed-profile [--reference-record JSON] [--seconds 150] [--backend software]');
  const backend = value('--backend') ?? 'software'; assert.ok(['auto', 'software', 'nvenc', 'amf', 'qsv'].includes(backend));
  console.log(JSON.stringify(await prepareMedia({ source, targetRecord, referenceRecord: value('--reference-record'), seconds: Number(value('--seconds') ?? 150), backend: backend as BackendPreference, allowObservedProfile: args.includes('--allow-observed-profile'), publish: args.includes('--publish'), planOnly: args.includes('--plan-only') }), null, 2));
}
