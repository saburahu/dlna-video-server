import test from 'node:test';import assert from 'node:assert/strict';
import {mpeg2ColorInput,normalizedMpeg2Arguments,MPEG2_COLOR_FILTER,Mpeg2ColorDecodedAudit,Mpeg2DecodedSafetyAudit} from '../src/mpeg2-color-normalization.js';
import {mpeg2InputEligibility,mpeg2UnprocessableInput,mpeg2UnsafeInput} from '../src/mpeg2-input-scope.js';
import {mpeg2JitArguments,mpeg2Seek} from '../src/mpeg2-jit-target.js';
import {readFileSync} from 'node:fs';
const recordedArguments=JSON.parse(readFileSync(new URL('./fixtures/mpeg2-color-normalized-args.json',import.meta.url),'utf8'));const COLOR_FILTER='colorspace=iall=smpte240m:irange=pc:all=bt709:range=tv:format=yuv420p:fast=0:dither=fsb';
import {withDualAudioArguments,selectDualAudio} from '../src/jit-dual-audio.js';
const fixture=()=>({format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'1512.234667'},streams:[{index:0,codec_type:'video',codec_name:'h264',profile:'High',level:41,field_order:'progressive',width:1920,height:1080,pix_fmt:'yuvj420p',color_range:'pc',color_space:'smpte240m',color_transfer:'smpte240m',color_primaries:'smpte240m',avg_frame_rate:'24000/1001',time_base:'1/240000',start_time:'0'},...[1,2].map(index=>({index,codec_type:'audio',codec_name:'aac',profile:'LC',channels:2,channel_layout:'stereo',sample_rate:'48000',time_base:'1/48000',start_time:'0',duration:'1512.234667'}))],executionDecoders:['h264','aac']});
test('Normalized MPEG-2 admission uses only inspected technical fields and keeps raw unsafe classification',()=>{const p=fixture();assert.ok(mpeg2ColorInput(p));assert.ok(mpeg2UnsafeInput(p));assert.equal(mpeg2UnprocessableInput(p),false);assert.equal(mpeg2InputEligibility(p).reason,'bounded-mpeg2-bt709-pixel-normalization');for(const extra of [{filename:'unregistered.mp4',objectId:'other',udn:'different'},{filename:'anything.mkv',path:'/arbitrary/location'}])assert.ok(mpeg2ColorInput({...p,...extra}));});
test('Unknown, conflicting, unsupported colour/video/audio/time conditions remain rejected',()=>{for(const [key,value] of Object.entries({codec_name:'hevc',pix_fmt:'yuv420p10le',level:42,width:3840,height:2160,field_order:'tt',color_space:'unknown',color_transfer:'bt709',color_primaries:'bt709',color_range:'tv',avg_frame_rate:'30000/1001',time_base:'0/0',start_time:'NaN'})){const p=fixture();(p.streams[0] as any)[key]=value;assert.equal(mpeg2ColorInput(p),false,key);assert.ok(mpeg2UnprocessableInput(p),key);}for(const [key,value] of Object.entries({codec_name:'ac3',channels:6,sample_rate:'96000',channel_layout:'5.1',start_time:'0.1',duration:'1500'})){const p=fixture();(p.streams[1] as any)[key]=value;assert.equal(mpeg2ColorInput(p),false,key);}for(const count of [0,1,3]){const p=fixture();p.streams=[p.streams[0],...Array.from({length:count},(_,i)=>({...p.streams[1],index:i+1}))];assert.equal(mpeg2ColorInput(p),false);}});
test('Ordinary normalized dual-audio arguments reproduce receiver-tested capture, with identical clocks and no 30 second/session restriction',()=>{const p=fixture();assert.equal(MPEG2_COLOR_FILTER,COLOR_FILTER);const plan={version:'mp4-h264-two-aaclc-48k-stereo-v1' as const,targetProfile:'mpeg2-jp-pcr-split-v1',sourceSignature:'synthetic',audioIndices:[1,2],audioPids:[321,322],mpeg2:true};const expected=['-nostats',...recordedArguments],vf=expected.indexOf('-vf');expected[vf+1]=expected[vf+1].replace(MPEG2_COLOR_FILTER+',showinfo=checksum=0,','showinfo=checksum=0,'+MPEG2_COLOR_FILTER+',');assert.deepEqual(withDualAudioArguments(normalizedMpeg2Arguments(mpeg2JitArguments('synthetic.mp4',30)),plan),expected);for(const seek of [undefined,mpeg2Seek(12),mpeg2Seek(120)]){const a=withDualAudioArguments(normalizedMpeg2Arguments(mpeg2JitArguments('synthetic.mp4',1512.234667,{},seek)),plan);assert.equal(a[a.indexOf('-filter_threads')+1],'1');assert.equal(a[a.indexOf('-threads')+1],'4');assert.ok(a[a.indexOf('-vf')+1].startsWith('showinfo=checksum=0,'+MPEG2_COLOR_FILTER+','));assert.ok(a.includes('2:322'));assert.equal(Number(a[a.indexOf('-t')+1]),1512.234667-(seek?.firstVideoTicks??0)/90000);}});

