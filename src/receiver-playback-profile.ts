import {compatibleContainerCfrInput,COMPATIBLE_CONTAINER_CFR} from './compatible-container-cfr.js';
import {endpointFamilyFeatures,classifyClientFamily} from './client-family.js';
import type {CapabilitySnapshot} from './playback-shadow.js';
import type {DualAudioPermission} from './jit-dual-audio.js';
import type {ReceiverCfr} from './receiver-cfr-trial.js';
import assert from 'node:assert/strict';

export const RECEIVER_PLAYBACK_VERSION='receiver-playback-profile-v2';
export interface ReceiverPlaybackProfile {
 version:typeof RECEIVER_PLAYBACK_VERSION;
 id:'regza-intel-server-cfr-v1'|'regza-intel-renderer-vfr-v1';
 evidence:readonly string[];
 verification:'inferred-compatibility-not-individual-test';
}
/** Current description + implementation + role + CM response, NOT a model/UDN
 * list. A DMS Source advertisement is never treated as a decoder Sink.
 * This is an empirical compatibility inference, not normative codec proof. */
export function receiverPlaybackProfile(xml:string,servers:readonly string[],sink:string):ReceiverPlaybackProfile|undefined {
 const manufacturer=/<(?:\w+:)?manufacturer>([^<]*)</i.exec(xml)?.[1]?.trim()??'';
 if(!/^(?:TOSHIBA(?:\s+TVS\s+REGZA)?|TVS\s+REGZA)(?:\s+CORPORATION)?$/i.test(manufacturer))return;
 const productClass=/<(?:\w+:)?modelDescription>([^<]*)</i.exec(xml)?.[1]?.trim()??'';
 // The same manufacturer/Intel DMS layout is also used by recorders.
 // Require observed TV product-class evidence, never a model-number allowlist.
 if(!/\b(?:OLEDTV|LCDTV|DTV|TELEVISION)\b/i.test(productClass)||/recorder|blu.?ray|\bHDD\b|\bDVD\b/i.test(productClass))return;
 const f=endpointFamilyFeatures(xml,servers),family=classifyClientFamily(f.signals);
 if(family.family!=='intel-upnp-layout'||family.status!=='classified')return;
 const service=(s:string)=>f.services.includes('urn:schemas-upnp-org:service:'+s+':1');
 const role=(s:string)=>f.roles.includes('urn:schemas-upnp-org:device:'+s+':1');
 const evidence=['current-description-regza-vendor','current-description-television-class','intel-stack-and-cm-service-layout','current-get-protocol-info'];
 if(role('MediaServer')&&!role('MediaRenderer')&&service('ContentDirectory')&&service('ConnectionManager')&&sink.trim()==='')return {version:RECEIVER_PLAYBACK_VERSION,id:'regza-intel-server-cfr-v1',evidence:[...evidence,'server-only-role','empty-sink-is-not-codec-proof'],verification:'inferred-compatibility-not-individual-test'};
 if(role('MediaRenderer')&&!role('MediaServer')&&service('ConnectionManager')&&service('AVTransport')&&service('RenderingControl')&&sink.split(',').some(s=>/^http-get:\*:(?:video\/vnd\.dlna\.mpeg-tts|video\/mpeg):/.test(s)&&/(?:^|;)DLNA\.ORG_PN=AVC_TS_JP_AAC_T(?:;|$)/.test(s.split(':').slice(3).join(':'))))return {version:RECEIVER_PLAYBACK_VERSION,id:'regza-intel-renderer-vfr-v1',evidence:[...evidence,'renderer-avtransport-renderingcontrol','sink-avc-ts-jp-aac'],verification:'inferred-compatibility-not-individual-test'};
}
export function automaticDualAudioPermission(cap:CapabilitySnapshot|undefined,target:string,mpeg2:boolean):DualAudioPermission|undefined {
 if(mpeg2||target!=='legacy-jp-observed'||!cap?.playbackProfile||cap.playbackProfile.version!==RECEIVER_PLAYBACK_VERSION||!['regza-intel-server-cfr-v1','regza-intel-renderer-vfr-v1'].includes(cap.playbackProfile.id)||cap.implementation?.family!=='intel-upnp-layout')return;
 return {version:'jit-dual-audio-permission-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation.fingerprint,targetProfile:target,reference:'Automatic '+cap.playbackProfile.id+'; inferred compatibility; source eligibility checked per request'};
}
/** Metadata eligibility is only the first gate. Pre-CFR decoded timestamps and
 * decoder errors are audited during GET, so fps cannot conceal input gaps. */
export function automaticReceiverCfr(cap:CapabilitySnapshot|undefined,p:any,avc:boolean):ReceiverCfr|undefined {
 if(!avc||cap?.playbackProfile?.version!==RECEIVER_PLAYBACK_VERSION||cap.playbackProfile.id!=='regza-intel-server-cfr-v1'||cap.implementation?.family!=='intel-upnp-layout')return;
 if(compatibleContainerCfrInput(p))return COMPATIBLE_CONTAINER_CFR;
 const videos=p?.streams?.filter((s:any)=>s.codec_type==='video')??[],v=videos[0],audios=p?.streams?.filter((s:any)=>s.codec_type==='audio')??[];
 if(videos.length!==1||!(v.width>0&&v.width<=720&&v.height>0&&v.height<=576)||v.pix_fmt!=='yuv420p'||!['progressive','unknown',undefined].includes(v.field_order)||!audios.length||audios.length>2)return;
 const rate=v.avg_frame_rate==='0/0'||v.avg_frame_rate===undefined?v.r_frame_rate:v.avg_frame_rate;
 const [n,d]=String(rate).split('/').map(Number),wmaPro=audios.every((a:any)=>a.codec_name==='wmapro');
 if(!Number.isFinite(n/d)||!(wmaPro&&p.format?.format_name==='asf'?[24000/1001,30000/1001]:[24000/1001]).some(r=>Math.abs(n/d-r)<.002))return;
 if(!audios.every((a:any)=>(wmaPro&&audios.length===1?[44100,48000].includes(Number(a.sample_rate)):Number(a.sample_rate)===48000)&&a.channels===2))return;
 if(p.format?.format_name==='asf'&&v.codec_name==='wmv3'&&v.profile==='Main'&&audios.every((a:any)=>['wmav2','wmapro'].includes(a.codec_name)))return 'receiver-wmv3-cfr-30000-1001-trial-v1';
 if(p.format?.format_name==='avi'&&v.field_order==='progressive'&&audios.every((a:any)=>a.codec_name==='mp3')){
  if(v.codec_name==='h264'&&v.profile==='High')return 'receiver-h264-avi-cfr-30000-1001-trial-v1';
  if(v.codec_name==='msmpeg4v3')return 'receiver-cfr-30000-1001-v1';
 }
}
export class AutomaticCfrInputAudit {
 frames=0;last:number|undefined;concealmentWarnings=0;preRollDecodeWarnings=0;maxIntervalSeconds=0;intervalsOver100ms=0;
 private pendingDecodeError=false;
 constructor(readonly presentationStart=0,private readonly interval?:(previous:number,current:number)=>void){}
 finish(){assert.ok(this.frames>0,'No audited input pictures');assert.ok(!this.pendingDecodeError,'Unresolved terminal video decode failure');}
 push(line:string){
  const audioDiagnostic=/\[aist#|\[dec:(?:mp3|aac|wma)/i.test(line);
  // Concealment is a pixel-quality warning, not proof of a missing frame.
  // Preserve it for diagnostics; actual input/output timing audits still apply.
  if(!audioDiagnostic&&/concealing\s+\d+|corrupt decoded frame/i.test(line))this.concealmentWarnings++;
  if(!audioDiagnostic&&/error while decoding|invalid data found/i.test(line))this.pendingDecodeError=true;
  // av_log prefixes and filter bodies may be on different lines, and multiple
  // bodies can share one line. Recognize the complete video body, never an
  // audio n:/pts: counter. Sequence/PTS validation remains strict below.
  for(const record of line.split(/(?=\bn:\s*\d+\s+pts:)/)){
  if(!/^n:\s*\d+\s+pts:/.test(record)||! /\bs:\d+x\d+\b/.test(record))continue;
  const m=/^n:\s*(\d+)\s+pts:\s*\S+\s+pts_time:(\S+).*?\bi:([PTB])/.exec(record);
  assert.ok(m,'Automatic CFR requires known progressive input PTS');
  assert.equal(Number(m[1]),this.frames++,'Input frame audit sequence');assert.equal(m[3],'P','Interlaced input outside automatic CFR scope');
  const t=Number(m[2]);assert.ok(Number.isFinite(t));
  if(this.pendingDecodeError){assert.ok(t<this.presentationStart,'Automatic CFR refuses a decode failure in the retained presentation range');this.preRollDecodeWarnings++;this.pendingDecodeError=false;}
  if(this.last!==undefined){assert.ok(t>this.last&&t-this.last<2,'Input PTS reversal/duplicate/gap: CFR must not hide missing pictures');this.maxIntervalSeconds=Math.max(this.maxIntervalSeconds,t-this.last);if(t-this.last>.1){this.intervalsOver100ms++;this.interval?.(this.last,t);}}
  this.last=t;
  }
 }
}
