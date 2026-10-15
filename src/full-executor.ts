import assert from 'node:assert/strict';import {promises as fs,createReadStream,createWriteStream} from 'node:fs';import path from 'node:path';import {pipeline} from 'node:stream/promises';
import {ffmpeg,ffprobe,execute,commandOptions,ENCODE_RECIPE} from './prepare-executor.js';
import {negativeControlVideoArguments,negativeControlAudioArguments,negativeControlAudioTsArguments} from './experimental-negative-control.js';
import {jpInterlacedArguments} from './experimental-jp-interlaced.js';
import {buildPcrIndex} from './pcr-index.js';import {Tts192Transform} from './tts.js';
import {streamCommand} from './full-process.js';import type {FullAnalysis,FullPlan} from './full-cadence.js';
import {packetTime} from './time-seek.js';import {PCR_WRAP,timestampTicksFromPcrIndex} from './core.js';
export const FULL_TAIL_POLICY='source-end-null-pcr-v1';
export async function finishFullTransport(raw:string,file:string,a:FullAnalysis,p:FullPlan){
 let index=await buildPcrIndex(raw);assert.ok(index&&!index.discontinuities&&!index.invalidIntervals);
 const required=(p.videoEndTicks-p.firstPts)/90000,current=packetTime(index,index.packetCount);
 const padding=Math.max(0,Math.ceil((required-current)*ENCODE_RECIPE.muxrate/(188*8)));
 if(padding){const h=await fs.open(raw,'r+');try{const tail=Buffer.alloc(Math.min(188*4096,(await h.stat()).size));const r=await h.read(tail,0,tail.length,(await h.stat()).size-tail.length);assert.equal(r.bytesRead,tail.length);let cc=0;for(let i=0;i+188<=tail.length;i+=188)if((((tail[i+1]&31)<<8)|tail[i+2])===index.pid)cc=tail[i+3]&15;
 const period=Math.max(1,Math.floor(ENCODE_RECIPE.muxrate*.05/(188*8)));
 for(let start=0;start<padding;start+=4096){const count=Math.min(4096,padding-start),b=Buffer.alloc(count*188,255);for(let j=0;j<count;j++){const n=start+j,off=j*188;b[off]=0x47;b[off+1]=0x1f;b[off+2]=0xff;b[off+3]=0x10;
 if(n%period===0||n===padding-1){b[off+1]=(index.pid>>8)&31;b[off+2]=index.pid&255;b[off+3]=0x20|cc;b[off+4]=183;b[off+5]=0x10;const ticks=Math.round(timestampTicksFromPcrIndex(index.packetCount+n,index))%PCR_WRAP,base=Math.floor(ticks/300),ext=ticks%300;b[off+6]=Math.floor(base/2**25);b[off+7]=Math.floor(base/2**17)&255;b[off+8]=Math.floor(base/2**9)&255;b[off+9]=Math.floor(base/2)&255;b[off+10]=((base%2)<<7)|0x7e|(ext>>8);b[off+11]=ext&255;}}
 await h.write(b,0,b.length,index.packetCount*188+start*188);}
 }finally{await h.close();}index=await buildPcrIndex(raw);assert.ok(index&&!index.discontinuities&&!index.invalidIntervals);}
 assert.ok(packetTime(index,index.packetCount)>=required-1e-6,'Source final hold is not covered');
 await pipeline(createReadStream(raw),new Tts192Transform(0,index.averageBitrate,0,index.packetCount*192,index),createWriteStream(file,{flags:'wx'}));return {policy:FULL_TAIL_POLICY,paddingPackets:padding,sourceEndSeconds:required,transportEndSeconds:packetTime(index,index.packetCount)};
}
export function fullVideoArguments(a:FullAnalysis,p:FullPlan,output:string){const args=negativeControlVideoArguments(a.fingerprint.path,output,p.retained,a.durationSeconds);const t=args.indexOf('-t');args.splice(t,2);const vf=args.indexOf('-vf')+1;
 args[vf]=`select='lt(n,${p.sourceFrames})${p.required?`*(isnan(prev_selected_t)+gte(round(t*90000)-round(prev_selected_t*90000),${p.minimum.minimumTicks}))`:''}',`+args[vf];return args;}
