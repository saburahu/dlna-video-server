import assert from 'node:assert/strict';
import type {JitStats} from './jit-stream.js';
import {ENCODE_RECIPE} from './prepare-executor.js';
/** Called only after clean encoder exit and complete packet parsing. AAC
 * coverage rejects a shortened stream; no samples or pictures are invented. */
export function validateJitSegmentEnd(stats:JitStats,start:number,end:number,sourceAudioEnd?:number,shift=ENCODE_RECIPE.commonShiftTicks,sourceAudioStart=0){
 assert.ok(Number.isFinite(start)&&Number.isFinite(end)&&end>start);
 assert.ok(stats.videoPictures>0&&stats.pcrIntervals>0,'Finite segment needs video and PCR');
 const firstVideo=(stats.firstVideoPts!-shift)/90000,lastVideo=(stats.lastVideoPts!-shift)/90000;
 // Three AAC frames cover encoder end-padding and source millisecond rounding.
 // This gate never changes the timeline or permits an unbounded shortfall.
 const tolerance=3*1920/90000;
 assert.ok(firstVideo>=start-.003&&firstVideo<end&&lastVideo<end+.003,'Video outside requested segment');
 // A requested tail can lie entirely after a shorter source audio track.
 // Require explicit finite source endpoint evidence; unknown or overlapping
 // audio coverage still requires actual samples. Never synthesize silence.
 if(stats.audioFrames===0&&sourceAudioEnd!==undefined&&Number.isFinite(sourceAudioEnd)&&sourceAudioEnd>=0&&sourceAudioEnd<=start){
  return {firstVideo,lastVideo,firstAudio:undefined,audioEnd:sourceAudioEnd,end,expectedAudioEnd:sourceAudioEnd,endpointToleranceSeconds:tolerance,audioCoverage:'source-ended-before-request' as const};
 }
 assert.ok(stats.audioFrames>0,'Finite segment needs video, audio and PCR');
 const firstAudio=(stats.firstAudioPts!-shift)/90000,audioEnd=(stats.lastAudioFramePts!+1920-shift)/90000;
 assert.ok(Number.isFinite(sourceAudioStart)&&sourceAudioStart>=0,'Invalid source audio start');
 const expectedAudioStart=Math.max(start,sourceAudioStart);
 assert.ok(Math.abs(firstAudio-expectedAudioStart)<=tolerance,'Audio starts outside requested segment');
 const expectedAudioEnd=sourceAudioEnd===undefined?end:Math.min(end,sourceAudioEnd);
 assert.ok(Math.abs(audioEnd-expectedAudioEnd)<=tolerance,'Audio does not cover requested segment endpoint');
 return {firstVideo,lastVideo,firstAudio,audioEnd,end,expectedAudioStart,expectedAudioEnd,endpointToleranceSeconds:tolerance};
}

/** Header-level track endpoint. Unknown remains unknown; do not manufacture
 * silence to extend a naturally shorter audio track to container duration. */
export function sourceAudioEndpoint(probe:any):number|undefined{
 const s=probe.streams?.find((s:any)=>s.codec_type==='audio');if(!s)return;
 const duration=Number(s.duration),start=Number(s.start_time??0);
 if(Number.isFinite(duration)&&duration>0&&Number.isFinite(start))return start+duration;
 const tag=Object.entries(s.tags??{}).find(([k])=>/^DURATION(?:-|$)/i.test(k))?.[1];
 const m=typeof tag==='string'?/^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(tag):null;
 if(m)return Number(m[1])*3600+Number(m[2])*60+Number(m[3]);
}
