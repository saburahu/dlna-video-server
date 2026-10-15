import assert from 'node:assert/strict';
import type {DecisionCandidate, MediaCharacteristics} from './playback-decision.js';
import {ENCODE_RECIPE} from './prepare-executor.js';
import {minimumRemovalTicks} from './cadence-normalization.js';
import {jitExecutorKind} from './jit-strategy.js';
import {assertJitSource,LEGACY_VIDEO_DECODERS} from './jit-source-support.js';
import {isMpeg2JitTarget,planMpeg2Jit} from './mpeg2-jit-target.js';

/** Supported executor contract, not a source title/model rule or an unknown fallback. */
export function planJitExecution(source:MediaCharacteristics, candidate:DecisionCandidate) {
  if(isMpeg2JitTarget(candidate.target))return planMpeg2Jit(source,candidate);
  assert.ok(!candidate.blockers.length && jitExecutorKind(candidate.strategy)==='software-main40-jp', 'Decision executor not connected');
  const v=candidate.target.video.value,a=candidate.target.audio.value,t=candidate.target.transport.value,r=ENCODE_RECIPE;
  assert.ok(v.codec===r.codec&&v.profile===r.profile&&v.level===r.level&&v.codedWidth===r.width&&v.codedHeight===r.codedHeight&&v.scan==='progressive'&&v.bitDepth===8&&v.chroma==='420'&&v.maxDpbFrames>=r.refs&&v.maxBitrate>=r.vbvRate&&v.maxCpbBits>=r.vbvSize,'Target not supported by certified encoder recipe');
  assert.ok(a.codec==='aac'&&a.format==='mpeg2-aac-lc'&&a.maxChannels>=r.audioChannels&&a.sampleRates.includes(r.audioRate)&&t.profileName==='AVC_TS_JP_AAC_T'&&t.mime==='video/vnd.dlna.mpeg-tts'&&t.framing==='jp-content-packet'&&t.seek==='time','Target audio/transport not connected');
  assertJitSource(source);
  assert.ok(candidate.transforms.some(x=>x.kind==='audio-format-normalization'),'Executor would perform audio work outside decision');
  assert.ok(candidate.transforms.some(x=>['video-codec','resize','profile-level-normalization','video-format-normalization','cadence-normalization'].includes(x.kind)),'Executor would perform video work outside decision');
  const ratio=source.video.displayAspectRatio?.split(':').map(Number),explicitDar=ratio&&ratio[0]>0&&ratio[1]>0?ratio[0]/ratio[1]:undefined;
  const legacyDimensions=explicitDar===undefined&&(LEGACY_VIDEO_DECODERS as readonly string[]).includes(source.video.codec)&&source.video.codedWidth!>0&&source.video.codedHeight!>0;
  const dar=explicitDar??(legacyDimensions?source.video.codedWidth!/source.video.codedHeight!:undefined);
  return {strategy:candidate.strategy,transforms:candidate.transforms,sourceVideoCodec:source.video.codec,sourceAudioCodec:source.audio!.codec,fullRange:!!source.video.fullRange,...(legacyDimensions?{aspectFitEvidence:'legacy dimensions choose aspect-preserving scale; filter uses decoded SAR/DAR'}:{}),aspectFit:dar!==undefined&&Number.isFinite(dar)&&Math.abs(dar-16/9)>.01,
    deinterlace:source.video.scan==='interlaced'||source.video.scan===undefined&&(LEGACY_VIDEO_DECODERS as readonly string[]).includes(source.video.codec),resample:source.audio!.sampleRate!==r.audioRate,channelMix:source.audio!.channels!==r.audioChannels,
    reconcileAudioTimeline:candidate.transforms.some(t=>t.kind==='audio-timeline-reconciliation'),
    resize:candidate.transforms.some(x=>x.kind==='resize'),minimumTicks:minimumRemovalTicks(v.timing.constraint).minimumTicks,
    cadence: candidate.cadence ? (candidate.cadence.required?'required':'not-required') : candidate.cadenceSummary ? (candidate.cadenceSummary.required?'required':'not-required') : 'runtime-evaluated',
    video:{codec:v.codec,profile:v.profile,level:v.level,width:r.width,height:r.height,bFrames:r.bFrames},
    audio:{codec:a.codec,format:a.format,rate:r.audioRate,channels:r.audioChannels},transport:t};
}
