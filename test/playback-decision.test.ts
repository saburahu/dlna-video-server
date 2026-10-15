import { test } from 'node:test';
import {planJitExecution} from '../src/jit-execution-plan.js';
import assert from 'node:assert/strict';
import { decidePlayback, parseSinkProtocolInfo, cadenceQualityWarnings, type MediaCharacteristics, type MediaProfileDefinition, type CompatibilityObservation } from '../src/playback-decision.js';
import { runShadow, SHADOW_VERSION, snapshotHash } from '../src/playback-shadow.js';
import { cachedExperimentalDecision, browseExperimental, experimentalObjectId, CATALOG_VERSION } from '../src/experimental-catalog.js';
const experiment = { status: 'experimentally-confirmed' as const, reference: 'local trial records', scope: 'bounded ~150s output recipe; not whole profile certification' };
const normative = { status: 'normative-confirmed' as const, reference: 'local H264 level audit', scope: 'audited constraint only' };
const jp: MediaProfileDefinition = {
  id: 'legacy-jp-observed', transport: { value: { container: 'mpegts', framing: 'jp-content-packet', mime: 'video/vnd.dlna.mpeg-tts', profileName: 'AVC_TS_JP_AAC_T', seek: 'time' }, evidence: experiment },
  video: { evidence: experiment, value: { codec: 'h264', profile: 'Main', level: 40, codedWidth: 1920, codedHeight: 1088, bitDepth: 8, chroma: '420', scan: 'progressive', maxDpbFrames: 4, maxBitrate: 20e6, maxCpbBits: 25e6,
    timing: { id: 'legacy-main40', mediaProfile: 'AVC_TS_JP_AAC_T', evidence: 'compatibility-experiment', maxFrameMacroblocks: 8192,
      constraint: { codedWidth: 1920, codedHeight: 1088, maxMBPS: 245760, minimumFrameSeconds: 1 / 172, timebase: 90000 } } } },
  audio: { evidence: experiment, value: { codec: 'aac', format: 'mpeg2-aac-lc', maxChannels: 2, sampleRates: [48000], allowAbsent: true } },
  conformance: { status: 'unknown', reference: 'JP profile investigation', scope: 'complete normative profile unavailable' }
};
const observations: CompatibilityObservation[] = [{ profileId: jp.id, framing: 'jp-content-packet', outcome: 'success', videoCodec: 'h264', videoProfile: 'Main', maxLevel: 40, audioFormat: 'mpeg2-aac-lc', evidence: experiment }];
const capabilities = { encoders: [{ codec: 'h264', available: true }, { codec: 'aac', available: true }], decoders: ['h264', 'hevc', 'pcm', 'aac', 'mpeg2video'].map(codec => ({ codec, available: true })) };
const sink = 'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T;DLNA.ORG_OP=10';
test('fingerprinted full cadence summary preserves decision transforms; mismatch is blocked',()=>{
 const input=source({profile:'High',level:42,displayTicks:[0,1502,3003],timebase:90000});
 const original=decidePlayback({source:input,sinkProtocolInfo:sink,profiles:[jp],observations,capabilities});
 const compact=structuredClone(input);delete compact.video.displayTicks;compact.video.cachedCadence={policy:jp.video.value.timing,sourceFrames:3,retained:2,dropped:1,required:true,minimumTicks:2989,selectionFingerprint:'a'.repeat(64),scope:'full-duration'};
 const full=decidePlayback({source:compact,sinkProtocolInfo:sink,profiles:[jp],observations,capabilities});assert.deepEqual(full.candidates[0].transforms,original.candidates[0].transforms);assert.equal(full.candidates[0].strategy,original.candidates[0].strategy);
 compact.video.cachedCadence.minimumTicks=1;const wrong=decidePlayback({source:compact,sinkProtocolInfo:sink,profiles:[jp],observations,capabilities});assert.equal(wrong.candidates[0].verification,'blocked');
});
const source = (changes: Partial<MediaCharacteristics['video']> = {}, audio = { codec: 'aac', format: 'mpeg4-aac-lc', channels: 2, sampleRate: 48000 }): MediaCharacteristics => ({
  transport: { container: 'mp4', framing: 'file', mime: 'video/mp4', seek: 'byte' }, validation: { value: true, evidence: normative },
  video: { codec: 'h264', profile: 'High', level: 42, codedWidth: 1920, codedHeight: 1088, bitDepth: 8, chroma: '420', scan: 'progressive', dpbFrames: 4, bitrate: 10e6, cpbBits: 10e6, displayTicks: [0, 1502, 3003, 7508], timebase: 90000, ...changes }, audio
});
const decide = (s: MediaCharacteristics, profiles = [jp], caps = capabilities) => decidePlayback({ source: s, sinkProtocolInfo: sink, profiles, observations, capabilities: caps });

