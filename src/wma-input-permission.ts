import {snapshotHash,type CapabilitySnapshot,type Fingerprint} from './playback-shadow.js';
import {wmaInputAllowed} from './wma-input-scope.js';

/** Input opt-in only: never output/dual-audio permission or a replacement clock. */
export interface WmaInputPermission {
 version:'wma-input-permission-v1';enabled:boolean;deviceId:string;sinkHash:string;
 implementationFingerprint:string;targetProfile:string;reference:string;
 sourceFingerprint:Fingerprint;inputPolicy:'source-clock-v2';
}
export function scopedWmaInputPermission(records:readonly WmaInputPermission[]|undefined,cap:CapabilitySnapshot|undefined,target:string,fingerprint:Fingerprint,probe:any):WmaInputPermission|undefined{
 if(!cap?.deviceId||!cap.implementation?.fingerprint||snapshotHash(cap.sink)!==cap.sinkHash||!Array.isArray(records))return;
 const same=(f:Fingerprint)=>!!f&&typeof f.path==='string'&&f.path===fingerprint.path&&Number.isSafeInteger(f.size)&&f.size>=0&&f.size===fingerprint.size&&Number.isFinite(f.mtimeMs)&&f.mtimeMs===fingerprint.mtimeMs;
 const matching=records.filter(p=>p?.deviceId===cap.deviceId&&p.targetProfile===target&&same(p.sourceFingerprint));
 if(matching.length!==1)return;
 const p=matching[0],videos=probe?.streams?.filter((s:any)=>s.codec_type==='video')??[],audios=probe?.streams?.filter((s:any)=>s.codec_type==='audio')??[];
 if(p.version!=='wma-input-permission-v1'||p.enabled!==true||p.inputPolicy!=='source-clock-v2'||!p.reference?.trim()||p.sinkHash!==cap.sinkHash||p.implementationFingerprint!==cap.implementation.fingerprint)return;
 if(probe.format?.format_name!=='asf'||videos.length!==1||videos[0].codec_name!=='wmv3'||!audios.length||!audios.every((a:any)=>a.codec_name==='wmapro'&&a.channel_layout==='stereo'&&wmaInputAllowed(a.codec_name,Number(a.sample_rate),a.channels,a.channel_layout,p.inputPolicy,videos[0].codec_name)))return;
 return p;
}
export const wmaInputBinding=(binding:string|undefined,permission:WmaInputPermission|undefined)=>binding&&permission?snapshotHash(JSON.stringify({binding,wmaInput:permission})):binding;
