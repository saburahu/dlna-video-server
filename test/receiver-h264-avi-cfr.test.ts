import test from 'node:test';
import assert from 'node:assert/strict';
import {buildH264AviEvidence,matchingH264AviCfrTrial,h264AviEvidenceChecksum,evaluateH264AviCfrTrial,H264_AVI_CFR,type ReceiverH264AviCfrTrial} from '../src/receiver-h264-avi-cfr-trial.js';
import {receiverVideoCfrTrial} from '../src/receiver-wmv-cfr-trial.js';
import {receiverCfrBinding} from '../src/receiver-cfr-trial.js';
import type {CapabilitySnapshot} from '../src/playback-shadow.js';
const fp={path:'C:\\synthetic\\sample.avi',size:1234,mtimeMs:100};
const cap:CapabilitySnapshot={deviceId:'uuid:synthetic-client',remoteIp:'192.0.2.1',controlUrl:'http://192.0.2.1/cm',sink:'',sinkHash:'sink',origin:'current-read',acquiredAt:'fixture',implementation:{version:'fixture',family:'intel-upnp-layout',fingerprint:'implementation'}};
const probe={format:{format_name:'avi'},streams:[{index:0,codec_type:'video',codec_name:'h264',profile:'High',level:51,width:704,height:396,pix_fmt:'yuv420p',field_order:'progressive',avg_frame_rate:'2997/125',time_base:'125/2997'},... [1,2].map(index=>({index,codec_type:'audio',codec_name:'mp3',sample_rate:'48000',channels:2}))]};
const frames=Array.from({length:120},(_,i)=>({media_type:'video',width:704,height:396,pix_fmt:'yuv420p',interlaced_frame:0,pict_type:i%3?'B':'P',...(i<119?{best_effort_timestamp_time:String((i+3)*125/2997)}:{})}));
const packets=frames.map((_,i)=>({stream_index:0,dts_time:String((i+2)*125/2997)}));
const evidence=buildH264AviEvidence(fp,probe,frames,packets,'synthetic decoder','');
const trial:ReceiverH264AviCfrTrial={version:'receiver-h264-avi-cfr-trial-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation!.fingerprint,reference:'Explicit synthetic experiment',evidence};
test('H264 AVI correction remains opt-in and separate from existing AVI/WMV defaults',()=>{
 assert.equal(receiverVideoCfrTrial([],[],cap,probe,true,fp),undefined);
 assert.equal(receiverVideoCfrTrial([],[],cap,probe,true,fp,[trial]),H264_AVI_CFR);
 assert.equal(receiverVideoCfrTrial([],[],cap,probe,false,fp,[trial]),undefined);
 assert.equal(matchingH264AviCfrTrial([trial,trial],cap,probe,true,fp),undefined);
 assert.equal(matchingH264AviCfrTrial([{...trial,enabled:false}],cap,probe,true,fp),undefined);
});
test('malformed enrollment fails closed and trace reasons use the execution selector',()=>{
 assert.equal(matchingH264AviCfrTrial({} as any,cap,probe,true,fp),undefined);
 assert.equal(matchingH264AviCfrTrial([trial],cap,{streams:{}},true,fp),undefined);
 for(const field of ['lastKnown','packetLastDts'] as const){const broken={...evidence,[field]:Infinity};broken.checksum=h264AviEvidenceChecksum(broken);assert.equal(matchingH264AviCfrTrial([{...trial,evidence:broken}],cap,probe,true,fp),undefined);}
 assert.equal(evaluateH264AviCfrTrial([],cap,probe,true,fp).reason,'h264-avi-cfr-not-enrolled');
 assert.ok(evaluateH264AviCfrTrial([trial],cap,probe,true,fp).trial);
});
test('individual identity, source stat, signature and evidence changes invalidate correction',()=>{
 for(const c of [undefined,{...cap,deviceId:'other'},{...cap,sinkHash:'other'},{...cap,implementation:{...cap.implementation!,fingerprint:'other'}},{...cap,implementation:{...cap.implementation!,family:'other'}}])assert.equal(matchingH264AviCfrTrial([trial],c,probe,true,fp),undefined);
 for(const f of [{...fp,path:'other'},{...fp,size:999},{...fp,mtimeMs:101}])assert.equal(matchingH264AviCfrTrial([trial],cap,probe,true,f),undefined);
 assert.equal(matchingH264AviCfrTrial([{...trial,evidence:{...evidence,frames:121}}],cap,probe,true,fp),undefined);
 assert.notEqual(receiverCfrBinding('client',H264_AVI_CFR),receiverCfrBinding('client',undefined));
});
test('no codec or multi-audio scope expansion',()=>{
 for(const p of [{...probe,format:{format_name:'asf'}},{...probe,streams:[{...probe.streams[0],codec_name:'msmpeg4v3'},...probe.streams.slice(1)]},{...probe,streams:[{...probe.streams[0],avg_frame_rate:'30000/1001'},...probe.streams.slice(1)]},{...probe,streams:[...probe.streams,probe.streams[1]]}])assert.equal(matchingH264AviCfrTrial([trial],cap,p,true,fp),undefined);
});
test('full scan preserves distinction between packet DTS and final missing decoded time',()=>{
 assert.equal(evidence.missingTail,1);assert.equal(evidence.frames,120);
 assert.notEqual(evidence.first,evidence.packetFirstDts);
 assert.throws(()=>buildH264AviEvidence(fp,probe,frames.map((x,i)=>i===50?{...x,best_effort_timestamp_time:undefined}:x),packets,'decoder',''));
 assert.throws(()=>buildH264AviEvidence(fp,probe,frames,packets.map((x,i)=>i===10?{...x,dts_time:'0'}:x),'decoder',''));
 assert.throws(()=>buildH264AviEvidence(fp,probe,frames,packets,'decoder','corrupt decoded frame'));
 assert.throws(()=>buildH264AviEvidence(fp,probe,frames.map(x=>({...x,interlaced_frame:1})),packets,'decoder',''));
});
