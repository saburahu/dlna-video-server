import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {receiverPlaybackProfile,automaticReceiverCfr} from '../src/receiver-playback-profile.js';
import {selectDualAudio} from '../src/jit-dual-audio.js';
import {wmaInputAllowed} from '../src/wma-input-scope.js';
import {scopedWmaInputPermission} from '../src/wma-input-permission.js';
import {snapshotHash,type CapabilitySnapshot} from '../src/playback-shadow.js';
const observations=JSON.parse(await fs.readFile(new URL('./fixtures/receiver-observations.json',import.meta.url),'utf8'));
const defaults=JSON.parse(await fs.readFile(new URL('../packaging/defaults/jit.json',import.meta.url),'utf8'));
function cap(i:number):CapabilitySnapshot{
 const o=observations[i];return {deviceId:'uuid:parity-'+i,remoteIp:'192.0.2.'+(i+1),controlUrl:'http://192.0.2.1/control',sink:o.sink,sinkHash:snapshotHash(o.sink),acquiredAt:new Date().toISOString(),origin:'current-read',implementation:{version:'upnp-implementation-shadow-v1',family:'intel-upnp-layout',fingerprint:'anonymous-evidence'},playbackProfile:receiverPlaybackProfile(o.descriptionXml,[o.server],o.sink)};
}
function probe(avi=false,codec=avi?'mp3':'wmav2'):any{return {format:{format_name:avi?'avi':'asf',duration:'30'},executionDecoders:[avi?'h264':'wmv3',codec],streams:[{index:0,codec_type:'video',codec_name:avi?'h264':'wmv3',profile:avi?'High':'Main',width:704,height:396,pix_fmt:'yuv420p',field_order:'progressive',avg_frame_rate:avi?'24000/1001':'0/0',r_frame_rate:'24000/1001'},...[1,2].map(index=>({index,codec_type:'audio',codec_name:codec,sample_rate:'48000',channels:2,channel_layout:'stereo',time_base:avi?'1/24000':'1/1000',start_time:'0',duration:'30'}))]};}
const fingerprint={path:'synthetic/unregistered-input.wmv',size:512,mtimeMs:1};
test('distribution defaults keep input opt-in separate from inferred receiver dual capability',()=>{
 assert.equal(defaults.automaticClients.wmaInputs,'source-clock-v1');assert.equal(defaults.automaticClients.enabled,true);
 for(const key of ['dualAudioPermissions','wmaInputPermissions','receiverWmvCfrTrials','receiverH264AviCfrTrials'])assert.equal(defaults[key]?.length??0,0);
 for(const c of [cap(0),cap(1)])for(const p of [probe(),probe(true)]){
  const audio=p.streams.find((s:any)=>s.codec_type==='audio');
  assert.equal(wmaInputAllowed(audio.codec_name,48000,2,'stereo',defaults.automaticClients.wmaInputs,p.streams[0].codec_name),true);
  for(const path of ['synthetic/new-A','synthetic/new-B','synthetic/no-title-or-grant']){
   const cfr=automaticReceiverCfr(c,p,true),dual=selectDualAudio([],c,p,'legacy-jp-observed',false,true,{...fingerprint,path},cfr);
   assert.deepEqual(dual.plan?.audioPids,[257,258]);assert.equal(dual.permission?.sourceScope,undefined);
   assert.equal(!!cfr,c.playbackProfile?.id==='regza-intel-server-cfr-v1');
  }
 }
});
test('WMA Pro has identical default rejection and symmetric explicit-input mechanics',()=>{
 const p=probe(false,'wmapro');
 for(const c of [cap(0),cap(1)]){
  assert.equal(wmaInputAllowed('wmapro',48000,2,'stereo',defaults.automaticClients.wmaInputs,'wmv3'),false);
  assert.equal(scopedWmaInputPermission([],c,'legacy-jp-observed',fingerprint,p),undefined);
  const permission={version:'wma-input-permission-v1' as const,enabled:true,deviceId:c.deviceId,sinkHash:c.sinkHash,implementationFingerprint:c.implementation!.fingerprint,targetProfile:'legacy-jp-observed',reference:'Synthetic exception; no hardware claim',sourceFingerprint:fingerprint,inputPolicy:'source-clock-v2' as const};
  assert.equal(scopedWmaInputPermission([permission],c,'legacy-jp-observed',fingerprint,p),permission);
  assert.equal(scopedWmaInputPermission([permission],c,'legacy-jp-observed',{...fingerprint,size:513},p),undefined);
  assert.equal(scopedWmaInputPermission([permission],{...c,deviceId:'uuid:other'},'legacy-jp-observed',fingerprint,p),undefined);
 }
});
test('source layout failures remain common to both profiles; CFR does not enroll invalid audio',()=>{
 for(const c of [cap(0),cap(1)])for(const change of [(p:any)=>p.streams.pop(),(p:any)=>p.streams[2].sample_rate='96000',(p:any)=>p.streams[2].channels=6,(p:any)=>p.streams[2].codec_name='mp3',(p:any)=>p.streams[0].profile='Complex']){
  const p=probe();change(p);assert.equal(selectDualAudio([],c,p,'legacy-jp-observed',false,true,fingerprint,automaticReceiverCfr(c,p,true)).plan,undefined);
 }
});
test('recorder/unknown observations do not inherit television correction or dual',()=>{
 const r=cap(2);assert.equal(r.playbackProfile,undefined);
 for(const c of [r,{...cap(0),playbackProfile:undefined}]){
  assert.equal(automaticReceiverCfr(c,probe(),true),undefined);
  assert.equal(selectDualAudio([],c,probe(),'legacy-jp-observed',false,true,fingerprint).plan,undefined);
 }
});
test('receiver and target opt-outs remain authoritative on both inferred profiles',()=>{
 for(const c of [cap(0),cap(1)]){
  const disabled={version:'jit-dual-audio-permission-v1' as const,enabled:false,deviceId:c.deviceId,sinkHash:c.sinkHash,implementationFingerprint:c.implementation!.fingerprint,targetProfile:'legacy-jp-observed',reference:'Explicit opt-out'};
  assert.equal(selectDualAudio([disabled],c,probe(),'legacy-jp-observed',false,true,fingerprint).plan,undefined);
  assert.equal(selectDualAudio([],c,probe(),'other-target',false,true,fingerprint).plan,undefined);
  assert.equal(selectDualAudio([],c,probe(),'legacy-jp-observed',false,false,fingerprint).plan,undefined);
 }
});
