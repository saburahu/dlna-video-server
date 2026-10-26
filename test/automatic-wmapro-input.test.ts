import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {automaticWmaProInput} from '../src/automatic-wmapro-input.js';
import {automaticReceiverCfr,receiverPlaybackProfile} from '../src/receiver-playback-profile.js';
import {selectDualAudio} from '../src/jit-dual-audio.js';
import {catalogJitCandidate} from '../src/catalog-jit-candidate.js';
import {automaticClientSelection} from '../src/automatic-jit-client.js';
import {endpointFamilyFeatures,classifyClientFamily,requestFamilyFeatures,FAMILY_VERSION} from '../src/client-family.js';
import {snapshotHash} from '../src/playback-shadow.js';
const observations=JSON.parse(await fs.readFile(new URL('./fixtures/receiver-observations.json',import.meta.url),'utf8'));
const defaults=JSON.parse(await fs.readFile(new URL('../packaging/defaults/jit.json',import.meta.url),'utf8'));
const fp={path:'synthetic/unregistered.wmv',size:1234,mtimeMs:1};
function endpoint(i:number):any{const o=observations[i],features=endpointFamilyFeatures(o.descriptionXml,[o.server]),family=classifyClientFamily(features.signals),device={deviceId:'uuid:unregistered-'+i,remoteIp:'192.0.2.1',controlUrl:'http://192.0.2.1/control',descriptionUrl:'http://192.0.2.1/device',allowEmptySink:true};return {device,features,capability:{...device,sink:o.sink,sinkHash:snapshotHash(o.sink),acquiredAt:new Date().toISOString(),origin:'current-read',implementation:{version:FAMILY_VERSION,family:family.family,fingerprint:family.fingerprint},playbackProfile:receiverPlaybackProfile(o.descriptionXml,[o.server],o.sink)}};}
function probe(count=2,rate=48000,fps='24000/1001'):any{return {format:{format_name:'asf',duration:'300',start_time:'0'},executionDecoders:['wmv3','wmapro'],streams:[{index:0,codec_type:'video',codec_name:'wmv3',profile:'Main',pix_fmt:'yuv420p',width:704,height:396,field_order:'progressive',start_time:'0',avg_frame_rate:fps,r_frame_rate:fps},...Array.from({length:count},(_,i)=>({index:i+1,codec_type:'audio',codec_name:'wmapro',channels:2,channel_layout:'stereo',sample_rate:String(rate),time_base:'1/1000',start_time:'0',duration:'300'}))]};}
const admission=(p:any,c=endpoint(0).capability,records:any[]=[])=>automaticWmaProInput(p,c,'legacy-jp-observed','source-clock-v1',records,fp);
test('initial distribution policy admits bounded WMA Pro on both observed compatibility profiles without grants',()=>{
 for(const i of [0,1])for(const [count,rate,fps]of [[2,48000,'24000/1001'],[2,48000,'30000/1001'],[1,44100,'24000/1001'],[1,48000,'24000/1001']]as const){
  const ep=endpoint(i),probeValue=probe(count,rate,fps),p=structuredClone(defaults),selection=automaticClientSelection([ep],requestFamilyFeatures(observations[i].request.headers,observations[i].request.xml),p);assert.ok(selection.trial);p.targetProfile=selection.profile!.id;p.clientTrials=[selection.trial];
  const e:any={objectId:'experimental/catalog-item/'+'1'.repeat(32),filename:'unregistered.wmv',fingerprint:fp,sourceState:'cached',decisions:[],lightweightProbe:probeValue};
  assert.ok(admission(probeValue,ep.capability).eligible);assert.ok(catalogJitCandidate(e,p,ep.capability));
  const cfr=automaticReceiverCfr(ep.capability,probeValue,true);assert.equal(!!cfr,i===0);
  const dual=selectDualAudio([],ep.capability,probeValue,'legacy-jp-observed',false,true,fp,cfr);assert.equal(!!dual.plan,count===2);if(count===2)assert.deepEqual(dual.plan!.audioPids,[257,258]);
  assert.equal(p.automaticClients.wmaInputs,'source-clock-v1');assert.equal(p.wmaInputPermissions?.length??0,0);
 }
});
test('unrelated title/path/individual identity never requires source enrollment',()=>{
 for(const i of [0,1])for(const name of ['unlisted-A','unlisted-B']){const cap={...endpoint(i).capability,deviceId:'uuid:'+name};assert.ok(automaticWmaProInput(probe(),cap,'legacy-jp-observed','source-clock-v1',[],{...fp,path:'synthetic/'+name}).eligible);}
});
test('explicit disabled, stale, duplicate or malformed source exceptions cannot be bypassed',()=>{
 const cap=endpoint(0).capability,record:any={version:'wma-input-permission-v1',enabled:false,deviceId:cap.deviceId,targetProfile:'legacy-jp-observed',sourceFingerprint:fp};
 for(const records of [[record],[{...record,enabled:true,sourceFingerprint:{...fp,size:999}}],[record,record],[{...record,sourceFingerprint:undefined}],[{...record,sourceFingerprint:{...fp,path:''}}]])assert.equal(admission(probe(),cap,records).eligible,false);
 if(process.platform==='win32')assert.equal(admission(probe(),cap,[{...record,sourceFingerprint:{...fp,path:fp.path.toUpperCase().replaceAll('/','\\')}}]).eligible,false);
 assert.ok(admission(probe(),cap,[{...record,sourceFingerprint:{...fp,path:'synthetic/unrelated'}}]).eligible);
});
test('unknown receiver, recorder, target or disabled WMA policy do not gain input support',()=>{
 for(const cap of [endpoint(2).capability,{...endpoint(0).capability,playbackProfile:undefined}])assert.equal(admission(probe(),cap).eligible,false);
 assert.equal(automaticWmaProInput(probe(),endpoint(0).capability,'other-target','source-clock-v1',[],fp).eligible,false);
 assert.equal(automaticWmaProInput(probe(),endpoint(0).capability,'legacy-jp-observed',undefined,[],fp).eligible,false);
});
test('unsupported codecs/layouts/clocks and unavailable decoders are rejected with technical reasons',()=>{
 for(const mutate of [(p:any)=>p.format.format_name='avi',(p:any)=>p.streams[0].codec_name='vc1',(p:any)=>p.streams[0].profile='Complex',(p:any)=>p.streams[0].width=1920,(p:any)=>p.streams[0].field_order='tt',(p:any)=>p.streams[0].avg_frame_rate='120/1',(p:any)=>p.streams[1].channels=6,(p:any)=>p.streams[1].channel_layout='5.1',(p:any)=>p.streams[1].sample_rate='96000',(p:any)=>p.streams[2].sample_rate='44100',(p:any)=>p.streams[2].codec_name='wmav2',(p:any)=>p.streams[1].start_time='1',(p:any)=>p.streams[1].duration='301',(p:any)=>p.streams[2].index=1,(p:any)=>p.executionDecoders=['wmv3']]){const p=probe();mutate(p);const a=admission(p);assert.equal(a.eligible,false);assert.ok(a.reason);}
});
test('unknown ASF average uses nominal cadence without accepting a known contradictory rate',()=>{const p=probe();p.streams[0].avg_frame_rate='0/0';assert.ok(admission(p).eligible);p.streams[0].avg_frame_rate='25/1';assert.equal(admission(p).eligible,false);});
test('new 29.97 WMA pair does not widen an unrelated client with an old explicit dual grant',()=>{
 const cap={...endpoint(0).capability,playbackProfile:undefined},permission:any={version:'jit-dual-audio-permission-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation.fingerprint,targetProfile:'legacy-jp-observed',reference:'Existing unrelated client'};
 assert.ok(selectDualAudio([permission],cap,probe(),'legacy-jp-observed',false,true,fp).plan);
 assert.equal(selectDualAudio([permission],cap,probe(2,48000,'30000/1001'),'legacy-jp-observed',false,true,fp).plan,undefined);
});