import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {compactCatalogProbe} from '../src/catalog-background.js';import {openMediaIndex} from '../src/media-catalog-index.js';
test('Existing catalog enriches only old MP4 colour metadata through the header queue, retaining ObjectID and ready new metadata',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mpeg2-color-metadata-'));let db:any;t.after(async()=>{db?.close();await fs.rm(dir,{recursive:true,force:true});});const media=path.join(dir,'media');await fs.mkdir(media);const file=path.join(media,'synthetic.mp4');await fs.writeFile(file,'synthetic metadata-only media');db=await openMediaIndex(path.join(dir,'index'));await db.scan([media],dir);const row=db.page(0,1).entries[0];const p=fixture();const old=structuredClone(p);for(const s of old.streams)for(const k of ['color_range','color_space','color_transfer','color_primaries'])delete(s as any)[k];db.setMetadata(row.objectId,{path:row.path,size:row.size,mtimeMs:row.mtimeMs},old,1512.234667);assert.equal(db.probeQueue(),0);db.queueHeaderProbes();assert.equal(db.probeQueue(),1);const enriched=compactCatalogProbe(p);assert.equal(enriched.streams[0].color_space,'smpte240m');assert.ok(mpeg2ColorInput(enriched));db.setMetadata(row.objectId,{path:row.path,size:row.size,mtimeMs:row.mtimeMs},enriched,1512.234667);db.queueHeaderProbes();assert.equal(db.probeQueue(),0);assert.equal(db.page(0,1).entries[0].objectId,row.objectId);});

test('Normalized input rejects absent timestamps, contradictory depth and unverified stream side-data, including compact catalog probes',()=>{
 for(const value of [null,undefined,'',false,'N/A'])for(const index of [0,1,2]){const p:any=fixture();p.streams[index].start_time=value;assert.equal(mpeg2ColorInput(p),false);}
 for(const extra of [{bits_per_raw_sample:'10'},{side_data_list:[{side_data_type:'Mastering display metadata'}]},{side_data_list:[{side_data_type:'Display Matrix',rotation:90}]}]){const p:any=fixture();Object.assign(p.streams[0],extra);assert.equal(mpeg2ColorInput(p),false);assert.equal(mpeg2ColorInput(compactCatalogProbe(p)),false);}
});
test('Decoded colour audit sees every pre-conversion frame and fails closed on probe/decoder disagreement',()=>{
 const frame='n: 0 pts: 0 pts_time:0 fmt:yuvj420p cl:left sar:1/1 s:1920x1080 i:P iskey:1 type:I';
 const color='color_range:pc color_space:smpte240m color_primaries:smpte240m color_trc:smpte240m';
 const a=new Mpeg2ColorDecodedAudit(1920,1080);a.push(frame);a.push(color);a.finish();
 for(const bad of [color.replace('pc','tv'),color.replace(/smpte240m/g,'bt709')]){const a=new Mpeg2ColorDecodedAudit(1920,1080);a.push(frame);assert.throws(()=>a.push(bad));}
 for(const bad of [frame.replace('yuvj420p','yuv420p10le'),frame.replace('1920x1080','1280x720'),frame.replace('i:P','i:T')])assert.throws(()=>new Mpeg2ColorDecodedAudit(1920,1080).push(bad));
 const incomplete=new Mpeg2ColorDecodedAudit(1920,1080);incomplete.push(frame);assert.throws(()=>incomplete.finish());assert.throws(()=>incomplete.push(frame));
});

test('Legacy indexed H.264 colour metadata stays closed for MPEG-2 until header enrichment, without changing identity or other input families',async()=>{
 const {indexedExperimentalEntry}=await import('../src/media-catalog-index.js');
 const p:any=fixture();p.streams[0].pix_fmt='yuv420p';for(const v of p.streams)for(const k of ['color_range','color_space','color_transfer','color_primaries'])delete v[k];
 const row:any={objectId:'experimental/item/synthetic',path:'synthetic.mp4',filename:'synthetic.mp4',size:1,mtimeMs:1,availability:'available',metadata:p};
 assert.equal(mpeg2UnprocessableInput(indexedExperimentalEntry(row).lightweightProbe),true);
 row.metadata=compactCatalogProbe(fixture());const enriched=indexedExperimentalEntry(row);assert.equal(enriched.objectId,row.objectId);assert.equal(mpeg2UnprocessableInput(enriched.lightweightProbe),false);
 assert.equal(mpeg2UnprocessableInput({...p,colorMetadataVersion:0,format:{...p.format,format_name:'asf'}}),false);
});

test('Eight-bit HDR tags or mastering metadata cannot escape through ordinary MPEG-2 admission',()=>{
 for(const extra of [{color_transfer:'smpte2084'},{color_transfer:'arib-std-b67'},{color_primaries:'bt2020'},{side_data_list:[{side_data_type:'Mastering display metadata'}]}]){const p:any=fixture();Object.assign(p.streams[0],{pix_fmt:'yuv420p',color_range:'tv',color_space:'bt709',color_transfer:'bt709',color_primaries:'bt709'},extra);assert.equal(mpeg2InputEligibility(p).eligible,false);assert.equal(mpeg2UnprocessableInput(p),true);assert.equal(mpeg2UnprocessableInput(compactCatalogProbe(p)),true);}
});

test('Ordinary MPEG-2 rejects a late unsafe decoded colour or pixel-format change despite a safe initial header',()=>{
 const frame='n: 0 pts: 0 pts_time:0 fmt:yuv420p cl:left s:320x240 i:P';
 const a=new Mpeg2DecodedSafetyAudit();a.push(frame);a.push('color_range:tv color_space:bt709 color_primaries:bt709 color_trc:bt709');a.push('color_range:unknown color_space:unknown color_primaries:unknown color_trc:unknown');a.finish();
 for(const color of ['color_range:pc','color_space:smpte240m','color_primaries:bt2020','color_trc:smpte2084','color_trc:arib-std-b67'])assert.throws(()=>a.push(color));
 assert.throws(()=>a.push(frame.replace('yuv420p','yuvj420p')));assert.throws(()=>a.push(frame.replace('yuv420p','yuv420p10le')));
});

test('Interleaved audio and video av_log bodies do not reinterpret audio fltp as video pixel format',()=>{const a=new Mpeg2DecodedSafetyAudit();a.push('[Parsed_ashowinfo] n:63 pts:64512 pts_time:1.344 fmt:fltp channels:2 plane_checksums: [ n: 10 pts:120120 pts_time:0.5005 fmt:yuv420p cl:left s:320x240 i:P');assert.equal(a.frames,1);a.finish();});
