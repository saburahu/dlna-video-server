import test from 'node:test';
import assert from 'node:assert/strict';
import {selectDualAudio,dualAudioBinding,withDualAudioArguments,DualAudioClocks,type DualAudioPermission} from '../src/jit-dual-audio.js';
import {jitArguments} from '../src/jit-stream.js';
import {mpeg2JitArguments,mpeg2Seek} from '../src/mpeg2-jit-target.js';
import {sourceAudioEndpoint} from '../src/jit-segment.js';
import type {CapabilitySnapshot} from '../src/playback-shadow.js';
const cap:CapabilitySnapshot={deviceId:'uuid:tested-individual',remoteIp:'192.0.2.1',controlUrl:'http://192.0.2.1/cm',sink:'',sinkHash:'fixture',origin:'current-read',acquiredAt:new Date().toISOString(),implementation:{version:'fixture',fingerprint:'tested-implementation'}};
const permission:DualAudioPermission={version:'jit-dual-audio-permission-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation!.fingerprint,targetProfile:'avc',reference:'two-audio receiver experiment'};
const audio=(index:number)=>({index,codec_type:'audio',codec_name:'wmapro',sample_rate:'48000',channels:2,channel_layout:'stereo',time_base:'1/1000',start_time:'0.000000',duration:'100.000000'});
const probe={format:{format_name:'asf',duration:'100.000000'},executionDecoders:['wmv3','wmapro'],streams:[audio(0),audio(1),{index:2,codec_type:'video',codec_name:'wmv3',profile:'Main',width:704,height:396,avg_frame_rate:'24000/1001'}]};
const select=(p:any=probe,c=cap,records=[permission],bound=true,mpeg=false)=>selectDualAudio(records,c,p,permission.targetProfile,mpeg,bound);
test('dual audio requires compound source and exact tested individual, target, current fingerprint and binding',()=>{
 assert.equal(select().plan?.version,'wmv3-two-wmapro-48k-stereo-v1','Existing Pro plan and URL schema remain unchanged');
 assert.deepEqual(select().plan?.audioIndices,[0,1]);assert.deepEqual(select().plan?.audioPids,[257,258]);assert.deepEqual(select(probe,cap,[permission],true,true).plan?.audioPids,[321,322]);
 assert.ok(select(probe,{...cap,remoteIp:'192.0.2.99',controlUrl:'http://192.0.2.99/cm'}).plan,'Identity is not a fixed IP rule');
 for(const c of [{...cap,deviceId:'uuid:sibling'},{...cap,sinkHash:'changed'},{...cap,implementation:undefined},{...cap,implementation:{version:'fixture',fingerprint:'changed'}}])assert.equal(select(probe,c).plan,undefined);
 for(const records of [[],[permission,permission],[{...permission,enabled:false}],[{...permission,targetProfile:'different'}]])assert.equal(select(probe,cap,records).plan,undefined);
 assert.equal(select(probe,cap,[permission],false).plan,undefined);
});
test('two WMA v2 48k stereo tracks admit absent ASF masks but not explicit other layouts or untested variants',()=>{
 const p=structuredClone(probe);p.executionDecoders=['wmv3','wmav2'];for(const s of p.streams.slice(0,2)){s.codec_name='wmav2';delete (s as any).channel_layout;}
 assert.equal(select(p).plan?.version,'wmv3-two-wmav2-48k-stereo-v1');assert.deepEqual(select(p).plan?.audioPids,[257,258]);
 for(const patch of [{sample_rate:'44100'},{channels:6},{channel_layout:'2.0(side)'},{codec_name:'wmav1'},{codec_name:'wmalossless'}]){const bad=structuredClone(p);Object.assign(bad.streams[1],patch);assert.equal(select(bad).plan,undefined);}
 const pro=structuredClone(probe);delete (pro.streams[1] as any).channel_layout;assert.equal(select(pro).plan,undefined,'Missing mask exception is not generalized to Pro');
 assert.equal(select({...p,executionDecoders:['wmv3']}).plan,undefined);
 const avc=select(p).plan!,mpeg=select(p,cap,[permission],true,true).plan!;assert.ok(withDualAudioArguments(jitArguments('any.wmv',2989,5),avc).includes('2:258'));assert.ok(withDualAudioArguments(mpeg2JitArguments('any.wmv',5),mpeg).includes('2:322'));
 assert.notEqual(dualAudioBinding('client',avc),dualAudioBinding('client',select().plan));
});
test('bounded AVI High H264 and two MP3 tracks retain order with independent clocks and explicit permission',()=>{
 const p:any={format:{format_name:'avi',duration:'29.696363'},executionDecoders:['h264','mp3'],streams:[{index:0,codec_type:'video',codec_name:'h264',profile:'High',pix_fmt:'yuv420p',field_order:'progressive',width:704,height:396,avg_frame_rate:'2997/125'},...[1,2].map(index=>({index,codec_type:'audio',codec_name:'mp3',sample_rate:'48000',channels:2,channel_layout:'stereo',time_base:'1/24000',start_time:'0.000000'}))]};
 const selected=select(p).plan!;assert.equal(selected.version,'avi-h264-two-mp3-48k-stereo-v1');assert.deepEqual(selected.audioIndices,[1,2]);assert.deepEqual(selected.audioPids,[257,258]);assert.ok(withDualAudioArguments(jitArguments('fixture.avi',2989,10),selected).includes('2:258'));assert.equal(select(p,cap,[]).plan,undefined);
 for(const patch of [{codec_name:'ac3'},{sample_rate:'44100'},{time_base:'1/16000'},{channels:6},{channel_layout:undefined},{start_time:'0.041'},{duration:'20'}]){const bad=structuredClone(p);Object.assign(bad.streams[2],patch);assert.equal(select(bad).plan,undefined);}
 for(const patch of [{avg_frame_rate:'0/0'},{avg_frame_rate:'30000/1001'},{profile:'Main'},{field_order:'unknown'},{pix_fmt:'yuv420p10le'}]){const bad=structuredClone(p);Object.assign(bad.streams[0],patch);assert.equal(select(bad).plan,undefined);}
 assert.equal(select({...p,executionDecoders:['h264']}).plan,undefined);
});
test('AVI dual clocks retain the original fine source-quantum bound instead of the WMA millisecond allowance',()=>{
 const c=new DualAudioClocks([2/24000,2/24000]);assert.equal(c.tracks[0].toleranceSeconds,2/24000);c.consume('[ashowinfo@jit_audio_0 @ fixture] n:0 pts:0 pts_time:0 fmt:fltp channels:2 chlayout:stereo rate:48000 nb_samples:1024');assert.throws(()=>c.consume('[ashowinfo@jit_audio_0 @ fixture] n:1 pts:1048 pts_time:0.0218 fmt:fltp channels:2 chlayout:stereo rate:48000 nb_samples:1024'));
 assert.equal(new DualAudioClocks().tracks[0].toleranceSeconds,.003);
});
test('unverified second audio or layout falls back to first track, not a hidden resource or source-name exception',()=>{
 for(const patch of [{codec_name:'wmav2'},{sample_rate:'44100'},{channels:6},{time_base:'1/48000'},{start_time:'0.2'},{duration:'99'}]){const p=structuredClone(probe);Object.assign(p.streams[1],patch);assert.equal(select(p).plan,undefined);assert.match(select(p).reason,/secondary/);}
 for(const p of [{...probe,format:{...probe.format,format_name:'matroska'}},{...probe,executionDecoders:[]},{...probe,streams:[probe.streams[0],probe.streams[2]]},{...probe,streams:[...probe.streams,audio(3)]},{...probe,streams:[...probe.streams.slice(0,2),{...probe.streams[2],codec_name:'vc1'}]}])assert.equal(select(p).plan,undefined);
 const renamed={...probe,format:{...probe.format,filename:'arbitrary title and path.wmv'}};assert.deepEqual(select(renamed).plan,select().plan);
 assert.equal(select({...probe,streams:[probe.streams[0],probe.streams[2]]}).reason,'single-source-audio');
});
test('two-audio binding cannot silently become single, change source layout or cross identity',()=>{
 const plan=select().plan!,binding=dualAudioBinding('client-one',plan);assert.notEqual(binding,dualAudioBinding('client-one',undefined));assert.notEqual(binding,dualAudioBinding('client-two',plan));
 assert.notEqual(binding,dualAudioBinding('client-one',{...plan,audioIndices:[1,0]}));assert.equal(dualAudioBinding('unchanged',undefined),'unchanged');assert.equal(dualAudioBinding(undefined,plan),undefined);
});
for(const mpeg2 of [false,true])test(`two-audio ${mpeg2?'MPEG-2':'AVC'} keeps encoder/mux arguments, stable PIDs and the same filters in one serial graph`,()=>{
 const plan=select(probe,cap,[permission],true,mpeg2).plan!,base=mpeg2?mpeg2JitArguments('source.wmv',17,{reconcileAudioTimeline:true,sourceAudioCodec:'wmapro'},mpeg2Seek(12)):jitArguments('source.wmv',2989,17),before=[...base],args=withDualAudioArguments(base,plan);
 assert.deepEqual(base,before);assert.equal(args[args.indexOf('-filter_complex_threads')+1],'1');const graph=args[args.indexOf('-filter_complex')+1];assert.ok(graph.startsWith('[0:v:0]'+base[base.indexOf('-vf')+1]+'[jit_video];'));
 for(const i of [0,1])assert.ok(graph.includes(`[0:a:${i}]`+base[base.indexOf('-af')+1].replace('ashowinfo',`ashowinfo@jit_audio_${i}`)));
 for(const flag of ['-c:v','-g','-bf','-muxrate','-muxdelay','-output_ts_offset','-c:a','-profile:a'])assert.equal(args[args.indexOf(flag)+1],base[base.indexOf(flag)+1]);
 assert.ok(args.includes(`2:${mpeg2?322:258}`));assert.ok(!args.includes('-af')&&!args.includes('-vf'));assert.deepEqual(args.filter((_,i)=>args[i-1]==='-map'),['[jit_video]','[jit_audio_0]','[jit_audio_1]']);
});
test('both decoded source clocks independently reject gaps/missing tracks; endpoint lookup selects second track',()=>{
 const audit=new DualAudioClocks(),line=(track:number,n:number,pts:number)=>`[ashowinfo@jit_audio_${track} @ fake] n:${n} pts:${pts} pts_time:0 fmt:fltp channels:2 chlayout:stereo rate:48000 nb_samples:2048`;
 audit.consume(line(0,0,0));assert.throws(()=>audit.validate());audit.consume(line(1,0,960));audit.consume(line(0,1,2048));audit.consume(line(1,1,3008));assert.equal(audit.validate()[1].samples,4096);assert.throws(()=>audit.consume(line(1,2,6000)));
 assert.equal(sourceAudioEndpoint({streams:[{codec_type:'audio',duration:10,start_time:0},{codec_type:'audio',duration:8,start_time:1}]},1),9);
});
