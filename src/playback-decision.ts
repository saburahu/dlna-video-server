import { planCadenceNormalization, type TargetTimingPolicy } from './cadence-plan.js';
import {LEGACY_VIDEO_DECODERS} from './source-codecs.js';
import {minimumRemovalTicks} from './cadence-normalization.js';

/** Inspector-owned, fingerprint-bound full analysis. Detailed selections live outside JSON. */
export interface CachedCadenceSummary {policy:TargetTimingPolicy;sourceFrames:number;retained:number;dropped:number;required:boolean;minimumTicks:number;selectionFingerprint:string;scope:'full-duration'}

export type EvidenceStatus = 'normative-confirmed' | 'advertised' | 'experimentally-confirmed' | 'inferred' | 'unknown';
export interface Evidence { status: EvidenceStatus; reference: string; scope: string }
export interface Rule<T> { value: T; evidence: Evidence }
export type Mode = 'direct' | 'remux' | 'audio-transcode' | 'video-transcode' | 'full-transcode';
export interface Transport {
  container: string; framing: 'file' | 'ts188' | 'tts192' | 'jp-content-packet';
  mime: string; profileName?: string; seek: 'byte' | 'time' | 'none';
}
export interface MediaCharacteristics {
  protection?:string;
  transport: Transport;
  video: { codec: string; profile?: string; level?: number; codedWidth?: number; codedHeight?: number;
    bitDepth?: number; chroma?: string; scan?: string; dpbFrames?: number; bitrate?: number; cpbBits?: number;
    displayAspectRatio?:string; fullRange?:boolean; displayTicks?: readonly number[]; removalTicks?: readonly number[]; timebase?: number; cachedCadence?:CachedCadenceSummary };
  audio?: { codec: string; format?: string; channels?: number; sampleRate?: number };
  /** Metadata/syntax validation performed by an external read-only inspector. */
  validation: Rule<boolean>;
}
export interface VideoTarget {
  codec: string; profile: string; level: number; codedWidth: number; codedHeight: number;
  bitDepth: number; chroma: string; scan: string; maxDpbFrames: number; maxBitrate: number; maxCpbBits: number;
  timing: TargetTimingPolicy;
}
export interface MediaProfileDefinition {
  id: string; transport: Rule<Transport>; video: Rule<VideoTarget>;
  audio: Rule<{ codec: string; format: string; maxChannels: number; sampleRates: readonly number[]; allowAbsent: boolean }>;
  /** Even a tested output recipe is not certification of the entire named DLNA profile. */
  conformance: Evidence;
}
export interface SinkEntry { protocol: string; mime: string; profileName?: string; additionalInfo: string }
export function parseSinkProtocolInfo(sink: string): SinkEntry[] {
  return sink.split(',').flatMap(entry => {
    const match = /^([^:]+):([^:]+):([^:]+):(.+)$/.exec(entry.trim());
    if (!match) return [];
    return [{ protocol: match[1], mime: match[3], profileName: /(?:^|;)DLNA\.ORG_PN=([^;]+)/.exec(match[4])?.[1], additionalInfo: match[4] }];
  });
}
export interface CompatibilityObservation {
  profileId: string; framing: Transport['framing']; outcome: 'success' | 'failure';
  evidence: Evidence;
  /** Structured recipe match: never a device/model-name or recording-title rule. */
  videoCodec: string; videoProfile?: string; maxLevel?: number; audioFormat?: string;
}
export interface ExecutionCapabilities {
  encoders: readonly { codec: string; available: boolean }[];
  decoders: readonly { codec: string; available: boolean }[];
}
export type Transform = { kind: 'remux' | 'transport-framing' | 'seek-contract' | 'video-codec' | 'resize' |
  'profile-level-normalization' | 'video-format-normalization' | 'cadence-normalization' | 'audio-format-normalization' | 'deinterlace' | 'audio-resample' | 'audio-channel-mix' | 'audio-timeline-reconciliation'; reason: string };
