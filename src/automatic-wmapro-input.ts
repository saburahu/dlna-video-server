import {RECEIVER_PLAYBACK_VERSION} from './receiver-playback-profile.js';
import type {CapabilitySnapshot,Fingerprint} from './playback-shadow.js';
import type {WmaInputPermission} from './wma-input-permission.js';
import type {WmaInputPolicy} from './wma-input-scope.js';
import path from 'node:path';

/** Admission to the existing source-clock-v2 execution path, NOT a new clock.
 * Finite playback and terminal coverage are independently runtime-audited. */
export function automaticWmaProInput(probe:any,cap:CapabilitySnapshot,target:string,policy:WmaInputPolicy|undefined,exceptions:readonly WmaInputPermission[]|undefined,fingerprint:Fingerprint){
 const no=(reason:string)=>({eligible:false,reason,version:'automatic-wmapro-input-v1' as const});
 if(!['source-clock-v1','source-clock-v2'].includes(policy??'')||target!=='legacy-jp-observed')return no('wmapro-input-policy-disabled-or-target-unsupported');
 if(cap.playbackProfile?.version!==RECEIVER_PLAYBACK_VERSION||!['regza-intel-server-cfr-v1','regza-intel-renderer-vfr-v1'].includes(cap.playbackProfile.id)||cap.implementation?.family!=='intel-upnp-layout')return no('wmapro-current-compatible-receiver-evidence-required');
 // A source-specific opt-out/stale/ambiguous record is never bypassed. A valid
 // enabled exception is handled separately by scopedWmaInputPermission.
 const related=(exceptions??[]).filter(p=>p?.deviceId===cap.deviceId&&p.targetProfile===target);
 const sourceKey=(p:string)=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
 if(related.some(p=>!p.sourceFingerprint||typeof p.sourceFingerprint.path!=='string'||!p.sourceFingerprint.path.trim()||sourceKey(p.sourceFingerprint.path)===sourceKey(fingerprint.path)))return no('wmapro-explicit-source-exception-authoritative');
 const streams=probe?.streams??[],videos=streams.filter((s:any)=>s.codec_type==='video'),audio=streams.filter((s:any)=>s.codec_type==='audio'),v=videos[0],duration=Number(probe?.format?.duration);
 if(probe?.format?.format_name!=='asf'||!Number.isFinite(duration)||duration<=0||videos.length!==1||v?.codec_name!=='wmv3'||v.profile!=='Main'||v.pix_fmt!=='yuv420p'||![v.width,v.height].every(Number.isSafeInteger)||v.width<=0||v.width>720||v.height<=0||v.height>576||!['progressive','unknown',undefined].includes(v.field_order))return no('wmapro-asf-wmv3-sd-progressive-scope-required');
 const rate=v.avg_frame_rate==='0/0'||v.avg_frame_rate===undefined?v.r_frame_rate:v.avg_frame_rate,[n,d]=String(rate).split('/').map(Number);
 if(!Number.isFinite(n/d)||![24000/1001,30000/1001].some(r=>Math.abs(n/d-r)<.002))return no('wmapro-nominal-cadence-unverified');
 if(![1,2].includes(audio.length)||streams.some((s:any)=>!Number.isSafeInteger(s.index)||s.index<0)||new Set(streams.map((s:any)=>s.index)).size!==streams.length)return no('wmapro-stream-layout-unverified');
 if(!audio.every((a:any)=>a.codec_name==='wmapro'&&a.channels===2&&a.channel_layout==='stereo'&&(audio.length===1?[44100,48000].includes(Number(a.sample_rate)):Number(a.sample_rate)===48000)&&a.time_base==='1/1000'))return no('wmapro-stereo-rate-or-pair-unverified');
 const start=Number(v.start_time??probe.format.start_time);
 if(!Number.isFinite(start)||start<0||start>=duration||!audio.every((a:any)=>Number.isFinite(Number(a.start_time))&&Math.abs(Number(a.start_time)-start)<=.003&&Number.isFinite(Number(a.duration))&&Math.abs(Number(a.duration)-duration)<=.064))return no('wmapro-stream-start-or-duration-inconsistent');
 if(!['wmv3','wmapro'].every(codec=>probe.executionDecoders?.includes(codec)))return no('wmapro-software-decoders-unavailable');
 return {eligible:true,reason:'bounded-asf-wmv3-wmapro-compatible-receiver',version:'automatic-wmapro-input-v1' as const,inputPolicy:'source-clock-v2' as const};
}
