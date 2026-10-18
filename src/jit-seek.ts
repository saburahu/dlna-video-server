import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPictures,IncrementalSelection,FULL_ANALYSIS_VERSION,pictureBytes,type PictureRecord,type FullAnalysis} from './full-cadence.js';
import {snapshotHash} from './playback-shadow.js';
import {fileFingerprint} from './file-fingerprint.js';
import {execute,ffprobe} from './prepare-executor.js';
import {streamCommand,compactFields} from './full-process.js';
import {reconstructTimestamp,type QuantizedTimingPolicy} from './quantized-timing.js';
import {SharedJitJobs} from './shared-jit-job.js';
export const SEEK_CHECKPOINT_VERSION='jit-keyframe-greedy-v4';
export interface SeekCheckpoint {pts:number;index:number;lastRetainedTimestamp?:number}
export interface SeekCache {version:string;fingerprint:{path:string;size:number;mtimeMs:number};policyFingerprint:string;minimumTicks:number;duration:number;frames:number;checkpoints:SeekCheckpoint[];origin:string;checksum?:string;timestampSource?:'packet'|'decoded';decodedTimeline?:{path:string;size:number;sha256:string};scannedThrough?:number;experimentalClock?:QuantizedTimingPolicy}
export function checkpointSelection(pictures:PictureRecord[],minimum:number){const selector=new IncrementalSelection(minimum),checkpoints:SeekCheckpoint[]=[];for(const p of pictures){if(p.key||p.index===0)checkpoints.push({pts:p.pts,index:p.index,lastRetainedTimestamp:selector.last?.pts});selector.push(p);}return checkpoints;}
/** Missing packet duration is legal for VFR. Selection depends only on actual PTS;
 * zero denotes unknown duration, never a guessed fps or a changed timestamp. */
export function seekPacketPicture(f:Readonly<Record<string,string|undefined>>,scale:number):PictureRecord{
 const pts=Math.round(Number(f.pts)*scale),duration=f.duration===undefined||f.duration==='N/A'?0:Math.round(Number(f.duration)*scale);
 assert.ok(Number.isSafeInteger(pts)&&Number.isSafeInteger(duration)&&duration>=0,'Invalid source packet timestamp/duration');
 return {pts,duration,index:0,key:(f.flags??'').includes('K'),retained:false};
}
/** Packet timestamps only, bounded reorder queue; one picture/AU packet is required.
 * No video decode or encode. Fail closed if reorder exceeds bound/duplicate timestamps. */
