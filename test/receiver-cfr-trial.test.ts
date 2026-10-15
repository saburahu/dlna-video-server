import test from 'node:test';
import assert from 'node:assert/strict';
import {receiverCfrTrial,receiverCfrBinding,receiverCfrFirstTick,RECEIVER_CFR,type ReceiverCfrTrial} from '../src/receiver-cfr-trial.js';
import {jitArguments} from '../src/jit-stream.js';
import type {CapabilitySnapshot} from '../src/playback-shadow.js';
const cap:CapabilitySnapshot={deviceId:'uuid:individual',remoteIp:'192.0.2.1',controlUrl:'http://192.0.2.1/control',sink:'',sinkHash:'sink',acquiredAt:new Date().toISOString(),origin:'current-read',implementation:{version:'fixture',fingerprint:'observed-implementation'}};
const trial:ReceiverCfrTrial={version:'receiver-cfr-trial-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation!.fingerprint,reference:'Individual hardware comparison: 24 fails, 29.97 succeeds'};
const probe={format:{format_name:'avi'},streams:[{codec_type:'video',codec_name:'msmpeg4v3',avg_frame_rate:'2997/125',width:320,height:240}]};
test('receiver CFR requires exact individual and compound input evidence, never name or IP',()=>{
 assert.equal(receiverCfrTrial([trial],cap,probe,true),RECEIVER_CFR);
 assert.equal(receiverCfrTrial([trial],{...cap,remoteIp:'192.0.2.99',controlUrl:'http://192.0.2.99/control'},probe,true),RECEIVER_CFR);
 for(const c of [undefined,{...cap,deviceId:'uuid:other'},{...cap,sinkHash:'changed'},{...cap,implementation:undefined},{...cap,implementation:{version:'fixture',fingerprint:'changed'}}])assert.equal(receiverCfrTrial([trial],c,probe,true),undefined);
 for(const p of [{...probe,format:{format_name:'matroska,webm'}},{...probe,streams:[{...probe.streams[0],codec_name:'mpeg4'}]},{...probe,streams:[{...probe.streams[0],avg_frame_rate:'30000/1001'}]},{...probe,streams:[{...probe.streams[0],width:1920}]},{...probe,streams:[...probe.streams,...probe.streams]}])assert.equal(receiverCfrTrial([trial],cap,p,true),undefined);
 assert.equal(receiverCfrTrial([trial],cap,probe,false),undefined);
 assert.equal(receiverCfrTrial([trial,trial],cap,probe,true),undefined);
 assert.equal(receiverCfrTrial(undefined,cap,probe,true),undefined);
});
test('published correction binding cannot become uncorrected or cross client at Seek',()=>{
 const corrected=receiverCfrBinding('client-one',RECEIVER_CFR);
 assert.equal(corrected,receiverCfrBinding('client-one',RECEIVER_CFR));
 assert.notEqual(corrected,receiverCfrBinding('client-two',RECEIVER_CFR));
 assert.notEqual(corrected,receiverCfrBinding('client-one',undefined));
 assert.equal(receiverCfrBinding('original',undefined),'original');
});
test('receiver CFR changes only final video filter; original audio/encoder/mux arguments remain exact',()=>{
 const original=jitArguments('source.avi',2989,30),corrected=jitArguments('source.avi',2989,30,undefined,undefined,undefined,{receiverCfr:RECEIVER_CFR});
 const at=original.indexOf('-vf')+1;
 assert.equal(corrected[at],original[at]+',fps=30000/1001:round=near,trim=end=30');
 corrected[at]=original[at];assert.deepEqual(corrected,original);
 const seek={requested:120.01,anchor:{pts:10800000,index:100},firstVideoTicks:10810811,audioTrimTicks:10801920,minimumTicks:2989,policyFingerprint:'source',preRollSeconds:.12};
 const args=jitArguments('source.avi',2989,122,seek,undefined,undefined,{receiverCfr:RECEIVER_CFR});
 assert.ok(args[args.indexOf('-vf')+1].endsWith(`fps=30000/1001:round=near:start_time=${receiverCfrFirstTick(seek.firstVideoTicks)/90000},trim=end=122`));
 assert.ok(receiverCfrFirstTick(seek.firstVideoTicks)>=seek.firstVideoTicks);
 assert.ok(receiverCfrFirstTick(seek.firstVideoTicks)-seek.firstVideoTicks<3003);
});
