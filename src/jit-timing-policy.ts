import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {execute,ffmpeg,ffprobe} from './prepare-executor.js';
import {matchingFingerprint,snapshotHash,type Fingerprint} from './playback-shadow.js';
import {readShadowJson,saveShadowJson} from './playback-shadow-store.js';
import {assessQuantizedTiming} from './quantized-timing-eligibility.js';
import type {QuantizedTimingPolicy} from './quantized-timing.js';

export type JitTimingMode='auto'|'original'|'quantized-evidence-v1';
export const JIT_TIMING_ANALYSIS_VERSION='bounded-clock-evidence-v2-encoder-clock';
export interface TimingChoice {version:string;key:string;sourceFingerprint:Fingerprint;targetTimingFingerprint:string;mode:JitTimingMode;clock?:QuantizedTimingPolicy;encoderNominalRate?:string;assessment:unknown;cacheHit:boolean}
/** libx264 initialization hint only: never an fps filter or output -r. */
export function encoderNominalRate(value:unknown):string|undefined {
 if(typeof value!=='string'||!/^\d+\/\d+$/.test(value))return;
 const [n,d]=value.split('/').map(Number);
 return Number.isSafeInteger(n)&&Number.isSafeInteger(d)&&n>0&&d>0&&n/d<=120?value:undefined;
}
const blocked=new Set<string>();
export function timingCacheKey(source:Fingerprint,target:string,mode:JitTimingMode){return snapshotHash(JSON.stringify({source,target,mode,version:JIT_TIMING_ANALYSIS_VERSION}));}
/** Clock metadata supports a candidate, never proves a fixed frame rate.
 * First integration scope is HEVC 1ms with the already tested VUI clock.
 * Other syntax/clocks fall back instead of guessing from nominal fps. */
export function hevcQuantizationClock(header:string):QuantizedTimingPolicy|undefined {
 const read=(name:string)=>[...header.matchAll(new RegExp('\\b'+name+'\\s+[01]+\\s*=\\s*(\\d+)','g'))].map(m=>Number(m[1]));
 if(!read('vui_timing_info_present_flag').length||!read('vui_timing_info_present_flag').every(v=>v===1)||
    !read('vui_num_units_in_tick').length||!read('vui_num_units_in_tick').every(v=>v===1001)||
    !read('vui_time_scale').length||!read('vui_time_scale').every(v=>v===60000))return;
 return {version:'quantized-grid-experiment-v1',originTicks:0,gridNumerator:3003,gridDenominator:2,quantumTicks:90,
  evidence:'HEVC VUI 1001/60000 plus bounded millisecond display timestamp fit; inferred clock, not original mastering truth'};
}
interface Dependencies {header:(source:string,signal?:AbortSignal)=>Promise<string>;timestamps:(source:string,signal?:AbortSignal)=>Promise<number[]>}
const dependencies:Dependencies={
 header:async(source,signal)=>(await execute(ffmpeg(),['-nostdin','-hide_banner','-loglevel','info','-i',source,'-map','0:v:0','-c:v','copy','-bsf:v','trace_headers','-frames:v','1','-f','null','-'],{windowsHide:true,timeout:15000,maxBuffer:1048576,signal})).stderr,
 timestamps:async(source,signal)=>{
  const p=JSON.parse((await execute(ffprobe(),['-v','error','-select_streams','v:0','-read_intervals','%12','-show_packets','-show_entries','packet=pts','-of','json',source],{windowsHide:true,timeout:15000,maxBuffer:1048576,signal})).stdout);
  assert.ok(p.packets.length>0&&p.packets.length<=2048,'Bounded timestamp sample exceeded');
  return p.packets.map((v:any)=>{assert.ok(Number.isSafeInteger(Number(v.pts)));return Number(v.pts)*90;}).sort((a:number,b:number)=>a-b);
 }
};
/** GET-only bounded analysis; cache-only HEAD never starts subprocesses.
 * Cache stores evidence/selection of policy, not a whole-source timestamp JSON. */