export class PacketTimelineError extends Error {}
export function packetPictures(source:string,interval?:string,signal?:AbortSignal){return sourcePictures(source,interval,false,signal);}
export function decodedPictures(source:string,interval?:string,signal?:AbortSignal){return sourcePictures(source,interval,true,signal);}
async function* sourcePictures(source:string,interval:string|undefined,decoded:boolean,signal?:AbortSignal){
 signal?.throwIfAborted();
 const probe=JSON.parse((await execute(ffprobe(),['-v','error','-select_streams','v:0','-show_streams','-of','json',source],{windowsHide:true,timeout:30000,maxBuffer:1048576,signal})).stdout);
 const [n,d]=probe.streams[0].time_base.split('/').map(Number),scale=n*90000/d;
 // A bounded channel permits the async consumer to propagate subprocess backpressure.
 const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const queue:PictureRecord[]=[];let wake:()=>void=()=>{},resume:()=>void=()=>{},done=false,error:unknown,index=0,previous=-Infinity;
 const sorted:PictureRecord[]=[];
 const emit=async(p:PictureRecord)=>{if(controller.signal.aborted)throw new Error('Timestamp reader closed');if(p.pts<=previous){if(!decoded)throw new PacketTimelineError('Packet timeline not one ordered picture/AU');throw new Error('Decoded display timeline is not strictly increasing');}previous=p.pts;p.index=index++;queue.push(p);wake();if(queue.length>=512)await new Promise<void>(r=>resume=r);};
 const args=['-v','error',...(decoded?['-threads','0']:[]),'-select_streams','v:0',...(interval?['-read_intervals',interval]:[]),...(decoded?['-show_frames','-show_entries','frame=pts,best_effort_timestamp,duration,key_frame']:['-show_packets','-show_entries','packet=pts,duration,flags']),'-of','compact=p=0',source];
 const task=streamCommand(ffprobe(),args,{signal:controller.signal,stdout:async line=>{const f=compactFields(line);if(decoded)f.pts=f.best_effort_timestamp??f.pts;if(f.pts===undefined||f.pts==='N/A'){if(!decoded)throw new PacketTimelineError('Packet PTS absent; decoded display timeline required');return;}const p=seekPacketPicture(decoded?{...f,pts:f.best_effort_timestamp??f.pts,flags:f.key_frame==='1'?'K':''}:f,scale);if(decoded){await emit(p);return;}sorted.push(p);sorted.sort((a,b)=>a.pts-b.pts);if(sorted.length>256)await emit(sorted.shift()!);}}).then(async result=>{if(decoded)assert.equal(result.tail.trim(),'','Decoded timestamp scan reported errors');for(const p of sorted)await emit(p);}).catch(e=>error=e).finally(()=>{done=true;wake();});
 try{while(!done||queue.length){if(!queue.length){await new Promise<void>(r=>wake=r);continue;}yield queue.shift()!;resume();}await task;if(error)throw error;}finally{signal?.removeEventListener('abort',abort);controller.abort();resume();await task;}
}
const jobs=new SharedJitJobs<SeekCache>();
export async function seekCheckpoints(source:string,minimumTicks:number,policyFingerprint:string,directory='data/jit-seek-cache',analysisDirectory='data/detailed-analysis',experimentalClock?:QuantizedTimingPolicy,signal?:AbortSignal,throughSeconds?:number){
 signal?.throwIfAborted();const st=await fs.stat(source),fingerprint={path:path.resolve(source),size:st.size,mtimeMs:st.mtimeMs};const key=snapshotHash(JSON.stringify({fingerprint,policyFingerprint,minimumTicks,version:SEEK_CHECKPOINT_VERSION,...(experimentalClock?{experimentalClock}: {})}));
 const result=await jobs.run(path.resolve(directory)+'/'+key,async signal=>{const file=path.join(directory,key+'.json');try{const c:SeekCache=JSON.parse(await fs.readFile(file,'utf8'));const {checksum,...body}=c;assert.equal(checksum,snapshotHash(JSON.stringify(body)));assert.equal(c.version,SEEK_CHECKPOINT_VERSION);assert.deepEqual(c.fingerprint,fingerprint);assert.equal(c.minimumTicks,minimumTicks);assert.equal(c.policyFingerprint,policyFingerprint);assert.ok(c.checkpoints.length&&c.frames>0);assert.ok((c.scannedThrough??c.duration)>=Math.min(c.duration,throughSeconds??c.duration));if(c.timestampSource==='decoded'){assert.ok(c.decodedTimeline);const fp=await fileFingerprint(c.decodedTimeline.path);assert.equal(fp.sha256,c.decodedTimeline.sha256);assert.equal(fp.size,c.decodedTimeline.size);}return c;}catch{}
 let pictures:AsyncIterable<PictureRecord>,duration:number,origin:string;
 const analysisKey=snapshotHash(JSON.stringify({fingerprint,version:FULL_ANALYSIS_VERSION}));
 try{const a:FullAnalysis=JSON.parse(await fs.readFile(path.join(analysisDirectory,analysisKey,'analysis.json'),'utf8'));assert.deepEqual(a.fingerprint,fingerprint);const fp=await fileFingerprint(a.timeline.path);assert.equal(fp.sha256,a.timeline.sha256);assert.equal(fp.size,a.timeline.size);pictures=readPictures(a.timeline.path);duration=a.durationSeconds;origin='fingerprint/checksum-validated compact detailed cache';}
 catch{signal.throwIfAborted();const p=JSON.parse((await execute(ffprobe(),['-v','error','-show_format','-of','json',source],{windowsHide:true,timeout:30000,maxBuffer:1048576,signal})).stdout);duration=Number(p.format.duration);pictures=packetPictures(source,throughSeconds===undefined?undefined:`%${Math.min(duration,throughSeconds)}`,signal);origin='on-demand packet timestamp scan; no full decode/encode';}
 let selector=new IncrementalSelection(minimumTicks),checkpoints:SeekCheckpoint[]=[],timestampSource:'packet'|'decoded'='packet';let decodedTimeline:SeekCache['decodedTimeline'];
 const collect=async(input:AsyncIterable<PictureRecord>)=>{for await(const p of input){if(p.key||p.index===0)checkpoints.push({pts:p.pts,index:p.index,lastRetainedTimestamp:selector.last?.pts});selector.push(experimentalClock?{...p,pts:reconstructTimestamp(p.pts,experimentalClock).pts}:p);}};
 try{await collect(pictures);}catch(e){if(!(e instanceof PacketTimelineError))throw e;
 // Edited GOP joins may have ambiguous packet PTS. Use actual decoded display timestamps.
 // Do not sort, repair, or relax validation of the decoded display timeline.
 selector=new IncrementalSelection(minimumTicks);checkpoints=[];timestampSource='decoded';
 await fs.mkdir(directory,{recursive:true});const timelinePath=path.join(directory,key+'.'+randomUUID()+'.pictures.bin'),temporaryTimeline=timelinePath+'.'+randomUUID()+'.tmp',out=await fs.open(temporaryTimeline,'wx');
 const recorded=(async function*(){const buffer:Buffer[]=[];for await(const p of decodedPictures(source,throughSeconds===undefined?undefined:`%${Math.min(duration,throughSeconds)}`,signal)){buffer.push(pictureBytes(p));if(buffer.length>=512){await out.writeFile(Buffer.concat(buffer));buffer.length=0;}yield p;}if(buffer.length)await out.writeFile(Buffer.concat(buffer));})();
 let collected=false;try{await collect(recorded);collected=true;}finally{await out.close();if(!collected)await fs.rm(temporaryTimeline,{force:true});}
 await fs.rename(temporaryTimeline,timelinePath);decodedTimeline=await fileFingerprint(timelinePath);origin='on-demand decoded display timestamp fallback after ambiguous packet timeline';}
 assert.ok(checkpoints.length&&Number.isFinite(duration));signal?.throwIfAborted();const after=await fs.stat(source);assert.equal(after.size,st.size);assert.equal(after.mtimeMs,st.mtimeMs);
 const cache:SeekCache={version:SEEK_CHECKPOINT_VERSION,fingerprint,minimumTicks,policyFingerprint,duration,frames:selector.count,checkpoints,origin,timestampSource,scannedThrough:Math.min(duration,throughSeconds??duration),...(decodedTimeline?{decodedTimeline}:{}),...(experimentalClock?{experimentalClock}: {})};cache.checksum=snapshotHash(JSON.stringify(cache));await fs.mkdir(directory,{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(cache));await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}return JSON.parse(JSON.stringify(cache)) as SeekCache;},signal);
 signal?.throwIfAborted();
 if((result.scannedThrough??result.duration)<Math.min(result.duration,throughSeconds??result.duration))return seekCheckpoints(source,minimumTicks,policyFingerprint,directory,analysisDirectory,experimentalClock,signal,throughSeconds);
 return result;
}
export interface JitSeekPlan {requested:number;anchor:SeekCheckpoint;firstVideoTicks:number;audioTrimTicks:number;minimumTicks:number;policyFingerprint:string;preRollSeconds:number;indexFallback?:string}
/** A valid container NPT need not have a usable video picture. This is an
 * unsupported temporal interval, not an encoder/server failure. Never rewind,
 * duplicate the last picture, or infer display duration from nominal fps. */
