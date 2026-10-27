import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {execute,ffmpeg,ffprobe} from './prepare-executor.js';
import {mpeg2JitArguments,MPEG2_MEDIA_SHIFT} from './mpeg2-jit-target.js';
import {withDualAudioArguments} from './jit-dual-audio.js';
import {tsPackets,normalizeJitAudio,liveTts,newJitStats} from './jit-stream.js';
import {splitPcrPackets} from './split-ts-pcr.js';
import {TsStabilityAudit} from './ts-stability-audit.js';
import {AacPipeAudit} from './aac-pair-audit.js';
import {validateJitSegmentEnd} from './jit-segment.js';
import {AutomaticCfrInputAudit} from './receiver-playback-profile.js';
import {inspectMpeg2Startup} from './dbr-color-headers.js';

export const COLOR_FILTER='colorspace=iall=smpte240m:irange=pc:all=bt709:range=tv:format=yuv420p:fast=0:dither=fsb';
export const COLOR_RECIPE='dbr-isolated-color-30s-v1';
export const COLOR_REQUIRED_BYTES=1024**3;
export const COLOR_ASSET_BUDGET=512*1024**2;
async function executable(command:string){for(const candidate of path.isAbsolute(command)?[command]:(process.env.PATH??'').split(path.delimiter).map(p=>path.join(p,process.platform==='win32'&&!command.endsWith('.exe')?command+'.exe':command))){try{return await fs.realpath(candidate);}catch{}}throw Error('Executable not found: '+command);}
export interface ColorAsset {file:string;sha256:string;size:number;source:string;sourceHash:string;sourceSize:number;sourceMtime:number;seconds:number;wireBytes:number;audit:any}
export async function fileHash(file:string,signal?:AbortSignal){const h=createHash('sha256');for await(const b of createReadStream(file)){signal?.throwIfAborted();h.update(b);}return h.digest('hex');}
export function assertColorInput(p:any){
 const v=p?.streams?.filter((s:any)=>s.codec_type==='video')??[],a=p?.streams?.filter((s:any)=>s.codec_type==='audio')??[];
 assert.ok(/(?:^|,)mp4(?:,|$)/.test(p?.format?.format_name??''),'MP4 required');
 assert.equal(v.length,1);const s=v[0];
 assert.ok(s.codec_name==='h264'&&['High','Main'].includes(s.profile)&&s.level<=41&&s.field_order==='progressive','Inspected progressive AVC Main/High <=4.1 only');
 assert.ok([s.width,s.height].every((n:number)=>Number.isSafeInteger(n)&&n>0&&n%2===0)&&s.width<=1920&&s.height<=1080);
 const [n,d]=String(s.avg_frame_rate).split('/').map(Number);assert.ok(Math.abs(n/d-24000/1001)<.001,'Inspected 23.976fps source only');
 assert.ok(['yuv420p','yuvj420p'].includes(s.pix_fmt)&&s.color_range==='pc'&&[s.color_space,s.color_transfer,s.color_primaries].every(x=>x==='smpte240m'),'Explicit full-range SMPTE240M input required');
 assert.equal(a.length,2);assert.ok(a.every((x:any)=>x.codec_name==='aac'&&x.profile==='LC'&&x.channels===2&&Number(x.sample_rate)===48000&&x.time_base==='1/48000'&&Math.abs(Number(x.start_time))<=.003),'Two zero-origin AAC LC stereo 48kHz tracks required');
 assert.ok(Math.abs(Number(s.start_time))<=.003&&Number(p.format.duration)>34,'Zero-origin source >34s required');
}
export function colorArguments(source:string,p:any,seconds=30){
 assertColorInput(p);let a=mpeg2JitArguments(source,seconds);
 a[a.indexOf('-vf')+1]=COLOR_FILTER+','+a[a.indexOf('-vf')+1];
 a.splice(a.indexOf('-c:v'),0,'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv');
 a=withDualAudioArguments(a,{version:'mp4-h264-two-aaclc-48k-stereo-v1',targetProfile:'mpeg2-jp-pcr-split-v1',sourceSignature:'isolated-preparation',audioIndices:p.streams.filter((s:any)=>s.codec_type==='audio').map((s:any)=>s.index) as [number,number],audioPids:[321,322],mpeg2:true});
 return ['-filter_threads','1',...a];
}
const within=(root:string,file:string)=>{const r=path.relative(root,file);return r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);};
export async function verifyColorAsset(a:ColorAsset,signal?:AbortSignal){
 const s=await fs.stat(a.source),t=await fs.stat(a.file);assert.ok(s.size===a.sourceSize&&s.mtimeMs===a.sourceMtime&&t.size===a.size,'Source/asset changed');
 assert.equal(await fileHash(a.source,signal),a.sourceHash,'Source hash changed');assert.equal(await fileHash(a.file,signal),a.sha256,'Asset hash changed');
}
/** Never called by normal JIT. No generated asset is publishable until every audit finishes. */
export async function prepareColorAsset(source:string,directory:string,roots:string[],signal:AbortSignal,progress:(v:any)=>void):Promise<ColorAsset>{
 signal=AbortSignal.any([signal,AbortSignal.timeout(600000)]);
 const canonical=await fs.realpath(source),canonicalRoots=await Promise.all(roots.map(r=>fs.realpath(r)));
 await fs.mkdir(directory,{recursive:true});directory=await fs.realpath(directory);
 assert.ok(canonicalRoots.some(r=>within(r,canonical))&&!canonicalRoots.some(r=>within(r,directory)||r===directory),'Separate non-library asset directory required');
 const disk=await fs.statfs(directory);assert.ok(Number(disk.bavail)*Number(disk.bsize)>=COLOR_REQUIRED_BYTES,'At least 1GiB free required');
 // A new preparation replaces old generated media, retaining every recipe/audit/log.
 for(const name of await fs.readdir(directory))if(/^[a-f0-9-]{36}$/.test(name)){const previous=path.join(directory,name);if(!within(directory,await fs.realpath(previous)))continue;try{const recipe=JSON.parse(await fs.readFile(path.join(previous,'recipe.json'),'utf8'));if(recipe.recipe===COLOR_RECIPE)for(const media of ['clip.ts','clip.tts'])await fs.unlink(path.join(previous,media)).catch(()=>{});}catch{}}
 let stored=0;for(const name of await fs.readdir(directory))if(/^[a-f0-9-]{36}$/.test(name)){const info=await fs.stat(path.join(directory,name,'clip.tts')).catch(()=>undefined);stored+=info?.size??0;}assert.ok(stored+64*1024**2<=COLOR_ASSET_BUDGET,'Prepared trial asset budget (512MiB) exceeded; remove obsolete trial media before preparing again');
 const began=performance.now(),id=randomUUID(),dir=path.join(directory,id);await fs.mkdir(dir);const raw=path.join(dir,'clip.ts'),file=path.join(dir,'clip.tts');
 let child:ReturnType<typeof spawn>|undefined,stderr='';
 try{
  progress({phase:'hash-source',requiredBytes:COLOR_REQUIRED_BYTES});const original=await fs.stat(canonical),sourceHash=await fileHash(canonical,signal);signal.throwIfAborted();
  const options={windowsHide:true,signal,maxBuffer:8*1024**2,timeout:600000};
  const encoder=await executable(ffmpeg()),prober=await executable(ffprobe()),runtime={ffmpegSHA256:await fileHash(encoder,signal),ffprobeSHA256:await fileHash(prober,signal)};
  const version=(await execute(encoder,['-version'],options)).stdout;assert.match(version,/ffmpeg version 8\.1\.2/,'Validated FFmpeg8.1.2 required');
  const p=JSON.parse((await execute(prober,['-v','error','-show_streams','-show_format','-of','json',canonical],options)).stdout);const args=colorArguments(canonical,p);
  await fs.writeFile(path.join(dir,'recipe.json'),JSON.stringify({recipe:COLOR_RECIPE,sourceHash,args,ffmpeg:version,runtime},null,2));
  progress({phase:'encode',seconds:30});child=spawn(encoder,args,{windowsHide:true,signal,stdio:['ignore','pipe','pipe','pipe','pipe']});
  const exit=once(child,'close');void exit.catch(()=>{});let lines='';const videoAudit=new AutomaticCfrInputAudit();let videoError:unknown;child.stderr!.on('data',b=>{stderr=(stderr+String(b)).slice(-2*1024**2);lines+=String(b);let end;while((end=lines.indexOf('\n'))>=0){const line=lines.slice(0,end);lines=lines.slice(end+1);try{videoAudit.push(line);}catch(e){videoError=e;child!.kill();}}});
  const pcm=[new AacPipeAudit(2/48000),new AacPipeAudit(2/48000)];let clockError:unknown;
  pcm.forEach((a,i)=>(child!.stdio[i+3] as NodeJS.ReadableStream).on('data',(b:Buffer)=>{try{a.consume(b);}catch(e){clockError=e;child!.kill();}}));
  const stats=[newJitStats(),newJitStats()],audits=[321,322].map(audio=>new TsStabilityAudit({pmt:257,pcr:256,video:320,audio}));
  const packets=normalizeJitAudio(normalizeJitAudio(tsPackets(child.stdout!),stats[0],3003,{videoPid:320,audioPid:321,reordered:true}),stats[1],3003,{videoPid:320,audioPid:322,reordered:true});
  const r=await fs.open(raw,'wx'),t=await fs.open(file,'wx');let count=0,bytes=0,parts:Buffer[]=[],rawParts:Buffer[]=[];
  const flush=async()=>{if(parts.length){await t.write(Buffer.concat(parts));await r.write(Buffer.concat(rawParts));parts=[];rawParts=[];}};
  try{for await(const b of liveTts(splitPcrPackets(packets,257,320,256),stats[0],-13500000)){signal.throwIfAborted();const ts=b.subarray(4);audits.forEach(a=>a.feed(ts,count));count++;parts.push(b);rawParts.push(ts);bytes+=192;assert.ok(bytes<64*1024**2,'30s asset size limit');if(parts.length>=4096){await flush();progress({phase:'encode',bytes});}}await flush();}finally{await r.close();await t.close();}
  const [code]=await exit;await fs.writeFile(path.join(dir,'ffmpeg.log'),stderr);assert.equal(code,0,stderr.slice(-2000));if(clockError)throw clockError;if(videoError)throw videoError;videoAudit.finish();assert.equal(videoAudit.concealmentWarnings,0);
  assert.ok(!/concealing\s+\d+|corrupt decoded frame|error while decoding/i.test(stderr),'Input decode warning requires review');
  const segments=stats.map(s=>validateJitSegmentEnd({...s,pcrIntervals:stats[0].pcrIntervals},0,30,Number(p.format.duration),MPEG2_MEDIA_SHIFT));
  const transport=audits.map(a=>a.finish());for(const a of transport)for(const k of ['malformed','tei','scrambled','ccErrors','crcErrors','pcrBackwards','audioPtsGaps','audioInvalid'] as const)assert.equal(a.counts[k],0,k);
  progress({phase:'independent-decode'});await execute(encoder,['-v','error','-xerror','-i',raw,'-map','0:v','-map','0:a','-f','null','-'],options);
  const headers=inspectMpeg2Startup(await fs.readFile(raw));assert.ok(headers.display.length>0&&headers.display.every((h:any)=>JSON.stringify(h.colour)==='[1,1,1]'));
  assert.equal(headers.program?.pcrPid,256);assert.deepEqual(headers.program?.streams.map((s:any)=>s.pid),[320,321,322]);assert.equal(headers.dts.min,3003);assert.equal(headers.dts.max,3003);
  assert.ok(headers.sequence.every((s:any)=>s.width===1440&&s.height===1080&&s.frameRateCode===4&&s.vbvSizeValue===597));assert.ok(headers.coding.filter((s:any)=>s.kind==='sequence').every((s:any)=>s.profileLevel===68&&s.progressive===0));assert.ok(headers.coding.filter((s:any)=>s.kind==='picture').every((s:any)=>s.structure===3&&s.tff===1));
  const outputProbe=JSON.parse((await execute(prober,['-v','error','-show_streams','-of','json',raw],options)).stdout);const video=outputProbe.streams.find((s:any)=>s.codec_type==='video');assert.equal(video.color_range,'tv');assert.ok([video.color_space,video.color_transfer,video.color_primaries].every(v=>v==='bt709'));
  const audit={runtime,wallSeconds:(performance.now()-began)/1000,recipe:COLOR_RECIPE,headers,segments,transport,pcm:pcm.map(a=>a.summary()),inputVideo:{frames:videoAudit.frames,maxIntervalSeconds:videoAudit.maxIntervalSeconds},filterThreads:1,encoderThreads:4,scope:'30s bounded output. Prior serial full-prefix research applies; last boundary is not asserted byte-identical to unbounded EOF. Receiver freeze safety unproven.'};
  const asset:ColorAsset={file,source:canonical,sourceHash,sourceSize:original.size,sourceMtime:original.mtimeMs,sha256:await fileHash(file,signal),size:bytes,seconds:30,wireBytes:bytes+Math.ceil((bytes/192)/4166)*14,audit};
  await verifyColorAsset(asset,signal);await fs.writeFile(path.join(dir,'audit.json'),JSON.stringify(asset,null,2));await fs.unlink(raw);progress({phase:'ready',bytes});return asset;
 }catch(error){child?.kill();if(child&&child.exitCode===null&&child.signalCode===null)await once(child,'close').catch(()=>{});await fs.writeFile(path.join(dir,'ffmpeg.log'),stderr);await fs.writeFile(path.join(dir,'failure.json'),JSON.stringify({error:String(error)}));for(const f of [raw,file])await fs.unlink(f).catch(()=>{});throw error;}
}
