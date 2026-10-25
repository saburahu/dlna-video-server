import {automaticReceiverCfr} from './receiver-playback-profile.js';
import {H264_AVI_CFR,matchingH264AviCfrTrial,type ReceiverH264AviCfrTrial} from './receiver-h264-avi-cfr-trial.js';
import {snapshotHash,type CapabilitySnapshot,type Fingerprint} from './playback-shadow.js';
import {receiverCfrTrial,type ReceiverCfrTrial,type ReceiverCfr} from './receiver-cfr-trial.js';
import assert from 'node:assert/strict';
import type {summarizeDecodedCadence} from './wmv-video-inspection.js';

export const WMV_RECEIVER_CFR='receiver-wmv3-cfr-30000-1001-trial-v1' as const;
export interface WmvVideoEvidence {
 version:'wmv-video-fullscan-v1';fingerprint:Fingerprint;videoSignature:string;decoderVersion:string;
 frames:number;first:number;last:number;fullVideoDecoded:true;allProgressive:true;cadence:'23976-or-2997-v1'|'23976-2997-5994-v1';
 cadence23976:number;cadence2997:number;cadence5994?:number;otherIntervals:number;
 missing:number;duplicates:number;backwards:number;frameProbeWarnings:number;checksum:string;
}
export interface ReceiverWmvCfrTrial {
 version:'receiver-wmv-cfr-trial-v1';enabled:boolean;deviceId:string;sinkHash:string;
 implementationFingerprint:string;reference:string;videoEvidence:WmvVideoEvidence;
}
export const wmvVideoSignature=(probe:any)=>snapshotHash(JSON.stringify({format:probe.format?.format_name,video:probe.streams?.filter((s:any)=>s.codec_type==='video').map((s:any)=>({index:s.index,codec:s.codec_name,profile:s.profile,width:s.width,height:s.height,pix:s.pix_fmt,fps:s.avg_frame_rate,timeBase:s.time_base,field:s.field_order}))}));
export function wmvEvidenceChecksum(e:Omit<WmvVideoEvidence,'checksum'>|WmvVideoEvidence){const {checksum:_,...rest}=e as WmvVideoEvidence;return snapshotHash(JSON.stringify(rest));}
/** Data-free evidence builder; the explicit CLI supplies a complete decoded scan.
 * Probe warnings and CLI discarded/corrupt-frame warnings are separate evidence.
 * This does not certify clean pixels or authorize other sources sharing a title. */
export function buildWmvVideoEvidence(fingerprint:Fingerprint,probe:any,full:ReturnType<typeof summarizeDecodedCadence>,frameProbeWarnings:string,decoderVersion:string,cadence:WmvVideoEvidence['cadence']='23976-or-2997-v1'):WmvVideoEvidence{
 assert.ok(full.frames>100&&full.fieldKnown===full.frames&&full.interlaced===0&&full.missing===0&&full.duplicates===0&&full.backwards===0&&(cadence==='23976-or-2997-v1'?full.otherIntervals===0:cadence==='23976-2997-5994-v1'&&full.otherBeyond5994===0&&full.cadence5994>0)&&full.cadence23976>0&&frameProbeWarnings.trim()==='','Full progressive bounded-cadence video evidence required');
 const e:Omit<WmvVideoEvidence,'checksum'>={version:'wmv-video-fullscan-v1',fingerprint,videoSignature:wmvVideoSignature(probe),decoderVersion,frames:full.frames,first:full.first!,last:full.last!,fullVideoDecoded:true,allProgressive:true,cadence,cadence23976:full.cadence23976,cadence2997:full.cadence2997,...(cadence==='23976-2997-5994-v1'?{cadence5994:full.cadence5994}:{}),otherIntervals:cadence==='23976-2997-5994-v1'?full.otherBeyond5994:full.otherIntervals,missing:full.missing,duplicates:full.duplicates,backwards:full.backwards,frameProbeWarnings:0};
 return {...e,checksum:wmvEvidenceChecksum(e)};
}
/** Full scan is an explicit isolated preparation step, never Browse work. */
function findReceiverWmvCfrTrial(trials:ReceiverWmvCfrTrial[]|undefined,cap:CapabilitySnapshot|undefined,probe:any,avc:boolean,fingerprint:Fingerprint|undefined){
 if(!avc||!fingerprint||!cap?.implementation?.fingerprint||cap.implementation.family!=='intel-upnp-layout'||!probe)return;
 const videos=probe.streams?.filter((s:any)=>s.codec_type==='video')??[],v=videos[0],audio=probe.streams?.filter((s:any)=>s.codec_type==='audio')??[];
 if(videos.length!==1||probe.format?.format_name!=='asf'||v.codec_name!=='wmv3'||v.profile!=='Main'||v.pix_fmt!=='yuv420p'||!(v.width>0&&v.width<=720&&v.height>0&&v.height<=576))return;
 const [n,d]=String(v.avg_frame_rate).split('/').map(Number),fps=n/d;
 if(!Number.isFinite(fps)||Math.abs(fps-24000/1001)>.002||!audio.length||audio.length>2||audio.some((a:any)=>!['wmav2','wmapro'].includes(a.codec_name)||Number(a.sample_rate)!==48000||a.channels!==2))return;
 const matches=trials?.filter(t=>{
  if(t.version!=='receiver-wmv-cfr-trial-v1'||!t.enabled||!t.reference?.trim()||t.deviceId!==cap.deviceId||t.sinkHash!==cap.sinkHash||t.implementationFingerprint!==cap.implementation!.fingerprint)return false;
  const e=t.videoEvidence;
  return e?.version==='wmv-video-fullscan-v1'&&e.fingerprint?.path===fingerprint.path&&e.fingerprint.size===fingerprint.size&&e.fingerprint.mtimeMs===fingerprint.mtimeMs&&e.videoSignature===wmvVideoSignature(probe)&&!!e.decoderVersion?.trim()&&e.fullVideoDecoded===true&&e.allProgressive===true&&(e.cadence==='23976-or-2997-v1'?e.cadence5994===undefined:e.cadence==='23976-2997-5994-v1'&&Number.isInteger(e.cadence5994)&&e.cadence5994!>0)&&Number.isInteger(e.frames)&&e.frames>100&&Number.isInteger(e.cadence23976)&&Number.isInteger(e.cadence2997)&&e.cadence23976>0&&e.cadence2997>=0&&e.otherIntervals===0&&e.cadence23976+e.cadence2997+(e.cadence5994??0)===e.frames-1&&Number.isFinite(e.first)&&Number.isFinite(e.last)&&e.last>e.first&&e.missing===0&&e.duplicates===0&&e.backwards===0&&e.frameProbeWarnings===0&&e.checksum===wmvEvidenceChecksum(e);
 })??[];
 return matches.length===1?matches[0]:undefined;
}
/** Diagnostics are derived from the same authorization used by Browse and GET.
 * A checksum detects stale/edited evidence; it is not an authentication signature.
 * No inspection, network access or receiver-wide enrollment occurs here. */
