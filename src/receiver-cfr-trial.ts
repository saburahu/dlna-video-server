import {COMPATIBLE_CONTAINER_CFR} from './compatible-container-cfr.js';
import {snapshotHash,type CapabilitySnapshot} from './playback-shadow.js';

/** Explicit individual experiment, not a model/family capability claim. No defaults. */
export interface ReceiverCfrTrial {
 version:'receiver-cfr-trial-v1'; enabled:boolean; deviceId:string; sinkHash:string;
 implementationFingerprint:string; reference:string;
 configuredBy?:'operator'|'legacy-trial';updatedAt?:string;
}
export const RECEIVER_CFR='receiver-cfr-30000-1001-v1' as const;
export type ReceiverCfr=typeof RECEIVER_CFR|'receiver-wmv3-cfr-30000-1001-trial-v1'|'receiver-h264-avi-cfr-30000-1001-trial-v1'|typeof COMPATIBLE_CONTAINER_CFR;
export function receiverCfrTrial(trials:ReceiverCfrTrial[]|undefined,cap:CapabilitySnapshot|undefined,probe:any,avc:boolean):ReceiverCfr|undefined {
 if(!avc||!cap?.implementation?.fingerprint||!probe)return;
 const videos=probe.streams?.filter((s:any)=>s.codec_type==='video')??[],v=videos[0];
 if(videos.length!==1||v.codec_name!=='msmpeg4v3'||!String(probe.format?.format_name).split(',').includes('avi'))return;
 const [n,d]=String(v.avg_frame_rate??v.r_frame_rate).split('/').map(Number),fps=n/d;
 if(!Number.isFinite(fps)||Math.abs(fps-24000/1001)>.002||!(v.width>0&&v.width<=720&&v.height>0&&v.height<=576))return;
 const matches=trials?.filter(t=>t.version==='receiver-cfr-trial-v1'&&t.enabled&&t.reference.trim()&&t.deviceId===cap.deviceId&&t.sinkHash===cap.sinkHash&&t.implementationFingerprint===cap.implementation!.fingerprint)??[];
 return matches.length===1?RECEIVER_CFR:undefined;
}
/** A changed/expired correction cannot silently reuse a previously advertised URL. */
export function receiverCfrBinding(binding:string|undefined,correction:ReceiverCfr|undefined){
 return binding&&correction?snapshotHash(JSON.stringify({binding,correction})):binding;
}
export const receiverCfrFirstTick=(sourceTick:number)=>Math.ceil(sourceTick/3003)*3003;