test('JIT recipe executes decision transforms for different source codecs, geometry and cadence without title rules',()=>{
  const cases=[source(),source({codedWidth:3840,codedHeight:2160,level:51,displayTicks:[0,3003,6006]},{codec:'pcm_s16be',format:'pcm_s16be',channels:2,sampleRate:48000}),source({codec:'hevc',profile:'Main',level:123})];
  for(const media of cases){
    const decision=decide(media,[jp],{...capabilities,decoders:[...capabilities.decoders,{codec:'pcm_s16be',available:true}]});
    const plan=planJitExecution(media,decision.candidates[0]);
    assert.equal(plan.strategy,'full-transcode');assert.equal(plan.video.level,40);
    assert.equal(plan.cadence,media.video.codedWidth===3840?'not-required':'required');
    assert.equal(plan.resize,media.video.codedWidth===3840);assert.equal(plan.sourceVideoCodec,media.video.codec);
    assert.deepEqual(plan.transforms,decision.candidates[0].transforms);
  }
});
test('JIT recipe rejects unsupported source/target and undeclared transforms instead of using a common fallback',()=>{
  const media=source(),candidate=decide(media).candidates[0];
  const unsupported=structuredClone(media);unsupported.video.codec='av1';assert.throws(()=>planJitExecution(unsupported,candidate),/decoder/);
  const audio=structuredClone(media);audio.audio!.sampleRate=88200;assert.throws(()=>planJitExecution(audio,candidate),/source audio/);
  const wrong=structuredClone(candidate);wrong.target.video.value.level=42;assert.throws(()=>planJitExecution(media,wrong),/Target/);
  const missing=structuredClone(candidate);missing.transforms=missing.transforms.filter(t=>t.kind!=='audio-format-normalization');assert.throws(()=>planJitExecution(media,missing),/outside decision/);
});