export function evaluateReceiverWmvCfrTrial(trials:ReceiverWmvCfrTrial[]|undefined,cap:CapabilitySnapshot|undefined,probe:any,avc:boolean,fingerprint:Fingerprint|undefined):{trial?:ReceiverWmvCfrTrial;reason:string}{
 if(!avc)return {reason:'wmv-cfr-avc-required'};
 if(!fingerprint||!cap?.implementation?.fingerprint||!probe)return {reason:'wmv-cfr-current-source-and-identity-required'};
 if(!Array.isArray(trials)||!trials.length)return {reason:'wmv-cfr-not-enrolled'};
 try {
  const trial=findReceiverWmvCfrTrial(trials,cap,probe,avc,fingerprint);
  if(trial)return {trial,reason:'wmv-cfr-explicit-individual-and-fullscan-source'};
  const receiver=trials.filter(t=>t?.version==='receiver-wmv-cfr-trial-v1'&&t.enabled&&t.deviceId===cap.deviceId&&t.sinkHash===cap.sinkHash&&t.implementationFingerprint===cap.implementation!.fingerprint);
  if(!receiver.length)return {reason:'wmv-cfr-receiver-permission-mismatch'};
  const source=receiver.filter(t=>{const f=t.videoEvidence?.fingerprint;return f?.path===fingerprint.path&&f.size===fingerprint.size&&f.mtimeMs===fingerprint.mtimeMs;});
  if(!source.length)return {reason:'wmv-cfr-source-evidence-missing-or-stale'};
  if(source.length>1)return {reason:'wmv-cfr-ambiguous-source-permission'};
  return {reason:'wmv-cfr-input-or-fullscan-evidence-unverified'};
 }catch{return {reason:'wmv-cfr-malformed-permission-or-evidence'};}
}
export function matchingReceiverWmvCfrTrial(trials:ReceiverWmvCfrTrial[]|undefined,cap:CapabilitySnapshot|undefined,probe:any,avc:boolean,fingerprint:Fingerprint|undefined){
 return evaluateReceiverWmvCfrTrial(trials,cap,probe,avc,fingerprint).trial;
}
export function receiverVideoCfrTrial(avi:ReceiverCfrTrial[]|undefined,wmv:ReceiverWmvCfrTrial[]|undefined,cap:CapabilitySnapshot|undefined,probe:any,avc:boolean,fingerprint:Fingerprint,h264?:ReceiverH264AviCfrTrial[],automaticBound=false):ReceiverCfr|undefined{
 const explicit=matchingReceiverWmvCfrTrial(wmv,cap,probe,avc,fingerprint)?WMV_RECEIVER_CFR:receiverCfrTrial(avi,cap,probe,avc)??(matchingH264AviCfrTrial(h264,cap,probe,avc,fingerprint)?H264_AVI_CFR:undefined);
 if(explicit)return explicit;
 // Disabled, stale, ambiguous or malformed relevant exceptions veto inference.
 const own=(t:{deviceId:string})=>t.deviceId===cap?.deviceId;
 if(avi?.some(own)&&probe?.streams?.some((s:any)=>s.codec_name==='msmpeg4v3'))return;
 if(wmv?.some(t=>own(t)&&(!t.videoEvidence?.fingerprint||t.videoEvidence.fingerprint.path===fingerprint.path)))return;
 if(h264?.some(t=>own(t)&&(!t.evidence?.fingerprint||t.evidence.fingerprint.path===fingerprint.path)))return;
 return automaticBound?automaticReceiverCfr(cap,probe,avc):undefined;
}
