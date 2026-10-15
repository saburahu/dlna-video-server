import {sourceProtection} from './source-protection.js';
import {inspectWebp} from './webp-metadata.js';
import {installedWebpDecoder} from './image-delivery.js';
import path from 'node:path';
import {stat} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {openMediaIndex,type MediaIndex} from './media-catalog-index.js';
import {inspectJitMetadata} from './experimental-jit.js';
import {readShadowJson,saveShadowJson} from './playback-shadow-store.js';
import {DiagnosticLog} from './diagnostic-log.js';
import {sourcePathKey,type RecordingInventory} from './library-discovery.js';

export interface AutomaticCatalogPolicy {enabled:boolean;scanIntervalMs?:number;probeGapMs?:number}
export const DEFAULT_SCAN_INTERVAL_MS=30*60*1000;
export interface RecordingScanState {file:string;size:number;mtimeMs:number}
export function compactCatalogProbe(probe:any){
 const fields=['index','codec_type','codec_name','profile','level','coded_width','coded_height','width','height','pix_fmt','field_order','channels','channel_layout','sample_rate','time_base','r_frame_rate','avg_frame_rate','start_time','duration','tags','disposition','sample_aspect_ratio','display_aspect_ratio','bits_per_raw_sample'];
 return {...(sourceProtection(probe)?{protection:sourceProtection(probe)}:{}),format:{duration:probe.format?.duration,format_name:probe.format?.format_name,start_time:probe.format?.start_time},executionDecoders:probe.executionDecoders,inputPictureStructure:probe.inputPictureStructure,inputPictureStructureEvidence:probe.inputPictureStructureEvidence,streams:(probe.streams??[]).map((s:any)=>Object.fromEntries(fields.filter(k=>s[k]!==undefined).map(k=>[k,s[k]])))};
}
/** Independent cooperative low-priority worker. SQL pending queue, one bounded header probe at a time. */
export function createCatalogBackground(directory:string,folders:()=>string[],trace:(event:string,detail:unknown)=>void,
 dependencies:{probe?:typeof inspectJitMetadata;busy?:()=>boolean;recordings?:(inventory:RecordingInventory)=>Promise<unknown>;recordingState?:()=>RecordingScanState[]}={}){
 const probe=dependencies.probe??inspectJitMetadata;
 let db:MediaIndex|undefined,timer:ReturnType<typeof setTimeout>|undefined,job:Promise<void>|undefined,controller:AbortController|undefined;
 let closed=false,lastScan=0,requested=0,completed=0,skipProbeThrough=0,scanController:AbortController|undefined;
 let previousTs:RecordingScanState[]=[];
 const stats={running:false,queued:0,active:0,maxConcurrent:0,probed:0,cacheHits:0,failed:0,scans:0,metadataUpdateMs:0,lastError:null as string|null,
  scanState:'idle',scanIntervalMs:DEFAULT_SCAN_INTERVAL_MS,automaticEnabled:false,lastScanStartedAt:null as string|null,lastScanCompletedAt:null as string|null,
  tsCount:0,lastScan:null as null|{added:number;updated:number;deleted:number;unchanged:number;failedPaths:string[];elapsedMs:number;publicationMs:number;foldersChanged:boolean},deferredReason:null as string|null};
 const policy=()=>readShadowJson<AutomaticCatalogPolicy>(path.join(directory,'automatic.json'));
 async function cycle(force=false,skipProbe=false){
  if(closed)return;
  const p=await policy();if(closed)return;stats.scanIntervalMs=p?.scanIntervalMs??DEFAULT_SCAN_INTERVAL_MS;stats.automaticEnabled=p?.enabled===true;
  if(!p?.enabled&&!force){stats.running=false;stats.queued=0;return;}
  new DiagnosticLog(directory).assertSeparate(folders());
  db??=await openMediaIndex(directory);if(!stats.running){db.recoverProbes();db.queueHeaderProbes();stats.running=true;}
  if(force||Date.now()-lastScan>=Math.max(1000,stats.scanIntervalMs)){
   if(!force&&dependencies.busy?.()){stats.deferredReason='playback-active';return;}
   stats.deferredReason=null;stats.scanState='scanning';stats.lastScanStartedAt=new Date().toISOString();stats.lastError=null;
   const roots=[...folders()],entries:RecordingInventory['entries']=[],before=dependencies.recordingState?.()??previousTs;
   scanController=new AbortController();
   const result=await db.scan(roots,directory,undefined,e=>entries.push(e),{signal:scanController.signal,beforeDirectory:async()=>{await new Promise<void>(r=>setTimeout(r,dependencies.busy?.()?10:0));}});scanController=undefined;
   if(closed)return;
   if(JSON.stringify(roots)!==JSON.stringify(folders())){requested++;skipProbeThrough=requested;stats.scanState='superseded';return;}
   if(dependencies.recordings)await dependencies.recordings({roots,entries,failedPaths:result.failedPaths});
   const after=dependencies.recordingState?.()??entries.map(e=>({file:e.file,size:e.stat.size,mtimeMs:e.stat.mtimeMs}));
   const old=new Map(before.map(e=>[sourcePathKey(e.file),e])),next=new Map(after.map(e=>[sourcePathKey(e.file),e]));
   let added=0,updated=0,unchanged=0;for(const[k,e]of next){const prev=old.get(k);if(!prev)added++;else if(prev.size!==e.size||prev.mtimeMs!==e.mtimeMs)updated++;else unchanged++;}
   previousTs=after;stats.tsCount=after.length;stats.lastScan={added:added+result.added,updated:updated+result.changed,deleted:[...old.keys()].filter(k=>!next.has(k)).length+result.missing,unchanged:unchanged+result.unchanged,failedPaths:result.failedPaths,elapsedMs:Date.now()-Date.parse(stats.lastScanStartedAt),publicationMs:result.publicationMs,foldersChanged:result.foldersChanged};
   lastScan=Date.now();stats.scans++;stats.lastScanCompletedAt=new Date().toISOString();stats.scanState=result.failedPaths.length?'partial':'complete';trace('CATALOG_SCAN',result);
  }
  stats.queued=db.probeQueue();
  if(closed||skipProbe||(requested>completed&&skipProbeThrough>=requested)||!p?.enabled||dependencies.busy?.()||!stats.queued)return;
  const r=db.nextProbe();if(!r||!db.probeStarted(r))return;
  controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),30000);
  stats.active=1;stats.maxConcurrent=Math.max(stats.maxConcurrent,stats.active);
  try{
   const result=r.container==='webp'?{probe:{image:await inspectWebp(r.path,controller.signal),imageDecoderAvailable:await installedWebpDecoder()},cacheHit:false}:await probe(directory,{path:r.path,size:r.size,mtimeMs:r.mtimeMs},controller.signal);
   const current=await stat(r.path);assert.ok(current.size===r.size&&current.mtimeMs===r.mtimeMs,'Source changed during metadata probe');
   const began=performance.now(),metadata=r.container==='webp'?result.probe:compactCatalogProbe(result.probe);
   const saved=db.setMetadata(r.objectId,{path:r.path,size:r.size,mtimeMs:r.mtimeMs},metadata,r.container==='webp'?0:Number(metadata.format.duration));
   stats.metadataUpdateMs+=performance.now()-began;stats.probed++;if(result.cacheHit)stats.cacheHits++;
   trace('CATALOG_METADATA',{sourceId:r.objectId,cacheHit:result.cacheHit,saved,updateId:db.updateId});
  }catch(error){const cancelled=closed||controller?.signal.aborted===true;db.probeFailed(r,String(error),cancelled);if(!cancelled)stats.failed++;trace('CATALOG_PROBE_FAILED',{sourceId:r.objectId,error:String(error),cancelled});}
  finally{clearTimeout(timeout);controller=undefined;stats.active=0;stats.queued=db.probeQueue();}
 }
 function run(force=false,skipProbe=false):Promise<void>{if(closed)return Promise.resolve();if(force){requested++;if(skipProbe)skipProbeThrough=requested;controller?.abort();}const target=requested;
  const wait=(active:Promise<void>):Promise<void>=>active.then(()=>!closed&&completed<target?run():undefined);
  if(job)return wait(job);
  job=(async()=>{let first=true;while(!closed&&(first||completed<requested)){first=false;const ticket=requested;await cycle(ticket>completed,ticket>completed&&ticket<=skipProbeThrough);completed=ticket;}})().catch(error=>{completed=requested;stats.lastError=String(error);stats.scanState=closed?'stopped':'failed';trace('CATALOG_BACKGROUND_ERROR',{error:String(error)});throw error;}).finally(()=>{job=undefined;});return wait(job);}
 async function tick(){await run().catch(()=>{});if(!closed){const p=await policy().catch(()=>undefined);timer=setTimeout(tick,stats.queued?Math.max(20,p?.probeGapMs??100):1000);timer.unref();}}
 return {start(){if(!closed&&!timer&&!job)void tick();},runOnce:(forceScan=false)=>run(forceScan),scanNow:()=>run(true,true),
  async configureInterval(seconds:number){if(!Number.isSafeInteger(seconds)||seconds<30||seconds>86400)throw Error('Scan interval must be 30..86400 seconds');const p=await policy();await saveShadowJson(path.join(directory,'automatic.json'),{enabled:true,...p,scanIntervalMs:seconds*1000});stats.scanIntervalMs=seconds*1000;},
  status:()=>{const queued=db?.probeQueue()??stats.queued,metadataFailed=db?.probeFailures()??0;return {...stats,queued,metadataFailed,
   metadataState:stats.active?'analyzing':queued?(!stats.automaticEnabled?'paused':dependencies.busy?.()?'deferred':'pending'):metadataFailed?'failed':'complete',
   otherVideoCount:db?.count()??0,imageCount:db?.photoCount()??0};},
  async stop(){closed=true;if(timer)clearTimeout(timer);controller?.abort();scanController?.abort();await job?.catch(()=>{});db?.close();db=undefined;stats.running=false;stats.scanState='stopped';}};
}
