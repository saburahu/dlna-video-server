import {sourceProtection} from './source-protection.js';
import {inspectWebp} from './webp-metadata.js';
import {installedWebpDecoder} from './image-delivery.js';
import path from 'node:path';
import {stat} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {openMediaIndex,type MediaIndex} from './media-catalog-index.js';
import {inspectJitMetadata} from './experimental-jit.js';
import {readShadowJson} from './playback-shadow-store.js';
import {DiagnosticLog} from './diagnostic-log.js';
import type {RecordingInventory} from './library-discovery.js';

export interface AutomaticCatalogPolicy {enabled:boolean;scanIntervalMs?:number;probeGapMs?:number}
export function compactCatalogProbe(probe:any){
 const fields=['index','codec_type','codec_name','profile','level','coded_width','coded_height','width','height','pix_fmt','field_order','channels','channel_layout','sample_rate','time_base','r_frame_rate','avg_frame_rate','start_time','duration','tags','disposition','sample_aspect_ratio','display_aspect_ratio','bits_per_raw_sample'];
 return {...(sourceProtection(probe)?{protection:sourceProtection(probe)}:{}),format:{duration:probe.format?.duration,format_name:probe.format?.format_name,start_time:probe.format?.start_time},executionDecoders:probe.executionDecoders,inputPictureStructure:probe.inputPictureStructure,inputPictureStructureEvidence:probe.inputPictureStructureEvidence,streams:(probe.streams??[]).map((s:any)=>Object.fromEntries(fields.filter(k=>s[k]!==undefined).map(k=>[k,s[k]])))};
}
/** Independent cooperative low-priority worker. SQL pending queue, one bounded header probe at a time. */
export function createCatalogBackground(directory:string,folders:()=>string[],trace:(event:string,detail:unknown)=>void,
 dependencies:{probe?:typeof inspectJitMetadata;busy?:()=>boolean;recordings?:(inventory:RecordingInventory)=>Promise<unknown>}={}){
 const probe=dependencies.probe??inspectJitMetadata;
 let db:MediaIndex|undefined,timer:ReturnType<typeof setTimeout>|undefined,job:Promise<void>|undefined,controller:AbortController|undefined;
 let closed=false,lastScan=0;
 const stats={running:false,queued:0,active:0,maxConcurrent:0,probed:0,cacheHits:0,failed:0,scans:0,metadataUpdateMs:0,lastError:null as string|null};
 const policy=()=>readShadowJson<AutomaticCatalogPolicy>(path.join(directory,'automatic.json'));
 async function cycle(force=false){
  if(closed)return;
  const p=await policy();if(closed)return;if(!p?.enabled){stats.running=false;stats.queued=0;return;}
  new DiagnosticLog(directory).assertSeparate(folders());
  db??=await openMediaIndex(directory);if(!stats.running){db.recoverProbes();db.queueHeaderProbes();stats.running=true;}
  if(force||Date.now()-lastScan>=Math.max(1000,p.scanIntervalMs??60000)){
   const roots=[...folders()],entries:RecordingInventory['entries']=[];
   const result=await db.scan(roots,directory,undefined,dependencies.recordings?e=>entries.push(e):undefined);lastScan=Date.now();stats.scans++;trace('CATALOG_SCAN',result);
   if(!closed&&dependencies.recordings)await dependencies.recordings({roots,entries,failedPaths:result.failedPaths});
  }
  stats.queued=db.probeQueue();
  if(closed||dependencies.busy?.()||!stats.queued)return;
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
  }catch(error){db.probeFailed(r,String(error),closed);if(!closed)stats.failed++;trace('CATALOG_PROBE_FAILED',{sourceId:r.objectId,error:String(error),cancelled:closed});}
  finally{clearTimeout(timeout);controller=undefined;stats.active=0;stats.queued=db.probeQueue();}
 }
 function run(force=false){if(job)return job;job=cycle(force).catch(error=>{stats.lastError=String(error);trace('CATALOG_BACKGROUND_ERROR',{error:String(error)});}).finally(()=>{job=undefined;});return job;}
 async function tick(){await run();if(!closed){const p=await policy().catch(()=>undefined);timer=setTimeout(tick,stats.queued?Math.max(20,p?.probeGapMs??100):1000);timer.unref();}}
 return {start(){if(!closed&&!timer&&!job)void tick();},runOnce:(forceScan=false)=>run(forceScan),status:()=>({...stats}),async stop(){closed=true;if(timer)clearTimeout(timer);controller?.abort();await job;db?.close();db=undefined;stats.running=false;}};
}
