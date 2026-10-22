import assert from 'node:assert/strict';
import type {ExperimentalJitPolicy} from './experimental-jit.js';
import type {CapabilitySnapshot,Fingerprint} from './playback-shadow.js';
import {matchingReceiverWmvCfrTrial,type WmvVideoEvidence,type ReceiverWmvCfrTrial} from './receiver-wmv-cfr-trial.js';
import {selectDualAudio,type DualAudioPermission} from './jit-dual-audio.js';

export interface WmvPermissionRequest {
 operation:'video'|'dual';enabled:boolean;reference:string;
 capability:CapabilitySnapshot;fingerprint:Fingerprint;probe:any;
 evidence:WmvVideoEvidence;decoderVersion:string;
}
const sameSource=(a:Fingerprint,b:Fingerprint)=>a.path===b.path&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
/** Explicit offline proposal, never a live-policy writer. Start from a reviewed
 * policy copy and current local evidence. Receiver success is a separate human
 * record, not inferred from this function or from matching metadata. */
export function proposeWmvPermission(policy:ExperimentalJitPolicy,r:WmvPermissionRequest){
 assert.ok(policy.version==='experimental-jit-v1'&&['video','dual'].includes(r.operation)&&typeof r.enabled==='boolean');
 const target=policy.policy?.profiles?.find(p=>p.id===policy.targetProfile);
 assert.ok(target?.video.value.codec==='h264'&&target.audio.value.codec==='aac'&&target.transport.value.profileName==='AVC_TS_JP_AAC_T','This enrollment workflow is AVC/AAC only');
 assert.ok(r.reference?.trim()&&r.capability?.deviceId&&r.capability.sinkHash&&r.capability.implementation?.fingerprint,'Explicit individual and reason required');
 assert.ok(r.decoderVersion?.trim()&&r.decoderVersion===r.evidence.decoderVersion,'Decoder version changed; repeat isolated evidence preparation');
 const video:ReceiverWmvCfrTrial={version:'receiver-wmv-cfr-trial-v1',enabled:true,deviceId:r.capability.deviceId,sinkHash:r.capability.sinkHash,implementationFingerprint:r.capability.implementation.fingerprint,reference:r.reference,videoEvidence:r.evidence};
 assert.ok(matchingReceiverWmvCfrTrial([video],r.capability,r.probe,true,r.fingerprint),'Current fingerprint, video metadata and complete bounded progressive evidence required');
 const out=structuredClone(policy),videos=out.receiverWmvCfrTrials??[],permissions=out.dualAudioPermissions??[];
 const selected=permissions.filter(p=>p.deviceId===r.capability.deviceId&&p.targetProfile===policy.targetProfile);
 assert.ok(selected.length<=1,'Ambiguous receiver/target permission');
 const prior=selected[0];
 if(r.operation==='video'){
  if(!r.enabled&&prior?.enabled){
   assert.ok(prior.sourceScope&&!prior.sourceScope.fingerprints.some(f=>sameSource(f,r.fingerprint)),'Disable this source dual permission first; combined receiver mode is the tested combination');
  }
  const matches=videos.filter(v=>v.deviceId===video.deviceId&&sameSource(v.videoEvidence.fingerprint,r.fingerprint));
  assert.ok(matches.length<=1,'Ambiguous video permission');
  out.receiverWmvCfrTrials=[...videos.filter(v=>!matches.includes(v)),{...video,enabled:r.enabled}];
 }else{
  if(prior){
   assert.ok(prior.sourceScope?.version==='jit-dual-audio-source-scope-v1','Refuse to replace or narrow existing unscoped receiver enrollment');
   assert.equal(prior.sinkHash,r.capability.sinkHash,'Receiver evidence changed');
   assert.equal(prior.implementationFingerprint,r.capability.implementation.fingerprint,'Receiver implementation changed');
  }
  const fingerprints=prior?.sourceScope?.fingerprints??[];
  assert.ok(new Set(fingerprints.map(f=>f.path)).size===fingerprints.length,'Duplicate source scope');
  assert.ok(!r.enabled||!prior||prior.enabled||fingerprints.length===0,'Refuse to reactivate previously disabled source grants implicitly');
  // A changed file is a new source, not automatic renewal of an old grant.
  assert.ok(!fingerprints.some(f=>f.path===r.fingerprint.path&&!sameSource(f,r.fingerprint)),'Stale source scope: review and remove the old source explicitly');
  if(r.enabled)assert.ok(matchingReceiverWmvCfrTrial(videos,r.capability,r.probe,true,r.fingerprint),'Enable the independently reviewed video grant first');
  const next=fingerprints.filter(f=>!sameSource(f,r.fingerprint));if(r.enabled)next.push(r.fingerprint);
  const dual:DualAudioPermission={version:'jit-dual-audio-permission-v1',enabled:next.length>0,deviceId:video.deviceId,sinkHash:video.sinkHash,implementationFingerprint:video.implementationFingerprint,targetProfile:policy.targetProfile,reference:r.reference,sourceScope:{version:'jit-dual-audio-source-scope-v1',fingerprints:next}};
  if(r.enabled)assert.ok(selectDualAudio([dual],r.capability,r.probe,policy.targetProfile,false,true,r.fingerprint).plan,'Source is not an existing supported stereo WMA pair');
  out.dualAudioPermissions=[...permissions.filter(p=>p!==prior),dual];
 }
 return out;
}