export async function generateFullArtifact(a:FullAnalysis,p:FullPlan,directory:string){
 const video=path.join(directory,'video.ts'),adts=path.join(directory,'audio.aac'),audio=path.join(directory,'audio.ts'),raw=path.join(directory,'media.ts'),file=path.join(directory,'media.m2ts');
 const run=async(label:string,args:string[])=>{let progress=0;console.log(`full prepare: ${label}`);const actual=['-progress','pipe:1',...args];await streamCommand(ffmpeg(),actual,{progress:'ffmpeg',logFile:path.join(directory,label+'.log'),stdout:line=>{if(line.startsWith('out_time_us=')){const now=Number(line.split('=')[1])/1e6;if(now-progress>=60){progress=now;console.log(`${label}: ${now.toFixed(1)}s`);}}}});return args;};
 const videoArgs=await run('encode',fullVideoArguments(a,p,video));
 const audioArgs=negativeControlAudioArguments(a.fingerprint.path,adts,a.durationSeconds),t=audioArgs.indexOf('-t');audioArgs.splice(t,2);
 const samples=Math.round((a.audio.endTicks-a.audio.firstTicks)*48000/90000);audioArgs.splice(audioArgs.indexOf('-f'),0,'-af',`atrim=end_sample=${samples}`);
 await run('audio-encode',audioArgs);
 const audioMuxArgs=await run('audio-mux',negativeControlAudioTsArguments(adts,audio,a.audio.firstTicks/90000,ENCODE_RECIPE.commonShiftTicks));
 const probe=JSON.parse((await execute(ffprobe(),['-v','error','-select_streams','v:0','-show_streams','-of','json',video],{...commandOptions,timeout:30000,maxBuffer:1024*1024})).stdout);
 const first=Number(probe.streams[0].start_pts);assert.ok(Number.isSafeInteger(first));const shift=ENCODE_RECIPE.commonShiftTicks+p.firstPts-first;
 const muxArgs=await run('mux',jpInterlacedArguments(video,audio,shift,raw));
 const tail=await finishFullTransport(raw,file,a,p);
 await fs.writeFile(path.join(directory,'execution.json'),JSON.stringify({scope:'full-duration',analysis:a.fingerprint,plan:p,recipe:ENCODE_RECIPE,videoArgs,audioArgs,audioMuxArgs,muxArgs,tail}));return file;
}
/** Explicit recovery of a completed generation after a validator bug/failure. No resume or publication. */
export async function adoptCompletedGeneration(work:string,registry:string,a:FullAnalysis,p:FullPlan,directory:string){const absolute=path.resolve(work),root=path.resolve(registry,'work'),relative=path.relative(root,absolute);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Reuse work must be isolated registry/work');const e=JSON.parse(await fs.readFile(path.join(absolute,'execution.json'),'utf8'));assert.equal(e.scope,'full-duration');assert.deepEqual(e.analysis,a.fingerprint);assert.deepEqual(e.recipe,ENCODE_RECIPE);assert.equal(e.plan.selectionFingerprint,p.selectionFingerprint);assert.deepEqual(e.plan.policy,p.policy);for(const name of ['video.ts','audio.ts','audio.aac'])await fs.link(path.join(absolute,name),path.join(directory,name));await fs.copyFile(path.join(absolute,'media.ts'),path.join(directory,'media.ts'));const file=path.join(directory,'media.m2ts'),tail=await finishFullTransport(path.join(directory,'media.ts'),file,a,p);await fs.writeFile(path.join(directory,'execution.json'),JSON.stringify({...e,plan:p,tail,reusedGeneration: absolute}));return file;}
export function requiredPrepareSpace(duration:number){assert.ok(Number.isFinite(duration)&&duration>0);const artifact=Math.ceil(duration*ENCODE_RECIPE.muxrate/8*192/188);return {estimatedArtifactBytes:artifact,requiredTemporaryBytes:Math.ceil(artifact*4.5+2*1024**3),basis:'video+audio intermediates, TS, TTS, validation samples and headroom; not source deletion'};}
export async function assertPrepareSpace(directory:string,duration:number){const required=requiredPrepareSpace(duration),disk=await fs.statfs(directory),available=Number(disk.bavail)*Number(disk.bsize);assert.ok(available>=required.requiredTemporaryBytes,`Insufficient prepare disk: need ${required.requiredTemporaryBytes}, available ${available}`);return {...required,availableBytes:available};}
