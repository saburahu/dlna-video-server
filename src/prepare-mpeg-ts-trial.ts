import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execute,ffmpeg,ffprobe} from './prepare-executor.js';
import {experimentalAudioArguments} from './prepare-experimental-audio.js';
import {buildPcrIndex} from './pcr-index.js';
import {inspectTs} from './core.js';
import {TsStabilityAudit} from './ts-stability-audit.js';
import {auditExperimentalAudio} from './experimental-audio-audit.js';
import {readShadowJson,saveShadowJson,type RegisteredDmp} from './playback-shadow-store.js';
import {acquireCapability} from './playback-shadow-store.js';
import {contentPacketLayout} from './content-packet.js';
import {packetTime} from './time-seek.js';
import type {MpegTsTrial} from './mpeg-ts-trial.js';

/** Bounded receiver diagnostic. Not a production cadence or encoder policy. */
export function mpegTsTrialArguments(source:string,adts:string,out:string,seconds:number){
 if(!Number.isFinite(seconds)||seconds<5||seconds>60||new Set([source,adts,out].map(p=>path.resolve(p))).size!==3)throw Error('Invalid bounded TS diagnostic');
 return ['-hide_banner','-nostdin','-n','-v','error','-i',source,'-itsoffset',String(-1024/48000),'-i',adts,'-t',String(seconds),
  '-map','0:v:0','-map','1:a:0','-map_metadata','-1','-map_chapters','-1',
  '-vf','scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,scale=1440:1080,setsar=4/3,fps=30000/1001,setfield=tff,format=yuv420p',
  '-c:v','mpeg2video','-profile:v','4','-level:v','4','-flags','+ilme+ildct','-top','1',
  '-b:v','8000000','-maxrate:v','10000000','-bufsize:v','9781248','-g','15','-bf','2','-sc_threshold','1000000000','-threads','4',
  '-c:a','copy','-mpegts_service_id','141','-mpegts_pmt_start_pid','0x101','-streamid','0:0x140','-streamid','1:0x141',
  '-mpegts_flags','+resend_headers','-pat_period','0.1','-pcr_period','50','-muxrate','12500000','-muxdelay','0.7','-f','mpegts',out];
}
export async function hashedFile(file:string){const s=await fs.stat(file),hash=createHash('sha256');for await(const b of createReadStream(file))hash.update(b);return {path:path.resolve(file),size:s.size,mtimeMs:s.mtimeMs,sha256:hash.digest('hex')};}
async function prepare(){
 const [source,reference,deviceFile]=process.argv.slice(2);if(!source||!reference||!deviceFile)throw Error('Usage: media:mpeg-ts-trial <source> <successful-broadcast.ts> <registered-device.json>');
 const root=path.resolve(process.env.PT3_DATA_DIR??'data','mpeg-ts-trial'),directory=path.join(root,randomUUID());await fs.mkdir(directory,{recursive:true});
 const device=await readShadowJson<RegisteredDmp>(deviceFile);assert.ok(device?.deviceId);
 const registered=await readShadowJson<RegisteredDmp[]>(path.resolve(process.env.PT3_DATA_DIR??'data','playback-shadow','devices.json'));
 const matches=registered?.filter(d=>d.deviceId===device.deviceId&&d.remoteIp===device.remoteIp&&d.descriptionUrl===device.descriptionUrl&&d.controlUrl===device.controlUrl);assert.equal(matches?.length,1,'Exact registered receiver required');
 const cap=await acquireCapability(matches![0],AbortSignal.timeout(10000));assert.equal(cap.deviceId,device.deviceId);
 const before=await fs.stat(source),refBefore=await fs.stat(reference),seconds=40,adts=path.join(directory,'audio.aac'),artifact=path.join(directory,'sample.ts');
 const probe=async(file:string,packets=false)=>JSON.parse((await execute(ffprobe(),['-v','error','-probesize','8000000','-analyzeduration','8000000','-show_streams','-show_format',...(packets?['-show_packets']:[]),'-of','json',file],{windowsHide:true,timeout:30000,maxBuffer:12*1024*1024})).stdout);
 const referenceProbe=await probe(reference),sourceProbe=await probe(source);await saveShadowJson(path.join(directory,'reference-probe.json'),referenceProbe);await saveShadowJson(path.join(directory,'source-probe.json'),sourceProbe);
 const audioArgs=experimentalAudioArguments(source,adts);audioArgs[audioArgs.indexOf('-t')+1]=String(seconds);
 const started=performance.now();const audio=await execute(ffmpeg(),audioArgs,{windowsHide:true,timeout:120000,maxBuffer:1048576});await fs.writeFile(path.join(directory,'audio.log'),audio.stderr);
 const recipe=mpegTsTrialArguments(source,adts,artifact,seconds);const encode=await execute(ffmpeg(),recipe,{windowsHide:true,timeout:180000,maxBuffer:1048576});await fs.writeFile(path.join(directory,'encode.log'),encode.stderr);assert.equal(encode.stderr.trim(),'');
 const encodeMs=performance.now()-started,result=await probe(artifact,true),bytes=await fs.readFile(artifact),ts=inspectTs(bytes.subarray(0,8*1024*1024));
 assert.equal(ts.packetSize,188);assert.ok(ts.pmtPid!==null&&ts.pcrPid!==null&&ts.videoPids.length===1&&ts.audioPids.length===1);
 const audit=new TsStabilityAudit({pmt:ts.pmtPid!,pcr:ts.pcrPid!,video:ts.videoPids[0],audio:ts.audioPids[0]});for(let p=0;p<bytes.length/188;p++)audit.feed(bytes.subarray(p*188,p*188+188),p);const stability=audit.finish(),aac=auditExperimentalAudio(bytes);
 for(const key of ['malformed','tei','scrambled','ccErrors','crcErrors','pcrBackwards','audioPtsGaps','audioInvalid'] as const)assert.equal(stability.counts[key],0,key);
 assert.ok(stability.maxPcrGapMs<=51);assert.ok(stability.first['pat']!==undefined&&stability.first['pmt']!==undefined);
 assert.equal(aac.adts.invalidInterior,false);assert.ok(aac.pmts.length&&aac.pmts.every(p=>p.audio.every(a=>a.streamType===15)));
 const expected=JSON.stringify({mpegId:1,profile:2,sampleFrequencyIndex:3,channelConfiguration:2});assert.equal(aac.adts.kinds[expected],aac.adts.frames);
 const v=result.streams.find((s:any)=>s.codec_type==='video'),a=result.streams.find((s:any)=>s.codec_type==='audio');assert.equal(v.codec_name,'mpeg2video');assert.equal(v.profile,'Main');assert.equal(v.level,4);assert.equal(v.width,1440);assert.equal(v.height,1080);assert.equal(v.field_order,'tt');assert.equal(v.display_aspect_ratio,'16:9');assert.equal(a.codec_name,'aac');assert.equal(a.sample_rate,'48000');assert.equal(a.channels,2);
 const vp=result.packets.filter((p:any)=>p.stream_index===v.index),ap=result.packets.filter((p:any)=>p.stream_index===a.index);assert.ok(vp.length>=1198&&vp.length<=1200);for(const ps of [vp,ap])for(let i=1;i<ps.length;i++)assert.ok(Number(ps[i].dts)>Number(ps[i-1].dts),'DTS monotonic');
 const ends=(ps:any[])=>Math.max(...ps.map(p=>Number(p.pts_time)+Number(p.duration_time??0))),avStart=Number(ap[0].pts_time)-Math.min(...vp.map((p:any)=>Number(p.pts_time))),avEnd=ends(ap)-ends(vp);assert.ok(Math.abs(avStart)<.025&&Math.abs(avEnd)<.06);
 const decoded=await execute(ffmpeg(),['-nostdin','-v','error','-i',artifact,'-map','0:v:0','-map','0:a:0','-f','null','-'],{windowsHide:true,timeout:60000,maxBuffer:1048576});assert.equal(decoded.stderr.trim(),'');
 const index=await buildPcrIndex(artifact);assert.ok(index&&!index.discontinuities&&!index.invalidIntervals);assert.ok(index.durationSeconds>39&&index.durationSeconds<41);const indexFile=path.join(directory,'index.json');await saveShadowJson(indexFile,index);
 const after=await fs.stat(source),refAfter=await fs.stat(reference);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(refAfter.size,refBefore.size);assert.equal(refAfter.mtimeMs,refBefore.mtimeMs);
 const duration=packetTime(index,index.packetCount),layout=contentPacketLayout(index.packetCount*192,index.averageBitrate*192/188),validation=path.join(directory,'validation.json');
 await saveShadowJson(validation,{version:'mpeg-ts-trial-validation-v1',passed:true,receiverAcceptance:'unconfirmed',source:{path:path.resolve(source),size:before.size,mtimeMs:before.mtimeMs},artifact:await hashedFile(artifact),reference:{path:path.resolve(reference),size:refBefore.size,mtimeMs:refBefore.mtimeMs},recipe,audioArgs,seconds,encodeMs,speed:seconds/(encodeMs/1000),video:v,audio:a,videoFrames:vp.length,avStart,avEnd,stability,aac,ts,pcr:{duration,maxGapMs:stability.maxPcrGapMs,discontinuities:index.discontinuities},decode:'complete-video-and-audio',unknowns:['DBR generated MPEG-2 TS acceptance','Complete MPEG_TS_JP_T normative conformance','No ARIB broadcast descriptors/EPG/captions','Progressive source encoded as interlaced frames; not independent 59.94-field motion','CFR is isolated receiver diagnostic, not a new production timing policy']});
 const contract:MpegTsTrial={version:'mpeg-ts-trial-v1',enabled:true,device:matches![0],sinkHash:cap.sinkHash,artifactId:path.basename(directory),source:{path:path.resolve(source),size:before.size,mtimeMs:before.mtimeMs},artifact:await hashedFile(artifact),validation:await hashedFile(validation),index:await hashedFile(indexFile),duration,wireBytes:layout.servedBytes,title:'MPEG-2 TS受信確認（40秒・未確認）',verification:'pc-validated-diagnostic-only'};
 await saveShadowJson(path.join(root,'contract.json'),contract);console.log(JSON.stringify({directory,artifactId:contract.artifactId,wireBytes:contract.wireBytes,duration,encodeMs,speed:seconds/(encodeMs/1000),stability:stability.counts,first:stability.first,avStart,avEnd,receiverAcceptance:'unconfirmed'}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepare();
