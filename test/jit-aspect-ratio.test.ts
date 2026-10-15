import test from 'node:test';import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execute,ffmpeg,ffprobe} from '../src/prepare-executor.js';
import {mpeg2JitArguments} from '../src/mpeg2-jit-target.js';
import {jitArguments} from '../src/jit-stream.js';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const run=promisify(execFile);
function bounds(frame:Buffer,w:number,h:number){let left=w,right=-1,top=h,bottom=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(frame[y*w+x]>128){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}return {left,right,top,bottom,width:right-left+1,height:bottom-top+1};}
const cases=[
 {name:'anamorphic16:9',w:1440,h:1080,sar:'4/3',fit:false,ratio:16/9},
 {name:'square4:3',w:640,h:480,sar:'1',fit:true,ratio:4/3},
 {name:'anamorphic4:3',w:720,h:480,sar:'8/9',fit:true,ratio:4/3},
 {name:'square16:9',w:1280,h:720,sar:'1',fit:false,ratio:16/9},
 {name:'broadcast-pillarbox-and-wide-CM',w:1440,h:1080,sar:'4/3',fit:false,ratio:16/9,pillar:true}
];
for(const c of cases)test(`actual decoded bounds and bitstream DAR preserve ${c.name} for MPEG-2 and AVC`,{timeout:60000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jit-aspect-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const source=path.join(dir,'source.mkv');
 const image=`color=white:size=${c.w}x${c.h}:rate=30000/1001,setsar=${c.sar}`+(c.pillar?",drawbox=x=0:y=0:w=180:h=1080:c=black:t=fill:enable='gte(t,1)',drawbox=x=1260:y=0:w=180:h=1080:c=black:t=fill:enable='gte(t,1)'":'');
 await execute(ffmpeg(),['-v','error','-f','lavfi','-i',image,'-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2.1','-c:v','libx264','-preset','ultrafast','-crf','18','-pix_fmt','yuv420p','-c:a','pcm_s16le',source],{windowsHide:true,timeout:30000,maxBuffer:1048576});
 for(const mpeg of [true,false]){
  const out=path.join(dir,mpeg?'mpeg.ts':'avc.ts'),args=mpeg?mpeg2JitArguments(source,2.1):jitArguments(source,2989,2.1,undefined,undefined,undefined,{aspectFit:c.fit});args[args.indexOf('pipe:1')]=out;
  await execute(ffmpeg(),args,{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});
  const probe=JSON.parse((await execute(ffprobe(),['-v','error','-select_streams','v:0','-show_streams','-of','json',out],{windowsHide:true,timeout:30000,maxBuffer:1048576})).stdout),v=probe.streams[0],w=mpeg?1440:1920,h=1080;
  assert.equal(v.width,w);assert.equal(v.height,h);assert.equal(v.display_aspect_ratio,'16:9');assert.equal(v.sample_aspect_ratio,mpeg?'4:3':'1:1');
  if(mpeg){const es=(await run(ffmpeg(),['-v','error','-i',out,'-map','0:v:0','-c:v','copy','-an','-f','mpeg2video','pipe:1'],{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,encoding:'buffer'})).stdout;const at=es.indexOf(Buffer.from([0,0,1,0xb3]));assert.ok(at>=0);assert.equal(es[at+7]>>4,3,'MPEG-2 sequence aspect_ratio_information must be 16:9');}
  const raw=(await run(ffmpeg(),['-v','error','-i',out,'-vf',"select='eq(n,0)+eq(n,35)'",'-fps_mode','passthrough','-frames:v','2','-pix_fmt','gray','-f','rawvideo','pipe:1'],{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,encoding:'buffer'})).stdout;
  assert.equal(raw.length,w*h*2);
  for(let i=0;i<2;i++){const b=bounds(raw.subarray(i*w*h,(i+1)*w*h),w,h),ratio=c.pillar&&i===1?4/3:c.ratio,expectedWidth=w*Math.min(1,ratio/(16/9));assert.ok(Math.abs(b.width-expectedWidth)<=4,`${c.name} ${mpeg?'MPEG-2':'AVC'} frame${i}: active width ${b.width}, expected ${expectedWidth}`);assert.ok(Math.abs(b.left-(w-expectedWidth)/2)<=2);assert.equal(b.height,h);}
 }
});