test('media fixtures: SampleA/SampleB/HEVC/Kindertv separate codec, audio and cadence reasons', async () => {
  // Small synthetic timelines model the observed cadence classes, not full recording fixtures.
  const sampleA = decide(source()).selected!;
  assert.equal(sampleA.strategy, 'full-transcode');
  assert.ok(sampleA.transforms.some(x => x.kind === 'cadence-normalization'));
  assert.ok(sampleA.transforms.some(x => x.kind === 'profile-level-normalization'));
  assert.equal(sampleA.target.transport.value.framing, 'jp-content-packet');
  const sampleB = decide(source({ codedWidth: 3840, codedHeight: 2160, level: 51, displayTicks: [0, 3003, 6006] }, { codec: 'pcm', format: 'pcm', channels: 2, sampleRate: 48000 })).selected!;
  assert.equal(sampleB.strategy, 'full-transcode'); assert.equal(sampleB.cadence!.required, false);
  assert.ok(sampleB.transforms.some(x => x.kind === 'resize'));
  const hevc = decide(source({ codec: 'hevc', profile: 'Main', level: 123, displayTicks: [0, 1440, 2970, 5940, 9000] })).selected!;
  assert.equal(hevc.strategy, 'full-transcode'); assert.ok(hevc.cadence!.required);
  assert.equal(hevc.target.video.value.level, 40);
  const kinder = source({ codec: 'mpeg2video', profile: 'Main', level: 8, displayTicks: [0, 3600, 7200] }); delete kinder.audio;
  const k = decide(kinder).selected!; assert.equal(k.strategy, 'video-transcode'); assert.equal(k.cadence!.required, false);
  assert.ok(k.transforms.some(x => x.kind === 'video-codec'));
  for (const media of [source(), source({ codedWidth: 3840, codedHeight: 2160, level: 51, displayTicks: [0, 3003, 6006] }, { codec: 'pcm', format: 'pcm', channels: 2, sampleRate: 48000 }), source({ codec: 'hevc', profile: 'Main', level: 123, displayTicks: [0, 1440, 2970, 5940, 9000] }), kinder]) {
    const direct = decide(media), fingerprint = { path: '/fixture', size: 1, mtimeMs: 1 }, deviceId = 'uuid:fixture';
    const record = await runShadow({ fingerprint, remoteIp: '192.168.1.2', method: 'GET', headers: {}, actualPlaybackPath: 'legacy' }, {
      source: async () => ({ version: SHADOW_VERSION, fingerprint, characteristics: media, scanScope: 'fixture', analyzedAt: '2026-10-08T00:00:00Z' }),
      capability: async () => ({ deviceId, remoteIp: '192.168.1.2', sink, sinkHash: snapshotHash(sink), acquiredAt: '2026-10-08T00:00:00Z', controlUrl: 'http://192.168.1.2/cm', origin: 'current-read' }),
      policy: async () => ({ version: 'fixture-policy', profiles: [jp], capabilities, observations: observations.map(observation => ({ deviceId, sinkHash: snapshotHash(sink), observation, testedMediaCharacteristics: 'fixture' })) }), record: () => {}
    });
    assert.deepEqual(record.shadowDecision, direct); assert.equal(record.applied, false);
    const cached = cachedExperimentalDecision(record)!;
    assert.equal(cached.selected?.strategy, direct.selected?.strategy);
    assert.equal(cached.selected?.cadenceRequired, direct.selected?.cadence?.required);
    const filename = media.video.codec === 'hevc' ? 'サンプル映像C.mkv' : media.video.codedWidth === 3840 ? 'SampleB.MP4' : 'SampleA.mp4';
    const page = browseExperimental({ version: CATALOG_VERSION, enabled: true, generatedAt: record.timestamp, entries: [{ objectId: experimentalObjectId(fingerprint.path), filename, fingerprint, sourceState: 'cached', decisions: [cached] }] },
      { objectId: 'experimental', metadata: false, start: 0, count: 0 }, '192.168.1.2', 'http://server', () => { throw Error('not root'); }, Date.parse(cached.acquiredAt));
    assert.ok(page!.didl.includes(filename)); assert.ok(!page!.didl.includes('<res'));
  }
});
test('five modes and minimal transforms; absent audio stays absent', () => {
  const s = source({ profile: 'Main', level: 40, displayTicks: [0, 3003, 6006], removalTicks: [0, 3003, 6006] }, { codec: 'aac', format: 'mpeg2-aac-lc', channels: 2, sampleRate: 48000 });
  s.transport = { ...jp.transport.value };
  assert.equal(decide(s).selected!.strategy, 'direct');
  const remux = { ...s, transport: { ...s.transport, container: 'matroska', framing: 'file' as const } };
  assert.equal(decide(remux).selected!.strategy, 'remux');
  assert.equal(decide({ ...s, audio: { ...s.audio!, format: 'mpeg4-aac-lc' } }).selected!.strategy, 'audio-transcode');
  assert.equal(decide({ ...s, video: { ...s.video, codec: 'hevc' } }).selected!.strategy, 'video-transcode');
  assert.equal(decide({ ...s, video: { ...s.video, codec: 'hevc' }, audio: { ...s.audio!, codec: 'pcm' } }).selected!.strategy, 'full-transcode');
});
test('unknown rules, missing timing and missing removal data never become automatic Direct', () => {
  const unknown = structuredClone(jp); unknown.video.evidence = { ...experiment, status: 'unknown' };
  assert.equal(decide(source(), [unknown]).selected, undefined);
  const s = source(); delete s.video.displayTicks;
  assert.equal(decide(s).selected, undefined);
  const copy = source({ profile: 'Main', level: 40, displayTicks: [0, 3003, 6006] }, { codec: 'aac', format: 'mpeg2-aac-lc', channels: 2, sampleRate: 48000 });
  copy.transport = { ...jp.transport.value };
  assert.equal(decide(copy).selected, undefined);
});
test('advertisement matching is exact for PN; generic MIME never grants a named profile', () => {
  assert.equal(parseSinkProtocolInfo('broken,http-get:*:video/mp4:*').length, 1);
  const d = decidePlayback({ source: source(), sinkProtocolInfo: 'http-get:*:video/vnd.dlna.mpeg-tts:*', profiles: [jp], observations, capabilities });
  assert.equal(d.candidates.length, 0); assert.equal(d.fallback.action, 'hold');
});
test('explicit raw framing failure blocks recipe; suffix does not decide framing', () => {
  const raw = structuredClone(jp); raw.transport.value.framing = 'tts192';
  const d = decidePlayback({ source: source(), sinkProtocolInfo: sink, profiles: [raw], observations: [{ ...observations[0], framing: 'tts192', outcome: 'failure' }], capabilities });
  assert.equal(d.candidates[0].verification, 'blocked'); assert.equal(d.selected, undefined);
});
test('execution capabilities gate execution without changing media strategy or selecting vendor', () => {
  const d = decide(source(), [jp], { ...capabilities, encoders: [] });
  assert.equal(d.candidates[0].strategy, 'full-transcode'); assert.equal(d.candidates[0].verification, 'blocked');
  assert.ok(!JSON.stringify(d).includes('nvenc'));
});
test('quality policy independent, planner pure, invalid timeline safely blocks candidate', () => {
  const s = source(), before = structuredClone(s);
  const d = decide(s); assert.deepEqual(s, before);
  assert.ok(cadenceQualityWarnings(d.selected!.cadence!, .99).warnings.length);
  assert.equal(decide(source({ displayTicks: [1, 1] })).candidates[0].verification, 'blocked');
});
test('HD60 raw TTS uses explicit framing and byte seek, no shared _T encapsulation rule', () => {
  const hd = structuredClone(jp); hd.id = 'hd60-reference';
  hd.transport.value = { ...hd.transport.value, framing: 'tts192', profileName: 'AVC_TS_HD_60_AC3_T', seek: 'byte' };
  hd.audio.value = { ...hd.audio.value, codec: 'ac3', format: 'ac3' };
  const caps = { ...capabilities, encoders: [...capabilities.encoders, { codec: 'ac3', available: true }] };
  const d = decidePlayback({ source: source(), sinkProtocolInfo: 'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_HD_60_AC3_T', profiles: [hd],
    observations: [{ ...observations[0], profileId: hd.id, framing: 'tts192', audioFormat: 'ac3' }], capabilities: caps });
  assert.equal(d.selected!.target.transport.value.framing, 'tts192');
  assert.equal(d.selected!.target.transport.value.seek, 'byte');
});
test('unknown recipes stay diagnostic; known video remux never becomes automatic full transcode', () => {
  const s = source({ profile: 'Main', level: 40, displayTicks: [0, 3003, 6006], removalTicks: [0, 3003, 6006] }, { codec: 'aac', format: 'mpeg2-aac-lc', channels: 2, sampleRate: 48000 });
  const d = decidePlayback({ source: s, sinkProtocolInfo: sink, profiles: [jp], observations: [], capabilities });
  assert.equal(d.selected, undefined); assert.equal(d.candidates[0].strategy, 'remux');
  assert.equal(d.fallback.action, 'diagnostic-only');
});
