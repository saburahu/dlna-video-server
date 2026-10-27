import {mpeg2TrialState} from './receiver-mpeg2-trial.js';
import {mpeg2InputEligibility,mpeg2UnsafeInput} from './mpeg2-input-scope.js';
import {isMpeg2JitTarget} from './mpeg2-jit-target.js';
import {matchingJitTrial,trialProfile} from './jit-client-trial.js';
import {decidePlayback} from './playback-decision.js';
import {sourceFromProbe} from './playback-shadow-store.js';
import {planJitExecution} from './jit-execution-plan.js';
import type {ExperimentalEntry} from './experimental-catalog.js';
import type {ExperimentalJitPolicy} from './experimental-jit.js';
import type {CapabilitySnapshot} from './playback-shadow.js';
import {jitSourceCapabilities,LEGACY_VIDEO_DECODERS} from './jit-source-support.js';
import {wmaInputAllowed} from './wma-input-scope.js';
import {scopedWmaInputPermission} from './wma-input-permission.js';
import {automaticWmaProInput} from './automatic-wmapro-input.js';

/** Pure metadata admission; cadence is checked by the existing runtime, never guessed from extension. */
export function catalogJitCandidate(entry:ExperimentalEntry,p:ExperimentalJitPolicy,cap:CapabilitySnapshot){
 try{
  if(!p.catalogMetadataResources||!entry.lightweightProbe||entry.sourceStale)return;
  const probe=entry.lightweightProbe,duration=Number(probe.format?.duration);
  if(!Number.isFinite(duration)||duration<=0)return;
  const source=sourceFromProbe(entry.fingerprint.path,entry.fingerprint,probe).characteristics;
  if(probe.streams.filter((s:any)=>s.codec_type==='video').length!==1||probe.streams.find((s:any)=>s.codec_type==='video')?.disposition?.attached_pic)return;
  const audio=probe.streams.find((s:any)=>s.codec_type==='audio');
  if(audio?.channels===6&&!['5.1','5.1(side)'].includes(audio.channel_layout))return;
  const legacy=(LEGACY_VIDEO_DECODERS as readonly string[]).includes(source.video.codec);
  const frameSequence=source.video.codec==='hevc'&&source.video.scan===undefined&&probe.inputPictureStructure==='frame-sequence';
  if(source.video.bitDepth!==8||source.video.chroma!=='420'||(!['progressive','interlaced'].includes(source.video.scan??'')&&!frameSequence&&!legacy)||
    (!legacy&&(!source.video.profile||!Number.isFinite(source.video.level)))||!Number.isSafeInteger(source.video.codedWidth)||!Number.isSafeInteger(source.video.codedHeight)||source.video.codedWidth!<=0||source.video.codedHeight!<=0)return;
  const profile=p.policy.profiles.find(v=>v.id===p.targetProfile);if(!profile)return;
  const mpeg2Trial=mpeg2TrialState(p.mpeg2ReceiverTrials,cap,p.targetProfile,!!p._admission?.binding);
  if(isMpeg2JitTarget(profile)&&(mpeg2UnsafeInput(probe)||(mpeg2Trial.wmaProInput||mpeg2Trial.dualAudio)&&!mpeg2InputEligibility(probe).eligible))return;
  const observations=p.policy.observations.filter(o=>o.deviceId===cap.deviceId&&o.sinkHash===cap.sinkHash).map(o=>o.observation);
  const evidence=observations.find(o=>o.profileId===profile.id&&o.outcome==='success'&&o.framing===profile.transport.value.framing)?.evidence;
  const trial=matchingJitTrial(p.clientTrials,cap,profile);
  if(trial?.automaticEvidence&&['avi','asf','ogg'].includes(source.transport.container)&&!p.automaticClients?.legacyInputs)return;
  if(trial?.automaticEvidence?.inputPolicy==='jit-legacy-inputs-v1'&&!wmaInputAllowed(source.audio?.codec??'',Number(audio?.sample_rate),audio?.channels,audio?.channel_layout,p.automaticClients?.wmaInputs,source.video.codec)&&!scopedWmaInputPermission(p.wmaInputPermissions,cap,p.targetProfile,entry.fingerprint,probe)&&!automaticWmaProInput(probe,cap,p.targetProfile,p.automaticClients?.wmaInputs,p.wmaInputPermissions,entry.fingerprint,mpeg2Trial.wmaProInput).eligible)return;
  if(trial&&!trial.containers.includes(source.transport.container))return;
  if(!evidence&&!trial)return;
  const target=trial?trialProfile(profile,trial):{...profile,video:{...profile.video,evidence:evidence!},audio:{...profile.audio,evidence:evidence!},transport:{...profile.transport,evidence:evidence!}};
  const decision=decidePlayback({source,sinkProtocolInfo:cap.sink,profiles:[target],observations,diagnosticTargets:trial?[{profileId:profile.id,reference:trial.reference}]:undefined,capabilities:jitSourceCapabilities(p.policy.capabilities,probe)});
  const candidate=decision.candidates.find(c=>c.target.id===target.id);if(!candidate)return;
  const execution=planJitExecution(source,candidate);
  return {duration,execution,decision,verification:trial?'diagnostic-only; client-scoped trial; runtime validation required':'metadata-admitted; runtime validation required'};
 }catch{return;}
}
