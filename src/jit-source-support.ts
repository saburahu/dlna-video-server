import assert from 'node:assert/strict';
import {execute,ffmpeg} from './prepare-executor.js';
import type {ExecutionCapabilities,MediaCharacteristics} from './playback-decision.js';

// An explicit software execution scope, not a filename/device fallback.
import {LEGACY_VIDEO_DECODERS} from './source-codecs.js';
export {LEGACY_VIDEO_DECODERS} from './source-codecs.js';
export const JIT_VIDEO_DECODERS=['h264','hevc','mpeg2video',...LEGACY_VIDEO_DECODERS] as const;
export const JIT_AUDIO_DECODERS=['aac','pcm_s16be','pcm_s16le','ac3','mp3','flac','opus','wmav1','wmav2','wmapro','wmalossless','vorbis','mp2'] as const;
const listings=new Map<string,Promise<string[]>>();
export function parseInstalledJitDecoders(listing:string){
 const aliases:Record<string,string>={msmpeg4v3:'msmpeg4'};
 return [...JIT_VIDEO_DECODERS,...JIT_AUDIO_DECODERS].filter(codec=>new RegExp('^\\s*[VA]\\S*\\s+'+(aliases[codec]??codec)+'\\s','m').test(listing));
}
export function installedJitDecoders(){
 const executable=ffmpeg();let task=listings.get(executable);
 if(!task){task=execute(executable,['-hide_banner','-decoders'],{windowsHide:true,timeout:10000,maxBuffer:1048576}).then(r=>parseInstalledJitDecoders(r.stdout));listings.set(executable,task);task.catch(()=>listings.delete(executable));}
 return task;
}
/** A listing is admission evidence only; actual initialization/decode is runtime-validated. */
export function jitSourceCapabilities(base:ExecutionCapabilities,probe:any):ExecutionCapabilities{
 const allowed=new Set<string>([...JIT_VIDEO_DECODERS,...JIT_AUDIO_DECODERS]);
 const extra=(probe.executionDecoders??[]).filter((c:unknown):c is string=>typeof c==='string'&&allowed.has(c));
 return {...base,decoders:[...base.decoders,...extra.filter((c:string)=>!base.decoders.some(d=>d.codec===c)).map((codec:string)=>({codec,available:true}))]};
}
export function assertJitSource(source:MediaCharacteristics){
 assert.ok(!source.protection,'Encrypted/protected source unsupported');
 assert.ok((JIT_VIDEO_DECODERS as readonly string[]).includes(source.video.codec),'Unsupported source video decoder');
 assert.ok(source.video.bitDepth===8&&source.video.chroma==='420'&&(['progressive','interlaced'].includes(source.video.scan??'')||(source.video.codec==='hevc'||(LEGACY_VIDEO_DECODERS as readonly string[]).includes(source.video.codec))&&source.video.scan===undefined),'Unsupported source pixel/scan format');
 const a=source.audio;assert.ok(a&&(JIT_AUDIO_DECODERS as readonly string[]).includes(a.codec)&&[1,2,6].includes(a.channels!)&&[8000,11025,12000,16000,22050,24000,32000,44100,48000,96000].includes(a.sampleRate!),'Unsupported/missing source audio or layout/rate');
}
