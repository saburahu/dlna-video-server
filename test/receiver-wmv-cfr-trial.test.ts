import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWmvVideoEvidence,receiverVideoCfrTrial,matchingReceiverWmvCfrTrial,evaluateReceiverWmvCfrTrial,WMV_RECEIVER_CFR,wmvEvidenceChecksum,type ReceiverWmvCfrTrial} from '../src/receiver-wmv-cfr-trial.js';
import {proposeWmvPermission,type WmvPermissionRequest} from '../src/wmv-permission-proposal.js';
import type {ExperimentalJitPolicy} from '../src/experimental-jit.js';
import {RECEIVER_CFR,receiverCfrBinding} from '../src/receiver-cfr-trial.js';
import {summarizeDecodedCadence} from '../src/wmv-video-inspection.js';
import {jitArguments} from '../src/jit-stream.js';
import type {CapabilitySnapshot} from '../src/playback-shadow.js';
const fingerprint={path:'generated.wmv',size:100,mtimeMs:100};
const probe={format:{format_name:'asf'},streams:[{index:2,codec_type:'video',codec_name:'wmv3',profile:'Main',pix_fmt:'yuv420p',width:704,height:396,avg_frame_rate:'24000/1001',time_base:'1/1000'},{codec_type:'audio',codec_name:'wmapro',sample_rate:'48000',channels:2}]};
const cap:CapabilitySnapshot={remoteIp:'192.0.2.10',deviceId:'uuid:synthetic-wmv',controlUrl:'http://192.0.2.10/cm',sink:'',sinkHash:'sink',origin:'current-read',acquiredAt:new Date().toISOString(),implementation:{version:'synthetic',family:'intel-upnp-layout',fingerprint:'implementation'}};
const full=summarizeDecodedCadence(Array.from({length:150},(_,i)=>({pts_time:String(Math.round(i*1001/24)/1000),interlaced_frame:0})));
const evidence=buildWmvVideoEvidence(fingerprint,probe,full,'','Synthetic decoder');
const trial:ReceiverWmvCfrTrial={version:'receiver-wmv-cfr-trial-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation!.fingerprint,reference:'Synthetic complete scan only',videoEvidence:evidence};
test('WMV CFR is separate, individually bound, fingerprinted and absent by default',()=>{
 assert.equal(receiverVideoCfrTrial(undefined,[trial],cap,probe,true,fingerprint),WMV_RECEIVER_CFR);
 assert.equal(receiverVideoCfrTrial(undefined,undefined,cap,probe,true,fingerprint),undefined);
 assert.equal(receiverVideoCfrTrial(undefined,[trial],{...cap,deviceId:'other'},probe,true,fingerprint),undefined);
 assert.equal(receiverVideoCfrTrial(undefined,[trial],{...cap,sinkHash:'other'},probe,true,fingerprint),undefined);
 assert.equal(receiverVideoCfrTrial(undefined,[trial],cap,probe,false,fingerprint),undefined);
 assert.equal(receiverVideoCfrTrial(undefined,[trial,trial],cap,probe,true,fingerprint),undefined);
 for(const f of [{...fingerprint,size:101},{...fingerprint,mtimeMs:101},{...fingerprint,path:'renamed.wmv'}])assert.equal(matchingReceiverWmvCfrTrial([trial],cap,probe,true,f),undefined);
 assert.notEqual(receiverCfrBinding('client',WMV_RECEIVER_CFR),receiverCfrBinding('client',RECEIVER_CFR));assert.notEqual(receiverCfrBinding('client',WMV_RECEIVER_CFR),receiverCfrBinding('client',undefined));
});
test('missing, interlaced, unknown or substituted evidence cannot broaden the trial',()=>{
 for(const patch of [{frames:0},{allProgressive:false},{cadence:'unknown'},{frameProbeWarnings:1},{otherIntervals:1},{backwards:1},{missing:1},{duplicates:1}]){
  const e={...evidence,...patch} as typeof evidence;e.checksum=wmvEvidenceChecksum(e);assert.equal(matchingReceiverWmvCfrTrial([{...trial,videoEvidence:e}],cap,probe,true,fingerprint),undefined);
 }
 const e={...evidence,decoderVersion:'changed'};assert.equal(matchingReceiverWmvCfrTrial([{...trial,videoEvidence:e}],cap,probe,true,fingerprint),undefined);
 for(const changed of [{...probe,format:{format_name:'avi'}},{...probe,streams:probe.streams.map(s=>s.codec_type==='video'?{...s,avg_frame_rate:'0/0'}:s)},{...probe,streams:probe.streams.map(s=>s.codec_type==='video'?{...s,codec_name:'vc1'}:s)}])assert.equal(matchingReceiverWmvCfrTrial([trial],cap,changed,true,fingerprint),undefined);
 assert.throws(()=>buildWmvVideoEvidence(fingerprint,probe,{...full,fieldKnown:0},'','decoder'));
});
test('WMV trial reuses only the proven final video filter and keeps audio/mux/encoder arguments',()=>{
 const original=jitArguments('generated.wmv',2989,30),wmv=jitArguments('generated.wmv',2989,30,undefined,undefined,undefined,{receiverCfr:WMV_RECEIVER_CFR});const at=original.indexOf('-vf')+1;
 assert.equal(wmv[at],original[at]+',fps=30000/1001:round=near,trim=end=30');wmv[at]=original[at];assert.deepEqual(wmv,original);
});

test('WMV fallback diagnostics use the same decision, never accept malformed or stale evidence',()=>{
 assert.equal(evaluateReceiverWmvCfrTrial([trial],cap,probe,true,fingerprint).trial,trial);
 for(const [trials,c,p,f,reason] of [
  [[],cap,probe,fingerprint,'wmv-cfr-not-enrolled'],
  [[trial],{...cap,sinkHash:'changed'},probe,fingerprint,'wmv-cfr-receiver-permission-mismatch'],
  [[trial],cap,probe,{...fingerprint,mtimeMs:101},'wmv-cfr-source-evidence-missing-or-stale'],
  [[trial,trial],cap,probe,fingerprint,'wmv-cfr-ambiguous-source-permission'],
  [[{...trial,videoEvidence:{...evidence,checksum:'bad'}}],cap,probe,fingerprint,'wmv-cfr-input-or-fullscan-evidence-unverified'],
  [[null],cap,probe,fingerprint,'wmv-cfr-malformed-permission-or-evidence']
 ] as const){const d=evaluateReceiverWmvCfrTrial(trials as any,c as any,p,true,f);assert.equal(d.trial,undefined);assert.equal(d.reason,reason);}
 assert.equal(evaluateReceiverWmvCfrTrial([trial],cap,probe,false,fingerprint).reason,'wmv-cfr-avc-required');
});

const pairProbe={...probe,format:{...probe.format,duration:'6.3'},executionDecoders:['wmapro'],streams:[{...probe.streams[0],index:2},...[0,1].map(index=>({index,codec_type:'audio',codec_name:'wmapro',sample_rate:'48000',channels:2,channel_layout:'stereo',time_base:'1/1000',start_time:'0',duration:'6.3'}))]};
const request:WmvPermissionRequest={operation:'video',enabled:true,reference:'Synthetic local operator review, not receiver evidence',capability:cap,fingerprint,probe:pairProbe,evidence:buildWmvVideoEvidence(fingerprint,pairProbe,full,'','Synthetic decoder'),decoderVersion:'Synthetic decoder'};
const emptyPolicy={version:'experimental-jit-v1',targetProfile:'synthetic-target',policy:{profiles:[{id:'synthetic-target',video:{value:{codec:'h264'}},audio:{value:{codec:'aac'}},transport:{value:{profileName:'AVC_TS_JP_AAC_T'}}}]},receiverCfrTrials:[{reference:'preserved AVI record'}],automaticClients:{enabled:false}} as unknown as ExperimentalJitPolicy;
test('offline proposals preserve policy, separate video/audio and retain first-source authorization',()=>{
 const original=JSON.stringify(emptyPolicy),video=proposeWmvPermission(emptyPolicy,request);
 assert.equal(JSON.stringify(emptyPolicy),original);assert.deepEqual(video.receiverCfrTrials,emptyPolicy.receiverCfrTrials);assert.equal(video.dualAudioPermissions,undefined);
 const dual=proposeWmvPermission(video,{...request,operation:'dual'});assert.equal(dual.dualAudioPermissions![0].sourceScope!.fingerprints.length,1);assert.deepEqual(dual.receiverWmvCfrTrials,video.receiverWmvCfrTrials);
 const f2={...fingerprint,path:'second-generated.wmv'},r2={...request,fingerprint:f2,evidence:buildWmvVideoEvidence(f2,pairProbe,full,'','Synthetic decoder')};
 const both=proposeWmvPermission(proposeWmvPermission(dual,r2),{...r2,operation:'dual'});
 assert.equal(both.dualAudioPermissions![0].sourceScope!.fingerprints.length,2);assert.deepEqual(both.receiverWmvCfrTrials![0],video.receiverWmvCfrTrials![0]);
 assert.throws(()=>proposeWmvPermission(both,{...request,enabled:false}),/Disable/);
 const audioOff=proposeWmvPermission(both,{...request,operation:'dual',enabled:false});assert.deepEqual(audioOff.dualAudioPermissions![0].sourceScope!.fingerprints,[f2]);
 const videoOff=proposeWmvPermission(audioOff,{...request,enabled:false});assert.equal(videoOff.receiverWmvCfrTrials!.at(-1)!.enabled,false);assert.equal(videoOff.receiverWmvCfrTrials![0].enabled,true);
});
test('offline proposals refuse unscoped receiver edits, stale runtime version, source changes and unsupported tracks',()=>{
 const video=proposeWmvPermission(emptyPolicy,request),dual=proposeWmvPermission(video,{...request,operation:'dual'});
 assert.throws(()=>proposeWmvPermission(emptyPolicy,{...request,operation:'dual'}),/video grant first/);
 assert.throws(()=>proposeWmvPermission({...emptyPolicy,targetProfile:'not-an-avc-target'},request),/AVC\/AAC only/);
 assert.throws(()=>proposeWmvPermission(video,{...request,decoderVersion:'other'}),/Decoder version changed/);
 assert.throws(()=>proposeWmvPermission(video,{...request,fingerprint:{...fingerprint,size:101}}),/Current fingerprint/);
 const unscoped=structuredClone(dual);delete unscoped.dualAudioPermissions![0].sourceScope;
 assert.throws(()=>proposeWmvPermission(unscoped,{...request,operation:'dual'}),/unscoped/);
 const disabled=structuredClone(dual);disabled.dualAudioPermissions![0].enabled=false;
 assert.throws(()=>proposeWmvPermission(disabled,{...request,operation:'dual'}),/reactivate/);
 assert.throws(()=>proposeWmvPermission(video,{...request,operation:'dual',probe:{...pairProbe,streams:[...pairProbe.streams,{...pairProbe.streams[1],index:3}]}}),/Current fingerprint/);
 const mono={...pairProbe,streams:pairProbe.streams.filter(s=>s.index!==1)},monoRequest={...request,probe:mono,evidence:buildWmvVideoEvidence(fingerprint,mono,full,'','Synthetic decoder')};
 assert.throws(()=>proposeWmvPermission(proposeWmvPermission(emptyPolicy,monoRequest),{...monoRequest,operation:'dual'}),/supported stereo WMA pair/);
});

test('59.94 intervals require a distinct explicit fullscan authorization and independently removable source grant',()=>{
 const fingerprint2={...fingerprint,path:'generated-second.wmv',size:200};
 const frames=Array.from({length:160},(_,i)=>({pts_time:String(Math.round((i<80?i*1001/24:80*1001/24+(i-80)*1001/60))/1000),interlaced_frame:0}));
 const mixed=summarizeDecodedCadence(frames);assert.ok(mixed.cadence5994>0);assert.ok(mixed.otherIntervals>0);assert.equal(mixed.otherBeyond5994,0);
 assert.throws(()=>buildWmvVideoEvidence(fingerprint2,probe,mixed,'','Synthetic decoder'));
 const evidence2=buildWmvVideoEvidence(fingerprint2,probe,mixed,'','Synthetic decoder','23976-2997-5994-v1'),trial2={...trial,videoEvidence:evidence2};
 const wma2Probe={...probe,streams:[...probe.streams.map(s=>s.codec_type==='audio'?{...s,codec_name:'wmav2'}:s),{index:1,codec_type:'audio',codec_name:'wmav2',sample_rate:'48000',channels:2}]};const wma2Evidence=buildWmvVideoEvidence(fingerprint2,wma2Probe,mixed,'','Synthetic decoder','23976-2997-5994-v1');assert.ok(matchingReceiverWmvCfrTrial([{...trial,videoEvidence:wma2Evidence}],cap,wma2Probe,true,fingerprint2));
 assert.equal(matchingReceiverWmvCfrTrial([trial2],{...cap,deviceId:'other'},probe,true,fingerprint2),undefined);
 assert.equal(matchingReceiverWmvCfrTrial([trial2],cap,probe,false,fingerprint2),undefined);
 assert.equal(matchingReceiverWmvCfrTrial([trial,trial2],cap,probe,true,fingerprint),trial);
 assert.equal(matchingReceiverWmvCfrTrial([trial,trial2],cap,probe,true,fingerprint2),trial2);
 assert.equal(matchingReceiverWmvCfrTrial([trial],cap,probe,true,fingerprint2),undefined);
 assert.equal(matchingReceiverWmvCfrTrial([trial2],cap,probe,true,fingerprint),undefined);
 for(const patch of [{cadence:'23976-or-2997-v1'},{cadence5994:0},{cadence5994:mixed.cadence5994+1},{otherIntervals:1}]){
  const e={...evidence2,...patch} as typeof evidence2;e.checksum=wmvEvidenceChecksum(e);assert.equal(matchingReceiverWmvCfrTrial([{...trial2,videoEvidence:e}],cap,probe,true,fingerprint2),undefined);
 }
 assert.throws(()=>buildWmvVideoEvidence(fingerprint2,probe,{...mixed,otherBeyond5994:1},'','decoder','23976-2997-5994-v1'));
 assert.equal(matchingReceiverWmvCfrTrial([trial2],cap,{...probe,streams:probe.streams.map(s=>s.codec_type==='video'?{...s,avg_frame_rate:'30000/1001'}:s)},true,fingerprint2),undefined);
});
