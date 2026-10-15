import {jitRecipeFingerprint} from '../src/jit-client-trial.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogJitCandidate} from '../src/catalog-jit-candidate.js';
import {snapshotHash} from '../src/playback-shadow.js';
import type {ExperimentalJitPolicy} from '../src/experimental-jit.js';
import type {ExperimentalEntry} from '../src/experimental-catalog.js';
import {hevcFrameSequence} from '../src/experimental-jit.js';

const evidence={status:'experimentally-confirmed' as const,reference:'fixture successful output recipe',scope:'not normative DLNA certification'};
const sink='http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T;DLNA.ORG_OP=10';
const cap={deviceId:'uuid:fixture',remoteIp:'192.168.1.2',controlUrl:'http://192.168.1.2/cm',sink,sinkHash:snapshotHash(sink),acquiredAt:new Date().toISOString(),origin:'current-read' as const};
const p:ExperimentalJitPolicy={version:'experimental-jit-v1',enabled:true,targetProfile:'target',catalogMetadataResources:true,items:[],capabilities:[cap],policy:{version:'fixture',capabilities:{encoders:[{codec:'h264',available:true},{codec:'aac',available:true}],decoders:[{codec:'hevc',available:true},{codec:'aac',available:true}]},profiles:[{
 id:'target',conformance:{status:'unknown',reference:'fixture',scope:'profile details unknown'},
 transport:{value:{container:'mpegts',framing:'jp-content-packet',mime:'video/vnd.dlna.mpeg-tts',profileName:'AVC_TS_JP_AAC_T',seek:'time'},evidence},
 video:{value:{codec:'h264',profile:'Main',level:40,codedWidth:1920,codedHeight:1088,bitDepth:8,chroma:'420',scan:'progressive',maxDpbFrames:4,maxBitrate:20e6,maxCpbBits:25e6,
 timing:{id:'target',mediaProfile:'AVC_TS_JP_AAC_T',evidence:'compatibility-experiment',maxFrameMacroblocks:8192,constraint:{codedWidth:1920,codedHeight:1088,maxMBPS:245760,minimumFrameSeconds:1/172,timebase:90000}}},evidence},
 audio:{value:{codec:'aac',format:'mpeg2-aac-lc',maxChannels:2,sampleRates:[48000],allowAbsent:false},evidence}
 }],observations:[{deviceId:cap.deviceId,sinkHash:cap.sinkHash,testedMediaCharacteristics:'bounded observed target output',observation:{profileId:'target',framing:'jp-content-packet',outcome:'success',videoCodec:'h264',videoProfile:'Main',maxLevel:40,audioFormat:'mpeg2-aac-lc',evidence}}]}};
const entry=():ExperimentalEntry=>({objectId:'experimental/item/'+'a'.repeat(32),filename:'arbitrary.mkv',fingerprint:{path:'/source/any.mkv',size:100,mtimeMs:1},sourceState:'cached',decisions:[],lightweightProbe:{format:{duration:'1800',format_name:'matroska'},streams:[{codec_type:'video',codec_name:'hevc',profile:'Main',level:123,coded_width:1920,coded_height:1080,pix_fmt:'yuv420p',field_order:'progressive'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}]}});

