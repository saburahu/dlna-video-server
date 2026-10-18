import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';
import {execute,ffmpeg,ffprobe} from '../src/prepare-executor.js';import {AacPipeAudit,aacPairAuditArguments} from '../src/aac-pair-audit.js';
import {jitArguments} from '../src/jit-stream.js';import {mpeg2JitArguments,mpeg2Seek} from '../src/mpeg2-jit-target.js';

test('one FFmpeg process preserves independent PCM audits and video after one/both AAC tracks end', {timeout:120000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aac-pair-pipes-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const options={windowsHide:true,timeout:30000,maxBuffer:2**20};
 for(const mode of ['both-short','one-short','equal']){
  const input=path.join(root,mode+'.mp4');const durations=mode==='both-short'?[2,2]:mode==='one-short'?[2,3.003]:[3.003,3.003];
  await execute(ffmpeg(),['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=24000/1001:duration=3.003',...durations.flatMap((d,i)=>['-f','lavfi','-i',`sine=frequency=${440+i*220}:sample_rate=48000:duration=${d}`]),'-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-profile:v','high','-pix_fmt','yuv420p','-c:a','aac','-ac','2',input],options);
  for(const mpeg of [false,true]){
   const base=mpeg?mpeg2JitArguments(input,3.003):jitArguments(input,2989,3.003),args=aacPairAuditArguments(base,mpeg?322:258),audits=[new AacPipeAudit(2/48000),new AacPipeAudit(2/48000)],bytes:Buffer[]=[];
   const child=spawn(ffmpeg(),args,{windowsHide:true,stdio:['ignore','pipe','pipe','pipe','pipe']});let errors='';const failures:unknown[]=[];
   child.stdout!.on('data',b=>bytes.push(b));child.stderr!.on('data',b=>errors=(errors+String(b)).slice(-4096));
   for(const i of [0,1])(child.stdio[i+3] as import('node:stream').Readable).on('data',b=>{try{audits[i].consume(b);}catch(e){failures.push(e);child.kill();}});
   const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,errors);assert.deepEqual(failures,[]);
   const output=path.join(root,mode+'-'+mpeg+'.ts');await fs.writeFile(output,Buffer.concat(bytes));
   const probe=JSON.parse((await execute(ffprobe(),['-v','error','-show_streams','-of','json',output],options)).stdout);assert.equal(probe.streams.filter((s:any)=>s.codec_type==='audio').length,2);
   for(const i of [0,1]){
    const standalone=await execute(ffmpeg(),['-v','error','-copyts','-i',input,'-map',`0:a:${i}`,'-af',mpeg?'aresample=48000,aformat=channel_layouts=stereo,asettb=1/48000':'asettb=1/48000','-t','3.003','-c:a','pcm_f32le','-enc_time_base:a','1/48000','-avoid_negative_ts','disabled','-f','framehash','-hash','sha256','-'],options);
    const expected=new AacPipeAudit(2/48000);expected.consume(standalone.stdout);assert.deepEqual(audits[i].summary(),expected.summary(),'Audit branch equals independent source PCM, including sample count/content');
   }
   assert.notEqual(audits[0].summary().contentDigest,audits[1].summary().contentDigest);
   const frames=JSON.parse((await execute(ffprobe(),['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=pts_time,duration_time','-of','json',output],options)).stdout).frames;
   const first=Number(frames[0].pts_time),last=Number(frames.at(-1).pts_time);assert.ok(last-first>2.9,'Video continues after shorter audio');
   const decoded=await execute(ffmpeg(),['-v','error','-i',output,'-map','0:v','-map','0:a','-f','null','-'],options);assert.equal(decoded.stderr.trim(),'');
   if(mode==='one-short'){
    const seek=mpeg2Seek(2.5),tail=mpeg?mpeg2JitArguments(input,3.003,{},seek):jitArguments(input,2989,3.003,{...seek,anchor:{pts:0,index:0},minimumTicks:2989,audioTrimTicks:225240});
    const tailAudits=[new AacPipeAudit(2/48000),new AacPipeAudit(2/48000)],tailBytes:Buffer[]=[];
    const p=spawn(ffmpeg(),aacPairAuditArguments(tail,mpeg?322:258),{windowsHide:true,stdio:['ignore','pipe','pipe','pipe','pipe']});p.stdout!.on('data',b=>tailBytes.push(b));let tailErrors='';p.stderr!.on('data',b=>tailErrors=(tailErrors+String(b)).slice(-8192));
    for(const i of [0,1])(p.stdio[i+3] as import('node:stream').Readable).on('data',b=>tailAudits[i].consume(b));
    assert.equal(await new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',resolve);}),0,tailErrors);assert.equal(tailAudits[0].finish().frames,0);assert.ok(tailAudits[1].finish().frames>0);assert.ok(Buffer.concat(tailBytes).length>188*10);
    const tailOutput=path.join(root,`one-ended-tail-${mpeg}.ts`);await fs.writeFile(tailOutput,Buffer.concat(tailBytes));
    const tailDecode=await execute(ffmpeg(),['-v','error','-i',tailOutput,'-map','0:v:0','-f','null','-'],options);assert.equal(tailDecode.stderr.trim(),'');
   }
  }
 }
});
