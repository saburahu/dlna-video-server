import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';
import {compatibleContainerCfrInput,COMPATIBLE_CONTAINER_CFR} from '../src/compatible-container-cfr.js';
import {automaticReceiverCfr,receiverPlaybackProfile,AutomaticCfrInputAudit} from '../src/receiver-playback-profile.js';
import {receiverVideoCfrTrial} from '../src/receiver-wmv-cfr-trial.js';import {jitArguments} from '../src/jit-stream.js';import {snapshotHash,type CapabilitySnapshot} from '../src/playback-shadow.js';
const a:any={format:{format_name:'matroska,webm'},streams:[{index:0,codec_type:'video',codec_name:'wmv3',profile:'Main',pix_fmt:'yuv420p',width:640,height:480,avg_frame_rate:'2997/125',time_base:'1/1000'}, {index:1,codec_type:'audio',codec_name:'ac3',channels:6,channel_layout:'5.1(side)',sample_rate:'48000'},{index:2,codec_type:'audio',codec_name:'vorbis',channels:2,sample_rate:'48000'}]};
const b:any={format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2'},streams:[{index:0,codec_type:'video',codec_name:'h264',profile:'High',level:41,pix_fmt:'yuv420p',width:1920,height:1080,field_order:'progressive',avg_frame_rate:'24000/1001',time_base:'1/24000'},...[1,2].map(index=>({index,codec_type:'audio',codec_name:'aac',profile:'LC',channels:2,sample_rate:'48000'}))]};
const observations=JSON.parse(await fs.readFile(new URL('./fixtures/receiver-observations.json',import.meta.url),'utf8'));
function cap(renderer=false,model='Unregistered alternative model'):CapabilitySnapshot{const f=observations[renderer?1:0],xml=f.descriptionXml.replace(/<modelName>[^<]*<\/modelName>/,`<modelName>${model}</modelName>`);return {deviceId:'uuid:synthetic-'+model,remoteIp:'192.0.2.1',controlUrl:'http://192.0.2.1/control',sink:f.sink,sinkHash:snapshotHash(f.sink),acquiredAt:new Date().toISOString(),origin:'current-read',implementation:{version:'upnp-implementation-shadow-v1',family:'intel-upnp-layout',fingerprint:'synthetic-stack'},playbackProfile:receiverPlaybackProfile(xml,[f.server],f.sink)};}
test('unregistered MKV/HD MP4 technical classes use ordinary profile-based CFR',()=>{
 for(const p of [a,b])for(const model of ['Unknown-series-one','Another-unlisted-series'])assert.equal(automaticReceiverCfr(cap(false,model),p,true),COMPATIBLE_CONTAINER_CFR);
 assert.equal(compatibleContainerCfrInput(a),'wmv3-matroska-sd-24');assert.equal(compatibleContainerCfrInput(b),'h264-mp4-1080p-24');
 for(const p of [a,b]){const one=structuredClone(p);one.streams.pop();assert.equal(automaticReceiverCfr(cap(),one,true),COMPATIBLE_CONTAINER_CFR);}
 const fallback=structuredClone(b);fallback.streams[0].avg_frame_rate='0/0';fallback.streams[0].r_frame_rate='24000/1001';assert.equal(automaticReceiverCfr(cap(),fallback,true),COMPATIBLE_CONTAINER_CFR);
});
test('renderer/unknown/conflicting receiver and non-AVC path do not inherit CFR',()=>{
 for(const p of [a,b]){assert.equal(automaticReceiverCfr(cap(true),p,true),undefined);assert.equal(automaticReceiverCfr({...cap(),playbackProfile:undefined},p,true),undefined);assert.equal(automaticReceiverCfr({...cap(),implementation:undefined},p,true),undefined);assert.equal(automaticReceiverCfr(cap(),p,false),undefined);}
 const f=observations[0];assert.equal(receiverPlaybackProfile(f.descriptionXml.replace('TOSHIBA OLEDTV','TOSHIBA HDD DVD recorder'),[f.server],f.sink),undefined);
});
test('unsupported codec/rate/scan/pixels/timebase/audio are not automatically CFR',()=>{
 for(const src of [a,b])for(const mutate of [(p:any)=>p.streams[0].codec_name='vc1',(p:any)=>p.streams[0].avg_frame_rate='30000/1001',(p:any)=>p.streams[0].pix_fmt='yuv420p10le',(p:any)=>p.streams[0].field_order='tt',(p:any)=>p.streams[0].time_base='0/0',(p:any)=>p.streams[0].width=3840,(p:any)=>p.streams[1].sample_rate='96000']){const p=structuredClone(src);mutate(p);assert.equal(compatibleContainerCfrInput(p),undefined);}
 const unknown=structuredClone(b);delete unknown.streams[0].field_order;assert.equal(compatibleContainerCfrInput(unknown),undefined);
 const wm=structuredClone(a);wm.streams[1].codec_name='wmapro';assert.equal(compatibleContainerCfrInput(wm),undefined,'No WMA Pro container-input expansion');
 const level=structuredClone(b);level.streams[0].level=51;assert.equal(compatibleContainerCfrInput(level),undefined);
});
test('normal binding is required and scoped rejection still vetoes the inferred correction',()=>{
 const c=cap(),fp={path:'synthetic/arbitrary.mkv',size:10,mtimeMs:1};
 assert.equal(receiverVideoCfrTrial(undefined,undefined,c,a,true,fp,undefined,false),undefined);
 assert.equal(receiverVideoCfrTrial(undefined,undefined,c,a,true,fp,undefined,true),COMPATIBLE_CONTAINER_CFR);
 assert.equal(receiverVideoCfrTrial(undefined,[{deviceId:c.deviceId,enabled:false,videoEvidence:{fingerprint:fp}} as any],c,a,true,fp,undefined,true),undefined);
});
test('ordinary CFR matches diagnostic B fps/trim only; original audio and encoder remain identical',()=>{
 for(const t of [{aspectFit:true,deinterlace:true,channelMix:true},{}]){
  const baseline=jitArguments('synthetic.mkv',2989,12,undefined,undefined,undefined,t),normal=jitArguments('synthetic.mkv',2989,12,undefined,undefined,undefined,{...t,receiverCfr:COMPATIBLE_CONTAINER_CFR}),i=normal.indexOf('-vf')+1;
  assert.equal(normal[i],baseline[i]+',fps=30000/1001:round=near,trim=end=12');normal[i]=baseline[i];assert.deepEqual(normal,baseline);
 }
});
test('source interval/concealment is recorded; actual timeline/decode failures still reject',()=>{
 const events:number[][]=[],a=new AutomaticCfrInputAudit(0,(p,n)=>events.push([p,n]));const f=(n:number,t:number)=>`n: ${n} pts: ${t*1000} pts_time:${t} fmt:yuv420p s:640x480 i:P`;
 a.push('concealing 153 DC, 153 AC, 153 MV errors in P frame');a.push(f(0,0));a.push(f(1,.417));a.finish();assert.deepEqual(events,[[0,.417]]);assert.equal(a.maxIntervalSeconds,.417);assert.equal(a.concealmentWarnings,1);
 for(const t of [-1,0,2,7.09]){const x=new AutomaticCfrInputAudit();x.push(f(0,0));assert.throws(()=>x.push(f(1,t)));}
 const x=new AutomaticCfrInputAudit();assert.throws(()=>x.push(f(0,0).replace('i:P','i:T')));
 const y=new AutomaticCfrInputAudit();y.push('error while decoding');assert.throws(()=>y.push(f(0,0)));
});
