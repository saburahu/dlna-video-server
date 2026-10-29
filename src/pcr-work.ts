import {performance} from 'node:perf_hooks';
import {sourcePathKey} from './library-discovery.js';

export class PcrDeferred extends Error {constructor(public readonly reason:string){super(reason);this.name='PcrDeferred';}}
export interface PcrWorkOptions {source:string;key:string;background?:boolean;bytesPerSecond?:number;yieldToMedia?:boolean}
export interface PcrWorkControl {signal:AbortSignal;initialBackground:boolean;check():void;charge(bytes:number,phase:string):Promise<void>}
type Job={id:string;source:string;key:string;background:boolean;yieldToMedia:boolean;rate:number;controller:AbortController;action:(control:PcrWorkControl)=>Promise<unknown>;resolve:(v:any)=>void;reject:(e:unknown)=>void;promise:Promise<any>;wake?:()=>void;began:number;readBytes:number;phase:string};
/** One source reader, foreground FIFO ahead of prefetch. Same-job promotion
 * preserves partial work; another foreground source preempts only background. */
export function createPcrWork(){
 const jobs=new Map<string,Job>(),queue:Job[]=[],media=new Map<symbol,string|undefined>();let active:Job|undefined,paused=false;
 const stats={completed:0,preemptions:0,promotions:0,readBytes:0};
 let observer:(event:string,detail:unknown)=>void=()=>{};
 const emit=(event:string,j:Job)=>observer(event,{source:j.source,background:j.background,phase:j.phase,readBytes:j.readBytes,elapsedMs:j.began?performance.now()-j.began:0});
 const allowed=(j:Job)=>!paused&&(!media.size||!j.yieldToMedia&&[...media.values()].every(s=>s===j.source));
 function interrupt(reason:string){if(active?.background){stats.preemptions++;active.controller.abort(new PcrDeferred(reason));active.wake?.();}}
 function promote(j:Job){if(j.background){j.background=false;stats.promotions++;j.wake?.();emit('PCR_INDEX_PROMOTED',j);}}
 function pump(){
  if(active)return;
  const position=queue.findIndex(j=>!j.background);const at=position>=0?position:!paused&&!media.size?0:-1;
  if(at<0||!queue.length)return;const j=queue.splice(at,1)[0];active=j;j.began=performance.now();emit('PCR_INDEX_START',j);
  const check=()=>{if(j.controller.signal.aborted)throw j.controller.signal.reason;if(j.background&&!allowed(j)){j.controller.abort(new PcrDeferred(paused?'paused':'playback'));throw j.controller.signal.reason;}};
  const control:PcrWorkControl={signal:j.controller.signal,initialBackground:j.background,check,async charge(bytes,phase){
   check();j.readBytes+=bytes;stats.readBytes+=bytes;j.phase=phase;
   while(j.background){check();const delay=j.readBytes/j.rate*1000-(performance.now()-j.began);if(delay<=0)break;
    await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);j.controller.signal.removeEventListener('abort',done);j.wake=undefined;resolve();};const timer=setTimeout(done,Math.min(delay,100));j.wake=done;j.controller.signal.addEventListener('abort',done,{once:true});});
   }check();
  }};
  void j.action(control).then(v=>{stats.completed++;j.resolve(v);},e=>j.reject(e)).finally(()=>{emit('PCR_INDEX_END',j);jobs.delete(j.id);active=undefined;setImmediate(pump);});
 }
 return {
  run<T>(options:PcrWorkOptions,action:(c:PcrWorkControl)=>Promise<T>):Promise<T>{
   const source=sourcePathKey(options.source),id=JSON.stringify([source,options.key]),old=jobs.get(id);if(old){if(!options.background)promote(old);return old.promise;}
   let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
   const job:Job={id,source,key:options.key,background:!!options.background,yieldToMedia:!!options.yieldToMedia,rate:options.bytesPerSecond??4*1024*1024,controller:new AbortController(),action,resolve,reject,promise,began:0,readBytes:0,phase:'cache'};
   jobs.set(id,job);queue.push(job);if(!job.background&&active?.background&&active.id!==id)interrupt('foreground-preempted');setImmediate(pump);return promise;
  },
  promote(source:string,key:string){const j=jobs.get(JSON.stringify([sourcePathKey(source),key]));if(j)promote(j);},
  reserve(source?:string){const key=Symbol(),canonical=source?sourcePathKey(source):undefined;media.set(key,canonical);if(active?.background&&(active.yieldToMedia||active.source!==canonical))interrupt('playback');let closed=false;return()=>{if(!closed){closed=true;media.delete(key);setImmediate(pump);}};},
  pause(value:boolean){paused=value;if(value)interrupt('paused');else setImmediate(pump);},
  interrupt(reason:string){interrupt(reason);},
  cancelBackground(reason:string){interrupt(reason);for(let i=queue.length-1;i>=0;i--){const j=queue[i];if(j.background){queue.splice(i,1);jobs.delete(j.id);j.reject(new PcrDeferred(reason));}}},
  busy(source?:string){const canonical=source?sourcePathKey(source):undefined;return source?[...jobs.values()].some(j=>j.source===canonical)||[...media.values()].some(s=>s===canonical):media.size>0;},
  observer(fn:typeof observer){observer=fn;},
  status:()=>({...stats,mediaRequests:media.size,queued:queue.length,paused,active:active?{source:active.source,background:active.background,phase:active.phase,readBytes:active.readBytes,elapsedMs:performance.now()-active.began}:null})
 };
}
export const pcrWork=createPcrWork();
