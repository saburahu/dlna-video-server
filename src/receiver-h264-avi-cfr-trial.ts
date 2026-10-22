import assert from 'node:assert/strict';
import {snapshotHash,type Fingerprint,type CapabilitySnapshot} from './playback-shadow.js';

/** Isolated opt-in experiment. Not a general AVI compatibility declaration. */
export const H264_AVI_CFR='receiver-h264-avi-cfr-30000-1001-trial-v1' as const;
export interface H264AviEvidence {
 version:'h264-avi-fullscan-v1';fingerprint:Fingerprint;signature:string;decoderVersion:string;
 frames:number;packetCount:number;first:number;lastKnown:number;missingTail:number;
 packetFirstDts:number;packetLastDts:number;bPictures:number;checksum:string;
}
export interface ReceiverH264AviCfrTrial {
 version:'receiver-h264-avi-cfr-trial-v1';enabled:boolean;deviceId:string;sinkHash:string;
 implementationFingerprint:string;reference:string;evidence:H264AviEvidence;
}
export const h264AviSignature=(p:any)=>snapshotHash(JSON.stringify({format:p.format?.format_name,
 video:p.streams?.filter((s:any)=>s.codec_type==='video').map((s:any)=>({index:s.index,codec:s.codec_name,profile:s.profile,level:s.level,width:s.width,height:s.height,pix:s.pix_fmt,field:s.field_order,fps:s.avg_frame_rate,timeBase:s.time_base})),
 audio:p.streams?.filter((s:any)=>s.codec_type==='audio').map((s:any)=>({index:s.index,codec:s.codec_name,rate:s.sample_rate,channels:s.channels}))}));
export function h264AviEvidenceChecksum(e:Omit<H264AviEvidence,'checksum'>|H264AviEvidence){const{checksum:_,...rest}=e as H264AviEvidence;return snapshotHash(JSON.stringify(rest));}
function inputSupported(p:any){
 if(!p||!Array.isArray(p.streams))return false;
 const vs=p?.streams?.filter((s:any)=>s.codec_type==='video')??[],v=vs[0],as=p?.streams?.filter((s:any)=>s.codec_type==='audio')??[];
 const[n,d]=String(v?.avg_frame_rate).split('/').map(Number);
 return p?.format?.format_name==='avi'&&vs.length===1&&v.codec_name==='h264'&&v.profile==='High'&&v.level===51&&v.pix_fmt==='yuv420p'&&v.field_order==='progressive'&&v.width>0&&v.width<=720&&v.height>0&&v.height<=576&&Math.abs(n/d-24000/1001)<.002&&as.length===2&&as.every((a:any)=>a.codec_name==='mp3'&&Number(a.sample_rate)===48000&&a.channels===2);
}
/** Full read-only decoding is an explicit preparation step, never Browse/GET.
 * AVI may lack packet PTS entirely. Validate DTS and decoded best-effort cadence
 * separately; one timestamp-less final decoder-drain picture is recorded, not
 * silently promoted to a measured presentation time. No timestamp correction. */
export function buildH264AviEvidence(fingerprint:Fingerprint,probe:any,frames:any[],packets:any[],decoderVersion:string,decodeWarnings:string):H264AviEvidence{
 assert.ok(inputSupported(probe)&&decoderVersion.trim()&&decodeWarnings.trim()==='','Narrow input and clean full video decode required');
 const v=probe.streams.find((s:any)=>s.codec_type==='video'),f=frames.filter(x=>x.media_type==='video'),pk=packets.filter(x=>x.stream_index===v.index);
 assert.ok(f.length>100&&f.length===pk.length&&f.every(x=>x.interlaced_frame===0&&x.width===v.width&&x.height===v.height&&x.pix_fmt==='yuv420p'));
 const times=f.map(x=>Number(x.best_effort_timestamp_time??x.pts_time)),missing=times.findIndex(x=>!Number.isFinite(x));
 assert.ok(missing===-1||missing===times.length-1,'Only an explicitly recorded final drain timestamp may be absent');
 const known=times.filter(Number.isFinite),step=1/(Number(v.avg_frame_rate.split('/')[0])/Number(v.avg_frame_rate.split('/')[1]));
 assert.ok(known.length>100&&known.every((x,i)=>!i||Math.abs(x-known[i-1]-step)<.000003),'Stable decoded presentation cadence required');
 const dt=pk.map(x=>Number(x.dts_time));
 assert.ok(dt.every((x,i)=>Number.isFinite(x)&&(!i||Math.abs(x-dt[i-1]-step)<.000003)),'Complete stable packet DTS required');
 const e:Omit<H264AviEvidence,'checksum'>={version:'h264-avi-fullscan-v1',fingerprint,signature:h264AviSignature(probe),decoderVersion,frames:f.length,packetCount:pk.length,first:known[0],lastKnown:known.at(-1)!,missingTail:missing===-1?0:1,packetFirstDts:dt[0],packetLastDts:dt.at(-1)!,bPictures:f.filter(x=>x.pict_type==='B').length};
 return{...e,checksum:h264AviEvidenceChecksum(e)};
}
export function matchingH264AviCfrTrial(trials:ReceiverH264AviCfrTrial[]|undefined,cap:CapabilitySnapshot|undefined,probe:any,avc:boolean,fingerprint:Fingerprint){
 if(!avc||!Array.isArray(trials)||!fingerprint||!cap?.implementation?.fingerprint||cap.implementation.family!=='intel-upnp-layout'||!inputSupported(probe))return;
 const matches=trials?.filter(t=>{try{const e=t.evidence;return t.version==='receiver-h264-avi-cfr-trial-v1'&&t.enabled&&!!t.reference.trim()&&t.deviceId===cap.deviceId&&t.sinkHash===cap.sinkHash&&t.implementationFingerprint===cap.implementation!.fingerprint&&e.version==='h264-avi-fullscan-v1'&&e.fingerprint.path===fingerprint.path&&e.fingerprint.size===fingerprint.size&&e.fingerprint.mtimeMs===fingerprint.mtimeMs&&e.signature===h264AviSignature(probe)&&!!e.decoderVersion.trim()&&Number.isInteger(e.frames)&&e.frames>100&&e.packetCount===e.frames&&[0,1].includes(e.missingTail)&&Number.isFinite(e.first)&&Number.isFinite(e.lastKnown)&&e.lastKnown>e.first&&Number.isFinite(e.packetFirstDts)&&Number.isFinite(e.packetLastDts)&&e.packetLastDts>e.packetFirstDts&&Number.isInteger(e.bPictures)&&e.bPictures>=0&&e.bPictures<e.frames&&e.checksum===h264AviEvidenceChecksum(e);}catch{return false;}})??[];
 return matches.length===1?matches[0]:undefined;
}

/** Same selector as execution; no decoding or network work in diagnostics. */
export function evaluateH264AviCfrTrial(trials:ReceiverH264AviCfrTrial[]|undefined,cap:CapabilitySnapshot|undefined,probe:any,avc:boolean,fingerprint:Fingerprint){
 if(!avc)return{reason:'h264-avi-cfr-avc-required'};
 if(!inputSupported(probe))return{reason:'h264-avi-cfr-input-outside-validated-scope'};
 if(!Array.isArray(trials)||!trials.length)return{reason:'h264-avi-cfr-not-enrolled'};
 const trial=matchingH264AviCfrTrial(trials,cap,probe,avc,fingerprint);
 if(trial)return{trial,reason:'h264-avi-cfr-explicit-individual-and-fullscan-source'};
 return{reason:'h264-avi-cfr-identity-source-or-evidence-mismatch'};
}
