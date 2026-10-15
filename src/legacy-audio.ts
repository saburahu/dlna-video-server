import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {ffmpeg} from './prepare-executor.js';
import {snapshotHash,type Fingerprint} from './playback-shadow.js';
import {readShadowJson,saveShadowJson} from './playback-shadow-store.js';
import {AudioEndpointEvidence} from './audio-endpoint-evidence.js';

const VERSION='decoded-audio-end-v4-terminal-evidence';
/** Audio-only endpoint evidence, requested lazily near EOF. WMA decoder frames
 * do not always carry ffprobe PTS. Inspect the timestamp-driven sample clock
 * independently of AAC encoding and timeline reconciliation. async resampling
 * accumulates from its first decoded frame; the resulting endpoint can change
 * with seek pre-roll and is not an independent source endpoint. A broken AVI seek index falls back to a
 * sequential audio-only scan; bounded line processing retains no frame JSON. */
async function scan(source:string,start:number,signal?:AbortSignal,firstOnly=false,allowRecoveredMp3=false){
 signal?.throwIfAborted();
 return new Promise<{start:number;end:number;frames:number;scanStart:number;recovery?:ReturnType<AudioEndpointEvidence['finish']>}>((resolve,reject)=>{
  const args=['-hide_banner','-nostdin','-copyts',...(start>0?['-ss',String(start)]:[]),'-i',source,'-map','0:a:0','-vn','-af','aresample=48000,asettb=1/48000,ashowinfo',...(firstOnly?['-frames:a','1']:[]),'-f','null','-'];
  const child=spawn(ffmpeg(),args,{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let line='',frames=0,end=-Infinity,last=-Infinity,first:number|undefined,failure:Error|undefined;const evidence=new AudioEndpointEvidence();
  let timer:ReturnType<typeof setTimeout>;
  const stop=()=>{failure=new Error('Audio endpoint scan cancelled');child.kill();};
  const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>{failure=new Error('Audio endpoint scan made no progress for 30s');child.kill();},30000);};
  signal?.addEventListener('abort',stop,{once:true});touch();if(signal?.aborted)stop();
  const consume=(text:string)=>{
    evidence.diagnostic(text);
    const m=/pts:(-?\d+) .*rate:(\d+) nb_samples:(\d+)/.exec(text);
    if(!m)return;const pts=Number(m[1]),rate=Number(m[2]),samples=Number(m[3]);
    if(!Number.isSafeInteger(pts)||pts<last||rate!==48000||samples<=0){failure=new Error('Invalid decoded audio endpoint clock');child.kill();return;}
    touch();first??=pts/rate;last=pts;end=(pts+samples)/rate;frames++;evidence.frame(pts,samples,rate);
  };
  child.stderr.on('data',(bytes:Buffer)=>{
   line+=bytes.toString();const parts=line.split(/[\r\n]/);line=parts.pop()!;
   if(line.length>65536||parts.some(p=>p.length>65536)){failure=new Error('Oversized audio decoder diagnostic');child.kill();return;}
   for(const text of parts)consume(text);
  });
  child.once('error',error=>{failure=error;});
  child.once('close',code=>{if(line)consume(line);clearTimeout(timer);signal?.removeEventListener('abort',stop);try{if(failure)throw failure;const recovery=evidence.finish(code,frames,allowRecoveredMp3&&!firstOnly);resolve({start:first!,end,frames,scanStart:start,...(recovery?{recovery}:{})});}catch(e){reject(e);}});
 });
}
/** The ASF stream header may say start=0 although WMA emits its first decoded
 * samples later. Measure one decoded frame without AAC, silence or PTS changes. */
export async function legacyAudioStart(source:Fingerprint,probe:any,directory:string,signal?:AbortSignal){
 const stream=probe.streams.find((s:any)=>s.codec_type==='audio');assert.ok(stream);signal?.throwIfAborted();
 const before=await fs.stat(source.path);assert.ok(before.size===source.size&&before.mtimeMs===source.mtimeMs,'Stale audio start source');
 const key=snapshotHash(JSON.stringify({source,version:'decoded-audio-end-v3-source-clock-start',stream:stream.index})),file=path.join(directory,key+'.json');
 const cached=await readShadowJson<{key:string;start:number;checksum:string}>(file).catch(()=>undefined);
 if(cached?.key===key&&Number.isFinite(cached.start)&&cached.start>=0&&cached.checksum===snapshotHash(JSON.stringify({key,start:cached.start})))return {start:cached.start,cacheHit:true};
 const result=await scan(source.path,0,signal,true);assert.ok(Number.isFinite(result.start)&&result.start>=0&&result.start<Number(probe.format.duration));
 const st=await fs.stat(source.path);assert.ok(st.size===source.size&&st.mtimeMs===source.mtimeMs);signal?.throwIfAborted();
 await saveShadowJson(file,{key,start:result.start,source,version:VERSION,checksum:snapshotHash(JSON.stringify({key,start:result.start}))});return {start:result.start,cacheHit:false};
}
export async function legacyAudioEndpoint(source:Fingerprint,probe:any,directory:string,signal?:AbortSignal){
 const duration=Number(probe.format.duration),stream=probe.streams.find((s:any)=>s.codec_type==='audio');
 assert.ok(stream&&duration>0);signal?.throwIfAborted();const before=await fs.stat(source.path);assert.ok(before.size===source.size&&before.mtimeMs===source.mtimeMs,'Stale audio endpoint source');const key=snapshotHash(JSON.stringify({source,version:VERSION,stream:stream.index})),file=path.join(directory,key+'.json');
 const cached=await readShadowJson<{key:string;end:number;recovery?:ReturnType<AudioEndpointEvidence['finish']>;checksum:string}>(file).catch(()=>undefined);
 if(cached?.key===key&&Number.isFinite(cached.end)&&cached.end>=0&&cached.checksum===snapshotHash(JSON.stringify({key,end:cached.end,...(cached.recovery?{recovery:cached.recovery}:{})})))return {end:cached.end,recovery:cached.recovery,cacheHit:true};
 const allowRecoveredMp3=stream.codec_name==='mp3';
 let result;try{result=await scan(source.path,Math.max(0,duration-5),signal,false,allowRecoveredMp3);}catch(error){signal?.throwIfAborted();if(duration<=5)throw error;result=await scan(source.path,0,signal,false,allowRecoveredMp3);}
 assert.ok(Number.isFinite(result.end)&&result.end>=0&&result.end<=duration+1);
 const st=await fs.stat(source.path);assert.ok(st.size===source.size&&st.mtimeMs===source.mtimeMs);signal?.throwIfAborted();
 await saveShadowJson(file,{key,...result,source,version:VERSION,checksum:snapshotHash(JSON.stringify({key,end:result.end,...(result.recovery?{recovery:result.recovery}:{})}))});return {end:result.end,recovery:result.recovery,cacheHit:false};
}
