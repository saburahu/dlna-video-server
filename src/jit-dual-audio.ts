import assert from 'node:assert/strict';
import {snapshotHash,type CapabilitySnapshot} from './playback-shadow.js';
import {JitAudioClock} from './jit-audio-clock.js';
import {containerAacPair} from './container-aac-pair.js';
import {aacPairAuditArguments} from './aac-pair-audit.js';

/** Operator enrollment of a tested individual/target; never family-wide defaults. */
export interface DualAudioPermission {
 version:'jit-dual-audio-permission-v1';enabled:boolean;deviceId:string;sinkHash:string;
 implementationFingerprint:string;targetProfile:string;reference:string;
}
export interface DualAudioPlan {
 version:'wmv3-two-wmapro-48k-stereo-v1'|'wmv3-two-wmav2-48k-stereo-v1'|'avi-h264-two-mp3-48k-stereo-v1'|'mp4-h264-two-aaclc-48k-stereo-v1'|'mkv-hevc-two-aaclc-48k-stereo-v1';targetProfile:string;mpeg2:boolean;
 sourceSignature:string;audioIndices:number[];audioPids:number[];
}
export function selectDualAudio(permissions:readonly DualAudioPermission[]|undefined,cap:CapabilitySnapshot|undefined,probe:any,targetProfile:string,mpeg2:boolean,bound:boolean){
 const no=(reason:string)=>({plan:undefined as DualAudioPlan|undefined,permission:undefined as DualAudioPermission|undefined,reason});
 const audio=probe?.streams?.filter((s:any)=>s.codec_type==='audio')??[],videos=probe?.streams?.filter((s:any)=>s.codec_type==='video')??[];
 if(audio.length<2)return no('single-source-audio');
 if(!bound||!cap?.deviceId||!cap.implementation?.fingerprint)return no('dual-audio-current-client-binding-required');
 const records=(permissions??[]).filter(p=>p.deviceId===cap.deviceId&&p.targetProfile===targetProfile);
 if(records.length!==1||!records[0].enabled)return no('receiver-target-not-enrolled-for-dual-audio');
 const permission=records[0];
 if(permission.version!=='jit-dual-audio-permission-v1'||!permission.reference?.trim()||permission.sinkHash!==cap.sinkHash||permission.implementationFingerprint!==cap.implementation.fingerprint)return no('dual-audio-permission-evidence-mismatch');
 if(audio.length!==2||videos.length!==1||new Set(probe.streams.map((s:any)=>s.index)).size!==probe.streams.length||!probe.streams.every((s:any)=>Number.isSafeInteger(s.index)&&s.index>=0))return no('dual-audio-stream-layout-unverified');
 const pair=containerAacPair(probe);
 if(pair){
  const v=videos[0],sourceSignature=snapshotHash(JSON.stringify({scope:pair.version,format:{name:probe.format.format_name,duration:Number(probe.format.duration)},video:{index:v.index,codec:v.codec_name,profile:v.profile,pixels:v.pix_fmt,width:v.width,height:v.height,field:v.field_order,rate:v.avg_frame_rate,frameSequence:probe.inputPictureStructure},audio:audio.map((s:any)=>({index:s.index,codec:s.codec_name,profile:s.profile,rate:Number(s.sample_rate),channels:s.channels,layout:s.channel_layout,timebase:s.time_base,start:Number(s.start_time)})),endpoints:pair.endpoints}));
  const plan:DualAudioPlan={version:pair.version,targetProfile,mpeg2,sourceSignature,audioIndices:audio.map((s:any)=>s.index),audioPids:mpeg2?[321,322]:[257,258]};
  return {plan,permission,reason:'explicit-tested-individual-and-bounded-aac-pair-trial'};
 }
 const v=videos[0],[n,d]=String(v.avg_frame_rate??v.r_frame_rate).split('/').map(Number),duration=Number(probe.format?.duration);
 const avi=probe.format?.format_name==='avi'&&v.codec_name==='h264'&&v.profile==='High'&&v.pix_fmt==='yuv420p'&&v.field_order==='progressive';
 const wmv=probe.format?.format_name==='asf'&&v.codec_name==='wmv3'&&v.profile==='Main'&&['unknown','progressive',undefined].includes(v.field_order);
 if((!wmv&&!avi)||!(v.width>0&&v.width<=720&&v.height>0&&v.height<=576)||Math.abs(n/d-24000/1001)>.002||!Number.isFinite(n/d)||!Number.isFinite(duration)||duration<=0)return no('dual-audio-video-container-scope-unverified');
 const codec=audio[0].codec_name;
 // WMA v2 ASF headers often omit a channel mask. The tested two-channel decoder
 // output is stereo; do not reinterpret an explicit different layout or admit
 // mixed codecs, multichannel, other rates or other WMA variants.
 if(!(avi?codec==='mp3':['wmapro','wmav2'].includes(codec))||!audio.every((s:any)=>s.codec_name===codec&&Number(s.sample_rate)===48000&&s.channels===2&&(s.channel_layout==='stereo'||codec==='wmav2'&&s.channel_layout===undefined)&&s.time_base===(avi?'1/24000':'1/1000')&&Number.isFinite(Number(s.start_time))&&Math.abs(Number(s.start_time))<=.003&&(avi&&s.duration===undefined||Number.isFinite(Number(s.duration))&&Math.abs(Number(s.duration)-duration)<=.064)))return no('dual-audio-secondary-codec-or-clock-scope-unverified');
 if(!probe.executionDecoders?.includes(codec)||avi&&!probe.executionDecoders?.includes('h264'))return no('dual-audio-decoder-not-verified');
 const sourceSignature=snapshotHash(JSON.stringify({format:probe.format.format_name,duration,video:{codec:v.codec_name,profile:v.profile,width:v.width,height:v.height,rate:v.avg_frame_rate??v.r_frame_rate},audio:audio.map((s:any)=>({index:s.index,codec:s.codec_name,rate:s.sample_rate,channels:s.channels,layout:s.channel_layout,timebase:s.time_base,start:s.start_time,duration:s.duration}))}));
 const plan:DualAudioPlan={version:avi?'avi-h264-two-mp3-48k-stereo-v1':codec==='wmav2'?'wmv3-two-wmav2-48k-stereo-v1':'wmv3-two-wmapro-48k-stereo-v1',targetProfile,mpeg2,sourceSignature,audioIndices:audio.map((s:any)=>s.index),audioPids:mpeg2?[321,322]:[257,258]};
 return {plan,permission,reason:'explicit-tested-individual-and-bounded-source-layout'};
}
export function dualAudioBinding(binding:string|undefined,plan:DualAudioPlan|undefined){return binding&&plan?snapshotHash(JSON.stringify({binding,dualAudio:plan})):binding;}

