import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';import {Readable} from 'node:stream';
import {execute,ffmpeg,ffprobe,ENCODE_RECIPE} from '../src/prepare-executor.js';
import {inspectJitMetadata} from '../src/experimental-jit.js';import {jitArguments,newJitStats,tsPackets,normalizeJitAudio,liveTts,jpBlocks} from '../src/jit-stream.js';import {selectCompatiblePictures} from '../src/cadence-normalization.js';

for(const variant of ['mpeg2-ac3-interlaced','h264-aac-44100-mono'] as const)test(`software JIT ${variant}: real decode, frame selection, audio clock and transport`,async t=>{
 try{await execute(ffmpeg(),['-version'],{windowsHide:true,timeout:10000});}catch(e:any){if(e.code==='ENOENT'){t.skip('FFmpeg not installed');return;}throw e;}
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'jit-source-compat-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const source=path.join(directory,'input.mkv'),output=path.join(directory,'output.ts');
 const interlaced=variant==='mpeg2-ac3-interlaced';
 await execute(ffmpeg(),['-v','error','-nostdin','-f','lavfi','-i',`testsrc2=size=320x240:rate=${interlaced?'60000/1001':'30000/1001'}`,'-f','lavfi','-i',`sine=sample_rate=${interlaced?48000:44100}:frequency=440`,'-t','4',...(interlaced?['-vf','tinterlace=interleave_top','-c:v','mpeg2video','-flags','+ildct+ilme','-top','1','-c:a','ac3','-ac','2']:['-c:v','libx264','-c:a','aac','-ac','1']),source],{windowsHide:true,timeout:30000,maxBuffer:1048576});
 const st=await fs.stat(source),probe=(await inspectJitMetadata(directory,{path:source,size:st.size,mtimeMs:st.mtimeMs})).probe;
 assert.equal(probe.streams.find((s:any)=>s.codec_type==='audio').sample_rate,interlaced?'48000':'44100');
 const args=jitArguments(source,2989,4,undefined,undefined,undefined,{deinterlace:interlaced,resample:!interlaced,channelMix:!interlaced,aspectFit:true});args[args.indexOf('pipe:1')]=output;
 await execute(ffmpeg(),args,{windowsHide:true,timeout:30000,maxBuffer:2e6});
 const p=JSON.parse((await execute(ffprobe(),['-v','error','-show_packets','-show_streams','-of','json',output],{windowsHide:true,timeout:30000,maxBuffer:2e6})).stdout),v=p.streams.find((s:any)=>s.codec_type==='video'),a=p.streams.find((s:any)=>s.codec_type==='audio');
 assert.equal(v.codec_name,'h264');assert.equal(v.profile,'Main');assert.equal(v.level,40);assert.equal(v.field_order,'progressive');assert.equal(a.channels,2);assert.equal(a.sample_rate,'48000');
 const original=JSON.parse((await execute(ffprobe(),['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',source],{windowsHide:true,timeout:30000,maxBuffer:2e6})).stdout).frames.map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*90000)).filter((n:number)=>n<360000);
 const expected=selectCompatiblePictures(original,2989).retained.map(p=>p.pts),actual=p.packets.filter((p:any)=>p.stream_index===v.index).map((p:any)=>{assert.equal(p.pts,p.dts);return p.pts-ENCODE_RECIPE.commonShiftTicks;});assert.deepEqual(actual,expected);
 const stats=newJitStats();let blocks=0;for await(const block of jpBlocks(liveTts(normalizeJitAudio(tsPackets(Readable.from([await fs.readFile(output)])),stats,2989),stats))){assert.ok(block.bytes.length>14);blocks++;}assert.ok(blocks>0&&stats.audioFrames>0&&stats.videoPictures===expected.length&&stats.maxPcrMs<=51);
 const decode=await execute(ffmpeg(),['-v','error','-nostdin','-i',output,'-map','0:v:0','-map','0:a:0','-fps_mode','passthrough','-enc_time_base:v','1/90000','-f','null','-'],{windowsHide:true,timeout:30000,maxBuffer:2e6});assert.equal(decode.stderr.trim(),'');
});