export interface DecisionCandidate {
  strategy: Mode; target: MediaProfileDefinition; transforms: Transform[]; reasons: string[];
  evidence: Evidence[]; unknowns: string[]; blockers: string[];
  verification: 'supported-candidate' | 'diagnostic-only' | 'blocked';
  confidence: 'observed-recipe' | 'normative-plan' | 'unverified';
  cadence?: ReturnType<typeof planCadenceNormalization>;
  cadenceSummary?: CachedCadenceSummary;
  outputValidationRequired: string[];
}
export interface PlaybackDecision {
  selected?: DecisionCandidate; candidates: DecisionCandidate[];
  fallback: { action: 'source-unchanged' | 'remux' | 'conservative-transcode' | 'diagnostic-only' | 'hold'; reason: string };
  issues: readonly string[];
}
const trusted = (e: Evidence) => e.status === 'normative-confirmed' || e.status === 'experimentally-confirmed';
const sameTransport = (a: Transport, b: Transport) => a.container === b.container && a.framing === b.framing && a.mime === b.mime && a.profileName === b.profileName;

/** Pure planning only. No I/O, FFmpeg, device commands, source mutation or backend selection. */
export function decidePlayback(input: {
  source: MediaCharacteristics; sinkProtocolInfo: string; profiles: readonly MediaProfileDefinition[];
  observations: readonly CompatibilityObservation[]; capabilities: ExecutionCapabilities;
  diagnosticTargets?:readonly {profileId:string;reference:string}[];
}): PlaybackDecision {
  const { source, observations, capabilities } = input;
  if(source.protection)return {candidates:[],fallback:{action:'hold',reason:source.protection},issues:['Encrypted/protected source is unsupported; no decryption attempted']};
  const sinks = parseSinkProtocolInfo(input.sinkProtocolInfo);
  const candidates: DecisionCandidate[] = [];
  for (const target of input.profiles) {
    const t = target.transport.value, v = target.video.value, a = target.audio.value;
    // Generic MIME advertisement does not imply support for a specific named PN.
    const advertised=sinks.some(s => s.protocol === 'http-get' && (s.mime === t.mime || s.mime === '*') && s.profileName === t.profileName);
    const trial=input.diagnosticTargets?.find(d=>d.profileId===target.id&&d.reference);
    if(!advertised&&!trial)continue;
    const evidence = [target.transport.evidence, target.video.evidence, target.audio.evidence, target.conformance,
      advertised?{ status: 'advertised' as const, reference: 'GetProtocolInfo:Sink', scope: t.profileName ?? t.mime }:{status:'unknown' as const,reference:trial!.reference,scope:'Receiver does not advertise this target; explicit diagnostic trial only'}];
    const unknowns: string[] = trial?['explicit diagnostic target; receiver acceptance unconfirmed']:[], blockers: string[] = [], transforms: Transform[] = [];
    const add = (kind: Transform['kind'], reason: string) => transforms.push({ kind, reason });
    for (const [name, rule] of [['transport', target.transport], ['video constraints', target.video], ['audio constraints', target.audio]] as const) {
      if (!trusted(rule.evidence)) unknowns.push(`${name}: ${rule.evidence.status}`);
    }
    if (!source.validation.value || !trusted(source.validation.evidence)) unknowns.push('source syntax/metadata validation incomplete');
    if (!sameTransport(source.transport, t)) {
      add('remux', `container ${source.transport.container} -> ${t.container}`);
      if (source.transport.framing !== t.framing) add('transport-framing', `${source.transport.framing} -> ${t.framing}`);
    }
    if (source.transport.seek !== t.seek) add('seek-contract', `${source.transport.seek} -> ${t.seek}`);
    let videoChange = false;
    if (source.video.codec !== v.codec) { add('video-codec', `${source.video.codec} -> ${v.codec}`); videoChange = true; }
    for (const key of ['codedWidth', 'codedHeight'] as const) {
      if (source.video[key] === undefined) unknowns.push(`source video ${key} unknown`);
      else if (source.video[key] !== v[key]) { if (!transforms.some(x => x.kind === 'resize')) add('resize', `target coded geometry ${v.codedWidth}x${v.codedHeight}`); videoChange = true; }
    }
    if (source.video.codec === v.codec) {
      if (source.video.profile === undefined || source.video.level === undefined) unknowns.push('source profile/level unknown');
      else if (source.video.profile !== v.profile || source.video.level > v.level) { add('profile-level-normalization', `target ${v.codec} ${v.profile} L${v.level}`); videoChange = true; }
      for (const [key, maximum] of [['dpbFrames', v.maxDpbFrames], ['bitrate', v.maxBitrate], ['cpbBits', v.maxCpbBits]] as const) {
        if (source.video[key] === undefined) unknowns.push(`source ${key} unknown; output audit required`);
        else if (source.video[key]! > maximum) { add('video-format-normalization', `${key} exceeds target ${maximum}`); videoChange = true; }
      }
    }
    for (const key of ['bitDepth', 'chroma', 'scan'] as const) {
      if (source.video[key] === undefined) unknowns.push(`source ${key} unknown`);
      else if (source.video[key] !== v[key]) { add('video-format-normalization', `${key} -> ${v[key]}`); videoChange = true; }
    }
    if(source.video.scan===undefined&&(LEGACY_VIDEO_DECODERS as readonly string[]).includes(source.video.codec)&&v.scan==='progressive'){add('deinterlace','Unknown legacy scan: frame-preserving deinterlace of every decoded picture; no invented source scan');videoChange=true;}
    if(source.video.scan==='interlaced'&&v.scan==='progressive')add('deinterlace','frame-preserving deinterlace; original picture PTS, no field-rate doubling');
    let cadence: DecisionCandidate['cadence'],cadenceSummary:CachedCadenceSummary|undefined;
    const cached=source.video.cachedCadence;
    if(cached&&!source.video.displayTicks?.length){
      if(source.video.timebase!==v.timing.constraint.timebase||!trusted(source.validation.evidence)||!source.validation.value||JSON.stringify(cached.policy)!==JSON.stringify(v.timing)||cached.scope!=='full-duration'||cached.minimumTicks!==minimumRemovalTicks(v.timing.constraint).minimumTicks||!Number.isSafeInteger(cached.sourceFrames)||cached.sourceFrames<1||!Number.isSafeInteger(cached.retained)||cached.retained<1||!Number.isSafeInteger(cached.dropped)||cached.dropped<0||cached.retained+cached.dropped!==cached.sourceFrames||cached.required!==(cached.dropped>0)||!/^[a-f0-9]{64}$/.test(cached.selectionFingerprint))blockers.push('invalid or mismatched cached cadence summary');
      else{cadenceSummary=cached;if(cached.required){add('cadence-normalization',`target minimum ${cached.minimumTicks} ticks; preserve retained PTS, no duplicates`);videoChange=true;}}
    }
    else if (source.video.timebase !== v.timing.constraint.timebase || !source.video.displayTicks?.length) unknowns.push('display timeline/timebase unavailable');
    else {
      try {
        cadence = planCadenceNormalization(source.video.displayTicks, v.timing);
        if (cadence.required) { add('cadence-normalization', `target minimum ${cadence.minimum.minimumTicks} ticks; preserve retained PTS, no duplicates`); videoChange = true; }
        if (!trusted(target.video.evidence)) unknowns.push('cadence target constraint not verified');
      } catch (error) { blockers.push(`invalid cadence plan: ${String(error)}`); }
    }
    // A display selection plan is not proof of source CPB removal conformance.
    if (!videoChange && !source.video.removalTicks?.length) unknowns.push('source nominal removal timeline unknown');
    if (!videoChange && source.video.removalTicks?.length && cadence) {
      const times = source.video.removalTicks;
      if (times.some((x, i) => !Number.isSafeInteger(x) || (i > 0 && x - times[i - 1] < cadence!.minimum.minimumTicks))) {
        add('video-format-normalization', 'source removal cadence violates target; decode/re-encode required'); videoChange = true;
      }
    }
    let audioChange = false;
    if (!source.audio) { if (!a.allowAbsent) blockers.push('target requires audio; do not invent a silent track'); }
    else {
      if(source.audio.sampleRate!==undefined&&!a.sampleRates.includes(source.audio.sampleRate))add('audio-resample',`${source.audio.sampleRate} Hz -> ${a.sampleRates.join('/')} Hz; preserve audio time`);
      if (source.audio.channels === undefined || source.audio.sampleRate === undefined || source.audio.format === undefined) unknowns.push('source audio parameters incomplete');
      if (source.audio.codec !== a.codec || (source.audio.format !== undefined && source.audio.format !== a.format) ||
        (source.audio.channels !== undefined && source.audio.channels > a.maxChannels) ||
        (source.audio.sampleRate !== undefined && !a.sampleRates.includes(source.audio.sampleRate))) {
        add('audio-format-normalization', `${source.audio.codec}/${source.audio.format ?? 'unknown'} -> ${a.codec}/${a.format}`); audioChange = true;
      }
      if(audioChange&&(['avi','asf','ogg'].includes(source.transport.container)||['wmav1','wmav2','wmapro','wmalossless'].includes(source.audio.codec)))add('audio-timeline-reconciliation','Timestamp-driven resampling of legacy packet audio clock; preserve gaps/start/end on media timeline, no track invention');
      if(audioChange&&source.audio.channels!==undefined&&source.audio.channels!==a.maxChannels)add('audio-channel-mix',`${source.audio.channels} channels -> ${a.maxChannels}; explicit target mix`);
    }
    const relevant = observations.filter(o => o.profileId === target.id && o.framing === t.framing && o.videoCodec === v.codec &&
      (!o.videoProfile || o.videoProfile === v.profile) && (o.maxLevel === undefined || v.level <= o.maxLevel) && (!o.audioFormat || o.audioFormat === a.format));
    evidence.push(...relevant.map(o => o.evidence));
    if (relevant.some(o => o.outcome === 'failure')) blockers.push('matching transport/recipe failure observation');
    if (videoChange && (!capabilities.encoders.some(c => c.codec === v.codec && c.available) || !capabilities.decoders.some(c => c.codec === source.video.codec && c.available))) blockers.push('video execution capability unavailable');
    if (audioChange && (!capabilities.encoders.some(c => c.codec === a.codec && c.available) || !capabilities.decoders.some(c => c.codec === source.audio!.codec && c.available))) blockers.push('audio execution capability unavailable');
    const strategy: Mode = videoChange ? audioChange ? 'full-transcode' : 'video-transcode' : audioChange ? 'audio-transcode' : transforms.length ? 'remux' : 'direct';
    const observed = relevant.some(o => o.outcome === 'success' && trusted(o.evidence));
    const normative = [target.transport, target.video, target.audio].every(r => r.evidence.status === 'normative-confirmed');
    if (!observed && !normative) unknowns.push('output recipe playback unverified');
    if (target.conformance.status === 'unknown') unknowns.push('named DLNA profile full conformance unconfirmed');
    // Profile certification unknown may coexist with an explicitly observed recipe.
    const gatingUnknowns = unknowns.filter(u => !(observed && u === 'named DLNA profile full conformance unconfirmed'));
    candidates.push({ strategy, target, transforms, reasons: transforms.map(x => x.reason), evidence, unknowns, blockers, cadence,...(cadenceSummary?{cadenceSummary}:{}),
      verification: blockers.length ? 'blocked' : gatingUnknowns.length ? 'diagnostic-only' : 'supported-candidate',
      confidence: observed ? 'observed-recipe' : normative ? 'normative-plan' : 'unverified',
      outputValidationRequired: videoChange || audioChange ? ['encoded syntax/level/HRD/CPB', 'retained PTS and audio timeline', 'PCR/TTS/framing and HTTP', 'device playback for new output'] : ['source syntax and transport contract'] });
  }
  const cost: Record<Mode, number> = { direct: 0, remux: 1, 'audio-transcode': 2, 'video-transcode': 3, 'full-transcode': 4 };
  const selected = candidates.filter(c => c.verification === 'supported-candidate').sort((a, b) => cost[a.strategy] - cost[b.strategy] || a.target.id.localeCompare(b.target.id))[0];
  return { selected, candidates, fallback: { action: selected ? selected.strategy.includes('transcode') ? 'conservative-transcode' : selected.strategy === 'direct' ? 'source-unchanged' : 'remux' : candidates.some(c => c.verification === 'diagnostic-only') ? 'diagnostic-only' : 'hold',
    reason: selected ? 'Explicit advertised target and verified constraints/recipe; output validation remains required' : 'No verified automatic plan; do not assume Direct or force full transcode' },
    issues: ['startup latency / initial media loss: separate issue; no timestamp offset workaround', 'quality assessment is independent of strategy; motion/scene-cut/subjective review pending'] };
}

/** Independent quality advisory; thresholds are caller policy, not device limits. */
export function cadenceQualityWarnings(plan: ReturnType<typeof planCadenceNormalization>, minimumRetainedRatio: number) {
  if (!Number.isFinite(minimumRetainedRatio) || minimumRetainedRatio < 0 || minimumRetainedRatio > 1) throw new Error('Invalid quality policy');
  return { retainedRatio: plan.diagnostics.retainedRatio, maximumConsecutiveDrops: plan.diagnostics.maximumConsecutiveDrops,
    warnings: plan.diagnostics.retainedRatio < minimumRetainedRatio ? ['retained ratio below quality policy; motion and scene-cut review required'] : [],
    subjectiveSmoothness: 'unknown', motionAndSceneCuts: 'not-analyzed' };
}