test('MPEG2 interlace, resample and downmix require independent transforms and decoder evidence',()=>{
 const e=entry(),probe=e.lightweightProbe;Object.assign(probe.streams[0],{codec_name:'mpeg2video',profile:'Main',level:4,field_order:'tt',width:720,height:480,coded_width:720,coded_height:480,display_aspect_ratio:'4:3'});Object.assign(probe.streams[1],{codec_name:'ac3',sample_rate:'44100',channels:6,channel_layout:'5.1'});
 assert.equal(catalogJitCandidate(e,p,cap),undefined);
 probe.executionDecoders=['mpeg2video','ac3'];const plan=catalogJitCandidate(e,p,cap)!.execution;
 assert.equal(plan.strategy,'full-transcode');assert.equal(plan.deinterlace,true);assert.equal(plan.resample,true);assert.equal(plan.channelMix,true);assert.equal(plan.aspectFit,true);assert.equal(plan.video.level,40);
 for(const kind of ['video-codec','deinterlace','audio-resample','audio-channel-mix','audio-format-normalization'])assert.ok(plan.transforms.some(t=>t.kind===kind));
 Object.assign(probe.streams[1],{channels:8});assert.equal(catalogJitCandidate(e,p,cap),undefined);
});
test('new admission rejects absent audio, unsupported pixel depth and ambiguous video streams; keeps first audio',()=>{
 const e=entry();e.lightweightProbe.streams.push({...e.lightweightProbe.streams[1],codec_name:'unknown',tags:{language:'commentary'}});assert.equal(catalogJitCandidate(e,p,cap)!.execution.sourceAudioCodec,'aac');
 e.lightweightProbe.streams=e.lightweightProbe.streams.filter((s:any)=>s.codec_type!=='audio');assert.equal(catalogJitCandidate(e,p,cap),undefined);
 const ten=entry();ten.lightweightProbe.streams[0].pix_fmt='yuv420p10le';assert.equal(catalogJitCandidate(ten,p,cap),undefined);
 const multi=entry();multi.lightweightProbe.streams.push({...multi.lightweightProbe.streams[0]});assert.equal(catalogJitCandidate(multi,p,cap),undefined);
});
test('cached metadata selects observed target through pure decision; cadence stays runtime-evaluated',()=>{
 const c=catalogJitCandidate(entry(),p,cap)!;assert.ok(c);assert.equal(c.execution.strategy,'full-transcode');assert.equal(c.execution.cadence,'runtime-evaluated');assert.equal(c.execution.sourceVideoCodec,'hevc');assert.equal(c.execution.transport.profileName,'AVC_TS_JP_AAC_T');assert.equal(c.duration,1800);
 const other=entry();other.filename='not-a-model-name.mp4';assert.deepEqual(catalogJitCandidate(other,p,cap),c);
});
test('unanalysed, stale, unknown codec/scan, unavailable observation and disabled opt-in expose no candidate',()=>{
 const e=entry();delete e.lightweightProbe;assert.equal(catalogJitCandidate(e,p,cap),undefined);
 for(const key of ['codec_name','pix_fmt','field_order']){const e=entry();e.lightweightProbe.streams[0][key]='unknown';assert.equal(catalogJitCandidate(e,p,cap),undefined);}
 const stale=entry();stale.sourceStale=true;assert.equal(catalogJitCandidate(stale,p,cap),undefined);
 assert.equal(catalogJitCandidate(entry(),{...p,catalogMetadataResources:false},cap),undefined);
 assert.equal(catalogJitCandidate(entry(),{...p,policy:{...p.policy,observations:[]}},cap),undefined);
 assert.equal(catalogJitCandidate(entry(),{...p,policy:{...p.policy,capabilities:{encoders:[],decoders:[]}}},cap),undefined);
});
test('HEVC header-known frame sequence admits transcode without claiming unknown source scan is progressive',()=>{
 const e=entry();delete e.lightweightProbe.streams[0].field_order;
 assert.equal(catalogJitCandidate(e,p,cap),undefined);
 assert.equal(hevcFrameSequence('field_seq_flag 0 = 0\nframe_field_info_present_flag 0 = 0'),'frame-sequence');
 assert.equal(hevcFrameSequence('field_seq_flag 1 = 1\nframe_field_info_present_flag 0 = 0'),undefined);
 assert.equal(hevcFrameSequence('unknown'),undefined);
 e.lightweightProbe.inputPictureStructure='frame-sequence';assert.ok(catalogJitCandidate(e,p,cap));assert.equal(e.lightweightProbe.streams[0].field_order,undefined);
});


test('legacy codec scope is metadata-driven, unknown scan is explicit deinterlace and packet audio has its own transform',()=>{
 for(const [video,audio] of [['mpeg4','mp3'],['msmpeg4v3','mp3'],['wmv1','wmav2'],['wmv2','wmav2'],['wmv3','wmapro'],['vc1','wmapro'],['wmv3','wmalossless']]){
  const e=entry(),probe=e.lightweightProbe;probe.format.format_name=video.startsWith('wmv')||video==='vc1'?'asf':'avi';
  Object.assign(probe.streams[0],{codec_name:video,width:640,height:480,coded_width:640,coded_height:480});
  for(const key of ['profile','level','field_order'])delete probe.streams[0][key];
  Object.assign(probe.streams[1],{codec_name:audio,sample_rate:'11025',channels:1});
  assert.equal(catalogJitCandidate(e,p,cap),undefined);probe.executionDecoders=[video,audio];
  const candidate=catalogJitCandidate(e,p,cap);assert.ok(candidate,video+'/'+audio);assert.ok(candidate.execution.deinterlace);assert.ok(candidate.execution.aspectFit);assert.ok(candidate.execution.reconcileAudioTimeline);assert.ok(candidate.execution.transforms.some(t=>t.kind==='audio-timeline-reconciliation'));
  const renamed=structuredClone(e);renamed.filename='unrelated-name.wmv';assert.deepEqual(catalogJitCandidate(renamed,p,cap),candidate);
 }
 const unsupported=entry();unsupported.lightweightProbe.streams[0].codec_name='indeo5';assert.equal(catalogJitCandidate(unsupported,p,cap),undefined);
});

