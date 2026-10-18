import test from 'node:test';import assert from 'node:assert/strict';
import {containerAacPair} from '../src/container-aac-pair.js';
import {selectDualAudio,dualAudioBinding,type DualAudioPermission} from '../src/jit-dual-audio.js';
import {compactCatalogProbe} from '../src/catalog-background.js';
const fixture=(mkv=false):any=>({format:{format_name:mkv?'matroska,webm':'mov,mp4,m4a,3gp,3g2,mj2',duration:'10'},executionDecoders:['hevc','h264','aac'],streams:[
 {index:0,codec_type:'video',codec_name:mkv?'hevc':'h264',profile:mkv?'Main':'High',pix_fmt:'yuv420p',field_order:'progressive',width:1440,height:1080,avg_frame_rate:mkv?'1000/17':'24000/1001'},
 ...[1,2].map(index=>({index,codec_type:'audio',codec_name:'aac',profile:'LC',sample_rate:'48000',channels:2,channel_layout:'stereo',time_base:mkv?'1/1000':'1/48000',start_time:'0',...(mkv?{tags:{'DURATION-eng':'00:00:10.000'}}:{duration:'10'})}))]});
test('bounded AAC pair metadata distinguishes MP4 and MKV without requiring fictional CFR',()=>{
 assert.equal(containerAacPair(fixture())?.version,'mp4-h264-two-aaclc-48k-stereo-v1');
 assert.equal(containerAacPair(fixture(true))?.version,'mkv-hevc-two-aaclc-48k-stereo-v1');
});
test('AAC scope excludes multichannel, other rate/profile/timebase, missing endpoints, wide endpoint difference and three tracks',()=>{
 for(const patch of [{channels:6},{sample_rate:'44100'},{profile:'HE-AAC'},{time_base:'1/1000'},{start_time:'0.1'},{duration:undefined},{duration:'9.9'},{codec_name:'ac3'}]){const p=fixture();Object.assign(p.streams[2],patch);assert.equal(containerAacPair(p),undefined);}
 const p=fixture();p.streams.push({...p.streams[2],index:3});assert.equal(containerAacPair(p),undefined);
 const missing=fixture(true);delete missing.streams[2].tags;assert.equal(containerAacPair(missing),undefined);
 const dup=fixture();dup.streams[2].index=1;assert.equal(containerAacPair(dup),undefined);
 assert.equal(containerAacPair({...fixture(),executionDecoders:['h264']}),undefined);
});
test('AAC scope does not generalize to unknown fps, WMV, full-range, 10bit, other video or resolution',()=>{
 for(const patch of [{avg_frame_rate:'0/0'},{avg_frame_rate:'30000/1001'},{pix_fmt:'yuvj420p'},{pix_fmt:'yuv420p10le'},{codec_name:'mpeg2video'},{width:3840},{field_order:'unknown'}]){const p=fixture();Object.assign(p.streams[0],patch);assert.equal(containerAacPair(p),undefined);}
 assert.equal(containerAacPair({...fixture(),format:{format_name:'asf',duration:'10'}}),undefined);
 const mkv=fixture(true);mkv.streams[0].field_order='unknown';assert.equal(containerAacPair(mkv),undefined);mkv.inputPictureStructure='frame-sequence';assert.ok(containerAacPair(mkv));mkv.streams[0].field_order='tt';assert.equal(containerAacPair(mkv),undefined);
});
test('AAC trial requires current compound identity/enrollment and canonical Browse GET audio binding',()=>{
 const cap:any={deviceId:'uuid:synthetic',sinkHash:'sink',implementation:{fingerprint:'implementation'}};
 const permission:DualAudioPermission={version:'jit-dual-audio-permission-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation.fingerprint,targetProfile:'avc',reference:'Synthetic test evidence'};
 const select=(p=fixture(),c=cap,permissions=[permission],bound=true)=>selectDualAudio(permissions,c,p,'avc',false,bound).plan;
 const plan=select()!;assert.deepEqual(plan.audioIndices,[1,2]);assert.deepEqual(plan.audioPids,[257,258]);
 for(const c of [{...cap,deviceId:'other'},{...cap,sinkHash:'changed'},{...cap,implementation:undefined}])assert.equal(select(fixture(),c),undefined);
 assert.equal(select(fixture(),cap,[]),undefined);assert.equal(select(fixture(),cap,[permission],false),undefined);
 const full=fixture();full.format.filename='synthetic.mp4';full.streams[0].codec_tag_string='avc1';assert.deepEqual(select(full),select(compactCatalogProbe(full)));
 const changed=fixture();changed.streams[2].duration='9.96';assert.notEqual(dualAudioBinding('client',plan),dualAudioBinding('client',select(changed)));assert.notEqual(dualAudioBinding('client',plan),dualAudioBinding('other',plan));
});