/** Existing AVI/WMA uses one serial graph; AAC uses independent pipe-audited graphs. Named
 * per-track audits cannot interleave with another filter graph's stderr writes.
 * Source language tags are logged as metadata only; no spoken-language or
 * commentary role is inferred. Retain the tested und/und descriptors. */
export function withDualAudioArguments(original:readonly string[],plan:DualAudioPlan){
 if(plan.version.includes('aaclc')){
  assert.ok(['mp4-h264-two-aaclc-48k-stereo-v1','mkv-hevc-two-aaclc-48k-stereo-v1'].includes(plan.version));assert.equal(plan.audioIndices.length,2);assert.deepEqual(plan.audioPids,plan.mpeg2?[321,322]:[257,258]);
  return aacPairAuditArguments(original,plan.audioPids[1]);
 }
 assert.ok(['wmv3-two-wmapro-48k-stereo-v1','wmv3-two-wmav2-48k-stereo-v1','avi-h264-two-mp3-48k-stereo-v1'].includes(plan.version));assert.equal(plan.audioIndices.length,2);assert.deepEqual(plan.audioPids,plan.mpeg2?[321,322]:[257,258]);
 const args=[...original],vf=args[args.indexOf('-vf')+1],af=args[args.indexOf('-af')+1];assert.ok(vf&&af&&af.includes('ashowinfo'));assert.ok(args.includes('0:v:0')&&args.includes('0:a:0'));
 args.splice(args.indexOf('-vf'),2);args.splice(args.indexOf('-af'),2);
 args[args.indexOf('0:v:0')]='[jit_video]';args[args.indexOf('0:a:0')]='[jit_audio_0]';
 args.splice(args.indexOf('[jit_audio_0]')+1,0,'-map','[jit_audio_1]');
 const graph=`[0:v:0]${vf}[jit_video];`+[0,1].map(i=>`[0:a:${i}]${af.replace('ashowinfo',`ashowinfo@jit_audio_${i}`)}[jit_audio_${i}]`).join(';');
 args.splice(args.indexOf('-f'),0,'-filter_complex_threads','1','-filter_complex',graph,'-streamid',`2:${plan.audioPids[1]}`,'-metadata:s:a:0','language=und','-metadata:s:a:1','language=und');
 return args;
}
export class DualAudioClocks {
 readonly tracks:JitAudioClock[];
 constructor(tolerances:readonly number[]=[.003,.003]){assert.equal(tolerances.length,2);assert.ok(tolerances.every(v=>v>0&&v<=.003));this.tracks=tolerances.map(v=>new JitAudioClock(48000,v));}
 consume(line:string){for(const m of line.matchAll(/ashowinfo@jit_audio_([01]) @ [^\]]+\] n:(\d+) pts:([\d+-]+) pts_time:\S+ fmt:\S+ channels:\d+ chlayout:\S+ rate:(\d+) nb_samples:(\d+)/g)){const c=this.tracks[Number(m[1])];assert.equal(Number(m[2]),c.frames,'Per-track audio audit sequence');c.push(Number(m[3])/c.sampleRate,Number(m[5]),Number(m[4]));}}
 validate(endedBeforeRequest:boolean[]=[false,false]){this.tracks.forEach((c,i)=>assert.ok(c.frames>0||endedBeforeRequest[i],'Missing per-track decoded sample clock'));return this.tracks;}
}