test('explicit DRM metadata is rejected independently of codec support and filenames',()=>{
 const e=entry();e.lightweightProbe.format.tags={encryption:'ASF Extended Content Encryption'};
 assert.equal(catalogJitCandidate(e,p,cap),undefined);
 e.filename='NoDRM.mkv';assert.equal(catalogJitCandidate(e,p,cap),undefined);
});


test('empty Sink is not support: explicit UDN/snapshot/recipe trial remains diagnostic and scoped to MP4/MKV',()=>{
 const empty={...cap,deviceId:'uuid:receiver-trial',sink:'',sinkHash:snapshotHash('')};
 const trial={version:'jit-client-trial-v1' as const,enabled:true,deviceId:empty.deviceId,sinkHash:empty.sinkHash,targetProfile:p.targetProfile,
 recipeFingerprint:jitRecipeFingerprint(p.policy.profiles[0]),containers:['mp4','matroska'],reference:'test authorization'};
 const policy={...p,capabilities:[empty],clientTrials:[trial]};
 assert.equal(catalogJitCandidate(entry(),p,empty),undefined);
 for(const format of ['matroska','mov,mp4']){
  const e=entry();e.lightweightProbe.format.format_name=format;
  const candidate=catalogJitCandidate(e,policy,empty)!;assert.ok(candidate);assert.match(candidate.verification,/diagnostic-only/);
  assert.equal(candidate.decision.selected,undefined);assert.equal(candidate.decision.candidates[0].verification,'diagnostic-only');
  assert.ok(!candidate.decision.candidates[0].evidence.some(e=>e.status==='advertised'||e.status==='experimentally-confirmed'));
  assert.equal(candidate.execution.transport.profileName,'AVC_TS_JP_AAC_T');
 }
 for(const change of [{enabled:false},{deviceId:'uuid:other'},{sinkHash:'wrong'},{recipeFingerprint:'wrong'}])
  assert.equal(catalogJitCandidate(entry(),{...policy,clientTrials:[{...trial,...change}]},empty),undefined);
 const updated=structuredClone(policy);updated.policy.profiles[0].video.value.level=42;assert.equal(catalogJitCandidate(entry(),updated,empty),undefined);
 const avi=entry();avi.lightweightProbe.format.format_name='avi';assert.equal(catalogJitCandidate(avi,policy,empty),undefined);
 const corrupt=entry();corrupt.lightweightProbe.streams[0].codec_name='unknown';assert.equal(catalogJitCandidate(corrupt,policy,empty),undefined);
 assert.deepEqual(catalogJitCandidate(entry(),policy,cap),catalogJitCandidate(entry(),p,cap),'Existing observed receiver unchanged');
 const failed=structuredClone(policy);failed.policy.observations.push({...p.policy.observations[0],deviceId:empty.deviceId,sinkHash:empty.sinkHash,observation:{...p.policy.observations[0].observation,outcome:'failure'}});
 assert.equal(catalogJitCandidate(entry(),failed,empty),undefined,'Trial cannot bypass a matching failure');
});

test('malformed client trial records fail closed without breaking metadata Browse',()=>{
 const empty={...cap,deviceId:'uuid:receiver-trial',sink:'',sinkHash:snapshotHash('')};
 for(const value of [null,{},[null],[{version:'jit-client-trial-v1',enabled:true,deviceId:empty.deviceId,sinkHash:empty.sinkHash,targetProfile:p.targetProfile,recipeFingerprint:jitRecipeFingerprint(p.policy.profiles[0]),reference:'test'}]])
 assert.equal(catalogJitCandidate(entry(),{...p,clientTrials:value as any},empty),undefined);
});