export class JitSeekUnavailableError extends Error {
 readonly code='jit-seek-no-video-picture';
 constructor(readonly requested:number,readonly lastPicture?:{pts:number;duration:number}){super('No retained picture at or after requested time');this.name='JitSeekUnavailableError';}
}
/** OP10 advertises time seeking: an unavailable temporal range is416, not the
 *406 used for an unsupported DLNA operation. Without an explicit time request
 *and observed source picture evidence, retain a preparation failure (503).
 *Never invent a byte Content-Range for this time-only, generated resource. */
export function jitSeekFailureStatus(error:unknown,timeSeekRequested:boolean):416|503{
 return timeSeekRequested&&error instanceof JitSeekUnavailableError&&error.lastPicture!==undefined?416:503;
}
export async function resolveJitSeek(source:string,cache:SeekCache,requested:number,signal?:AbortSignal){assert.ok(requested>=0&&requested<cache.duration);assert.ok((cache.scannedThrough??cache.duration)>requested,'Seek exceeds validated checkpoint coverage');const target=Math.ceil(requested*90000);let anchor=cache.timestampSource==='decoded'?cache.checkpoints[0]:cache.checkpoints.filter(p=>p.pts<=target).at(-1)??cache.checkpoints[0];let last=anchor.lastRetainedTimestamp,firstVideoTicks:number|undefined,indexFallback:string|undefined,lastPicture:{pts:number;duration:number}|undefined,anchorFound=cache.timestampSource==='decoded';
 // Ambiguous packet timelines require decoding from the beginning: FFmpeg's best-effort
 // timestamp fault counters reset on decoder restart. A later keyframe alone cannot
 // reproduce those counters. Read the validated compact timeline, then pre-roll from 0.
 for await(const p of cache.timestampSource==='decoded'?readPictures(cache.decodedTimeline!.path):packetPictures(source,`${Math.max(0,anchor.pts/90000-.001)}%${Math.min(cache.duration,requested+3)}`,signal)){signal?.throwIfAborted();lastPicture={pts:p.pts,duration:p.duration};if(p.pts<anchor.pts)continue;if(p.pts===anchor.pts)anchorFound=true;if(!anchorFound)break;const pts=cache.experimentalClock?reconstructTimestamp(p.pts,cache.experimentalClock).pts:p.pts;const keep=last===undefined||pts-last>=cache.minimumTicks;if(keep){last=pts;if(pts>=target){firstVideoTicks=pts;break;}}}
 if(firstVideoTicks===undefined&&cache.timestampSource!=='decoded'){
  // Some old ASF/AVI indexes return EOF for an otherwise valid timestamp.
  // Replay the original packet sequence and greedy state from its first anchor;
  // pre-roll the encoder from the same point. No sorting/repair/clock relaxation.
  anchor=cache.checkpoints[0];last=anchor.lastRetainedTimestamp;
  for await(const p of packetPictures(source,`%${Math.min(cache.duration,requested+3)}`,signal)){
   lastPicture={pts:p.pts,duration:p.duration};if(p.pts<anchor.pts)continue;const pts=cache.experimentalClock?reconstructTimestamp(p.pts,cache.experimentalClock).pts:p.pts;
   if(last===undefined||pts-last>=cache.minimumTicks){last=pts;if(pts>=target){firstVideoTicks=pts;break;}}
  }
  indexFallback='sequential packet scan and decoder pre-roll after missing indexed anchor';
 }
 if(firstVideoTicks===undefined)throw new JitSeekUnavailableError(requested,lastPicture);return {requested,anchor,firstVideoTicks,...(indexFallback?{indexFallback}:{}),audioTrimTicks:Math.ceil(target/1920)*1920,minimumTicks:cache.minimumTicks,policyFingerprint:cache.policyFingerprint,preRollSeconds:firstVideoTicks/90000-anchor.pts/90000} satisfies JitSeekPlan;
}