export async function chooseJitTiming(directory:string,source:Fingerprint,targetTiming:unknown,probe:any,mode:JitTimingMode='auto',options:{signal?:AbortSignal;cacheOnly?:boolean;dependencies?:Partial<Dependencies>}={}){
 assert.ok(mode==='auto'||mode==='original'||mode==='quantized-evidence-v1');
 const targetTimingFingerprint=snapshotHash(JSON.stringify(targetTiming)),key=timingCacheKey(source,targetTimingFingerprint,mode);
 const original=(reason:string):TimingChoice=>({version:JIT_TIMING_ANALYSIS_VERSION,key,sourceFingerprint:source,targetTimingFingerprint,mode,assessment:{status:'original',fallback:'original-pts-greedy-v1',reason},cacheHit:false});
 if(mode==='original')return original('Explicit original override; preserve original timestamp contract');
 if(blocked.has(key))return original('Runtime model mismatch invalidated this source/policy cache');
 const file=path.join(directory,'timing-analysis',key+'.json');
 try{const c=await readShadowJson<TimingChoice&{checksum:string}>(file);if(c){const {checksum,...body}=c;assert.equal(checksum,snapshotHash(JSON.stringify(body)));assert.equal(c.version,JIT_TIMING_ANALYSIS_VERSION);assert.equal(c.key,key);assert.ok(matchingFingerprint(c.sourceFingerprint,source));assert.equal(c.targetTimingFingerprint,targetTimingFingerprint);assert.equal(c.mode,mode);return {...body,cacheHit:true};}}catch{}
 if(options.cacheOnly)return original('HEAD has no cached timing evidence; actual GET chooses and reports its timeline');
 const v=probe.streams?.find((s:any)=>s.codec_type==='video');
 let choice=original('Source clock/precision is outside the validated reconstruction scope');
 const nominal=encoderNominalRate(v?.r_frame_rate);
 if(v?.codec_name==='hevc'&&v.time_base==='1/1000'&&nominal){
  try{
   const deps={...dependencies,...options.dependencies},clock=hevcQuantizationClock(await deps.header(source.path,options.signal));
   if(clock){const sample=await deps.timestamps(source.path,options.signal);
    const assessment=assessQuantizedTiming({enabled:true,sourceQuantumTicks:90,sourceFingerprint:snapshotHash(JSON.stringify(source)),targetPolicyFingerprint:targetTimingFingerprint,candidate:clock,
     clockEvidence:[clock.evidence],timestamps:sample,minimumSamplePictures:64,minimumSampleSpanTicks:180000});
    choice={...choice,assessment,...(assessment.status==='diagnostic-candidate'?{clock,encoderNominalRate:nominal}: {})};
   }else choice=original('HEVC VUI does not corroborate the tested clock grid');
  }catch(e){if(options.signal?.aborted)throw e;return original('Bounded timing analysis failed; preserve original policy: '+String(e));}
 }
 const st=await fs.stat(source.path);assert.equal(st.size,source.size);assert.equal(st.mtimeMs,source.mtimeMs);
 const body={...choice,cacheHit:false};await saveShadowJson(file,{...body,checksum:snapshotHash(JSON.stringify(body))});return choice;
}
/** Never switch timestamps in-flight. Abort current stream via runtime validator,
 * invalidate the candidate now and preserve original policy on future requests. */
export async function rejectJitTiming(directory:string,choice:TimingChoice,reason:string){
 blocked.add(choice.key);
 const body:TimingChoice={...choice,clock:undefined,cacheHit:false,assessment:{status:'original',reason:'Runtime reconstruction rejected: '+reason}};
 const serialized=JSON.parse(JSON.stringify(body));await saveShadowJson(path.join(directory,'timing-analysis',choice.key+'.json'),{...serialized,checksum:snapshotHash(JSON.stringify(serialized))});
}
