import path from 'node:path';
import {promises as fs} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import {snapshotHash, type Fingerprint} from './playback-shadow.js';
import {DiagnosticLog} from './diagnostic-log.js';
import type {ExperimentalEntry} from './experimental-catalog.js';
import {discoverLibrary,withinSourcePath,type DiscoveryState} from './library-discovery.js';
import {FolderIndex,initializeFolders} from './folder-index.js';
import {stableId} from './core.js';

export const INDEX_FILE='media-index.sqlite';
export const CATALOG_PAGE_LIMIT=200;
/** Ignore conventional generated image caches only; video discovery is unchanged. */
export const photoCachePath=(file:string,root:string)=>path.relative(root,path.dirname(file)).split(path.sep).some(p=>['.cache','.thumbnails','image-cache','thumbcache'].includes(p.toLowerCase()));
export const canonicalPathKey=(file:string)=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
export const catalogSourceKey=(f:Fingerprint)=>snapshotHash(JSON.stringify({version:1,path:canonicalPathKey(f.path),size:f.size,mtimeMs:f.mtimeMs}));
export interface CatalogRow {
 objectId:string; path:string; filename:string; container:'mp4'|'mkv'|'avi'|'wmv'|'asf'|'webp'; size:number; mtimeMs:number;
 analysisKey:string; availability:'available'|'missing'; indexedAt:string; updatedAt:string;
 durationSeconds?:number; metadata?:unknown;
 probeStatus?:string; probeAttempts?:number;
}
function row(r:any):CatalogRow {
 return {objectId:r.id,path:r.source_path,filename:r.filename,container:r.container,size:r.size,mtimeMs:r.mtime,
  analysisKey:r.analysis_key,availability:r.availability,indexedAt:r.indexed_at,updatedAt:r.updated_at,
  probeStatus:r.probe_status,probeAttempts:r.probe_attempts,
  ...(r.duration!==null?{durationSeconds:r.duration}:{}),...(r.metadata?{metadata:JSON.parse(r.metadata)}:{})};
}

/** Dynamically loaded only for opt-in index use; Node 20 normal TS/legacy manifest remains independent. */
export async function openMediaIndex(directory:string) {
 await fs.mkdir(directory,{recursive:true});
 const {DatabaseSync}=await import('node:sqlite');
 const db=new DatabaseSync(path.join(directory,INDEX_FILE));
 try{
 db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
 CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value INTEGER NOT NULL) STRICT;
 INSERT OR IGNORE INTO state VALUES('version',1),('enabled',0),('update_id',0);
 CREATE TABLE IF NOT EXISTS media (
 id TEXT PRIMARY KEY,path_key TEXT NOT NULL UNIQUE,source_path TEXT NOT NULL,root TEXT NOT NULL,
 filename TEXT NOT NULL,container TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,
 analysis_key TEXT NOT NULL,availability TEXT NOT NULL,indexed_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 duration REAL,metadata TEXT
 ) STRICT;
 CREATE INDEX IF NOT EXISTS media_page ON media(availability,path_key,id);
 CREATE INDEX IF NOT EXISTS media_kind_page ON media(container,availability,path_key,id);
 CREATE INDEX IF NOT EXISTS media_root ON media(root,availability);
 CREATE INDEX IF NOT EXISTS media_analysis ON media(analysis_key);`);
 let version=Number(db.prepare("SELECT value FROM state WHERE key='version'").get()?.value);
 if(version===1){db.exec(`BEGIN IMMEDIATE;
 ALTER TABLE media ADD COLUMN probe_status TEXT NOT NULL DEFAULT 'pending';
 ALTER TABLE media ADD COLUMN probe_attempts INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE media ADD COLUMN probe_retry_at REAL NOT NULL DEFAULT 0;
 ALTER TABLE media ADD COLUMN probe_error TEXT;
 UPDATE media SET probe_status='ready' WHERE metadata IS NOT NULL;
 UPDATE state SET value=2 WHERE key='version'; COMMIT;`);version=2;}
 if(version===2){db.exec('BEGIN IMMEDIATE');initializeFolders(db);db.exec("UPDATE state SET value=3 WHERE key='version'; COMMIT");}
 else if(version!==3){db.close();throw Error('Unsupported catalog schema');}
 db.exec('CREATE INDEX IF NOT EXISTS media_probe ON media(availability,probe_status,probe_retry_at,path_key)');
 return new MediaIndex(db);
 }catch(error){try{db.close();}catch{}throw error;}
}
export class MediaIndex {
 constructor(private readonly db:DatabaseSync){}
 get folders(){return new FolderIndex(this.db);}
 close(){this.db.close();}
 get enabled(){return this.value('enabled')===1;}
 get updateId(){return this.value('update_id');}
 private value(key:string){return Number(this.db.prepare('SELECT value FROM state WHERE key=?').get(key)?.value??0);}
 enable(enabled:boolean){
  const ownTransaction=!this.db.isTransaction;
  if(ownTransaction)this.db.exec('BEGIN IMMEDIATE');
  try{if(this.enabled!==enabled){this.db.prepare("UPDATE state SET value=? WHERE key='enabled'").run(Number(enabled));this.bump();}if(ownTransaction)this.db.exec('COMMIT');}
  catch(error){if(ownTransaction)this.db.exec('ROLLBACK');throw error;}
 }
 private bump(){this.db.exec("UPDATE state SET value=(value+1)%4294967296 WHERE key='update_id'");}
 get(id:string){const r=this.db.prepare('SELECT * FROM media WHERE id=?').get(id);return r?row(r):undefined;}
 find(file:string){const r=this.db.prepare('SELECT * FROM media WHERE path_key=?').get(canonicalPathKey(file));return r?row(r):undefined;}
 photoCount(){return Number(this.db.prepare("SELECT count(*) n FROM media WHERE availability='available' AND container='webp'").get()!.n);}
 photoPage(start:number,count:number){if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||start<0||count<0)throw Error('Invalid photo page');return {entries:this.db.prepare("SELECT * FROM media WHERE availability='available' AND container='webp' ORDER BY path_key,id LIMIT ? OFFSET ?").all(Math.min(count||200,200),start).map(row),total:this.photoCount(),updateId:this.updateId};}
 count(){return Number(this.db.prepare("SELECT count(*) AS n FROM media WHERE availability='available' AND container!='webp'").get()!.n);}
 probeFailures(){return Number(this.db.prepare("SELECT count(*) n FROM media WHERE availability='available' AND probe_status='failed'").get()!.n);}
 probeQueue(now=Date.now()){
  return Number(this.db.prepare("SELECT count(*) n FROM media WHERE availability='available' AND (probe_status='pending' OR (probe_status='failed' AND probe_attempts<3 AND probe_retry_at<=?))").get(now)!.n);
 }
 nextProbe(now=Date.now()){
  const r=this.db.prepare("SELECT * FROM media WHERE availability='available' AND (probe_status='pending' OR (probe_status='failed' AND probe_attempts<3 AND probe_retry_at<=?)) ORDER BY path_key LIMIT 1").get(now);return r?row(r):undefined;
 }
 recoverProbes(){this.db.exec("UPDATE media SET probe_status='pending' WHERE probe_status='probing'");}
 queueHeaderProbes(){this.db.exec("UPDATE media SET probe_status='pending',probe_attempts=0 WHERE availability='available' AND container='mp4' AND probe_status='ready' AND json_valid(metadata) AND coalesce(json_extract(metadata,'$.colorMetadataVersion'),0)<2 AND EXISTS(SELECT 1 FROM json_each(metadata,'$.streams') s WHERE json_extract(s.value,'$.codec_name')='h264')");this.db.exec("UPDATE media SET probe_status='pending',probe_attempts=0 WHERE probe_status='ready' AND json_valid(metadata) AND json_extract(metadata,'$.inputPictureStructureEvidence') IS NULL AND EXISTS(SELECT 1 FROM json_each(metadata,'$.streams') s WHERE json_extract(s.value,'$.codec_name')='hevc' AND json_extract(s.value,'$.field_order') IS NULL)");}
 probeStarted(r:CatalogRow){return Number(this.db.prepare("UPDATE media SET probe_status='probing',probe_attempts=probe_attempts+1 WHERE id=? AND analysis_key=? AND availability='available'").run(r.objectId,r.analysisKey).changes)>0;}
 probeFailed(r:CatalogRow,error:string,cancelled=false){this.db.prepare("UPDATE media SET probe_status=?,probe_retry_at=?,probe_error=?,probe_attempts=max(0,probe_attempts-?) WHERE id=? AND analysis_key=?").run(cancelled?'pending':'failed',Date.now()+60000*Math.max(1,(r.probeAttempts??0)+1),error.slice(0,1024),cancelled?1:0,r.objectId,r.analysisKey);}
 position(id:string){const r=this.db.prepare("SELECT path_key FROM media WHERE id=? AND availability='available' AND container!='webp'").get(id);if(!r)return;return Number(this.db.prepare("SELECT count(*) n FROM media WHERE availability='available' AND container!='webp' AND (path_key<? OR (path_key=? AND id<?))").get(r.path_key,r.path_key,id)!.n);}
 page(start:number,count:number){
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||start<0||count<0)throw Error('Invalid catalog page');
  const limit=count===0?CATALOG_PAGE_LIMIT:Math.min(count,CATALOG_PAGE_LIMIT);
  // Both reads share a snapshot even while another process commits a scan.
  this.db.exec('BEGIN');try{
   const total=this.count(),updateId=this.updateId;
   const entries=this.db.prepare("SELECT * FROM media WHERE availability='available' AND container!='webp' ORDER BY path_key,id LIMIT ? OFFSET ?").all(limit,start).map(row);
   return {entries,total,updateId};
  }finally{this.db.exec('COMMIT');}
 }
 setMetadata(id:string,fingerprint:Fingerprint,metadata:unknown,durationSeconds:number){
  if(!Number.isFinite(durationSeconds)||durationSeconds<0||(durationSeconds===0&&this.get(id)?.container!=='webp'))throw Error('Invalid duration');
  this.db.exec('BEGIN IMMEDIATE');try{
  const result=this.db.prepare("UPDATE media SET metadata=?,duration=?,updated_at=?,probe_status='ready',probe_error=NULL WHERE id=? AND analysis_key=? AND availability='available' AND (metadata IS NOT ? OR duration IS NOT ? OR probe_status!='ready')")
   .run(JSON.stringify(metadata),durationSeconds,new Date().toISOString(),id,catalogSourceKey(fingerprint),JSON.stringify(metadata),durationSeconds);
  if(result.changes)this.bump();
  this.db.exec('COMMIT');return Number(result.changes)>0;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 /** Streaming discovery/stat only. A transaction publishes the complete change-set, never a partial deletion scan. */
 async scan(folders:string[],directory:string,io:Pick<typeof fs,'realpath'|'opendir'|'stat'>=fs,onRecording?:(entry:{file:string;stat:import('node:fs').Stats})=>void,controls:Pick<DiscoveryState,'signal'|'beforeDirectory'>={}){
  new DiagnosticLog(directory).assertSeparate(folders);
  const roots=[...new Set(folders.map(f=>canonicalPathKey(f)))];
  const began=performance.now(),rssBefore=process.memoryUsage().rss,now=new Date().toISOString();
  let rssPeak=rssBefore,enumerated=0,linksSkipped=0,statCalls=0;
  const discovery:DiscoveryState={failedPaths:[],linksSkipped:0,...controls};let publishing=false;
  this.db.exec(`DROP TABLE IF EXISTS temp.seen; CREATE TEMP TABLE seen(
   id TEXT PRIMARY KEY,path_key TEXT UNIQUE,source_path TEXT,root TEXT,filename TEXT,container TEXT,size INTEGER,mtime REAL,analysis_key TEXT);`);
  const insert=this.db.prepare('INSERT OR IGNORE INTO temp.seen VALUES(?,?,?,?,?,?,?,?,?)');
  try {
   const mapped=await Promise.all(roots.map(async key=>{const configured=path.resolve(folders.find(f=>canonicalPathKey(f)===key)!);return {configured,real:await io.realpath(configured).catch(()=>configured)};}));
   const hierarchy=this.folders.begin(mapped);discovery.onDirectory=hierarchy.directory;
   for await(const {file,stat:st,root} of discoverLibrary(roots,/\.(ts|m2ts|mts|mp4|mkv|avi|wmv|asf|webp)$/i,discovery,io)){
     if(/\.webp$/i.test(file)&&photoCachePath(file,root))continue;
     const pathKey=canonicalPathKey(file),encoded=/\.(mp4|mkv|avi|wmv|asf|webp)$/i.test(file);
     if(!/\.webp$/i.test(file))hierarchy.media(file,encoded?`experimental/item/${snapshotHash(pathKey).slice(0,32)}`:`item:${stableId(file)}`);
     if(!encoded){onRecording?.({file,stat:st});continue;}
     statCalls++;
     const fingerprint={path:file,size:st.size,mtimeMs:st.mtimeMs};
     insert.run(`experimental/item/${snapshotHash(pathKey).slice(0,32)}`,pathKey,file,root,path.basename(file),path.extname(file).slice(1).toLowerCase(),st.size,st.mtimeMs,catalogSourceKey(fingerprint));
     enumerated++;if(enumerated%256===0){rssPeak=Math.max(rssPeak,process.memoryUsage().rss);await new Promise<void>(r=>setImmediate(r));}
   }
   linksSkipped=discovery.linksSkipped;
   // Suppress deletion only for roots with incomplete discovery; additions and
   // changes remain publishable. A subsequent complete scan resolves deletions.
   const completeRoots=roots.filter(root=>!discovery.failedPaths.some(p=>withinSourcePath(p,root))&&!discovery.failedRoots?.some(p=>canonicalPathKey(p)===root));
   controls.signal?.throwIfAborted();const publishStarted=performance.now();this.db.exec('BEGIN IMMEDIATE');publishing=true;
   const foldersChanged=hierarchy.commit([...(discovery.failedRoots??[]),...discovery.failedPaths]);
   const n=(sql:string,...args:string[])=>Number(this.db.prepare(sql).get(...args)!.n);
   const added=n('SELECT count(*) n FROM temp.seen s LEFT JOIN media m ON s.id=m.id WHERE m.id IS NULL');
   const changed=n("SELECT count(*) n FROM temp.seen s JOIN media m ON s.id=m.id WHERE s.analysis_key!=m.analysis_key OR m.availability!='available' OR m.source_path!=s.source_path OR m.root!=s.root");
   const marks=completeRoots.map(()=>'?').join(',');
   const rootMarks=roots.map(()=>'?').join(',');
   const removedRoots=n(`SELECT count(*) n FROM media WHERE availability='available' AND root NOT IN (${rootMarks})`,...roots);
   const missing=removedRoots+(completeRoots.length?n(`SELECT count(*) n FROM media m WHERE m.root IN (${marks}) AND m.availability='available' AND NOT EXISTS(SELECT 1 FROM temp.seen s WHERE s.id=m.id)`,...completeRoots):0);
   this.db.prepare(`INSERT INTO media(id,path_key,source_path,root,filename,container,size,mtime,analysis_key,availability,indexed_at,updated_at)
    SELECT id,path_key,source_path,root,filename,container,size,mtime,analysis_key,'available',?,? FROM temp.seen WHERE true
    ON CONFLICT(id) DO UPDATE SET source_path=excluded.source_path,root=excluded.root,filename=excluded.filename,size=excluded.size,mtime=excluded.mtime,
    analysis_key=excluded.analysis_key,availability='available',updated_at=excluded.updated_at,
    duration=CASE WHEN media.analysis_key=excluded.analysis_key THEN media.duration ELSE NULL END,
    metadata=CASE WHEN media.analysis_key=excluded.analysis_key THEN media.metadata ELSE NULL END,
    probe_status=CASE WHEN media.analysis_key=excluded.analysis_key THEN media.probe_status ELSE 'pending' END,
    probe_attempts=CASE WHEN media.analysis_key=excluded.analysis_key THEN media.probe_attempts ELSE 0 END,
    probe_retry_at=CASE WHEN media.analysis_key=excluded.analysis_key THEN media.probe_retry_at ELSE 0 END
    WHERE media.analysis_key!=excluded.analysis_key OR media.availability!='available' OR media.source_path!=excluded.source_path OR media.root!=excluded.root`).run(now,now);
   if(completeRoots.length)this.db.prepare(`UPDATE media SET availability='missing',updated_at=? WHERE root IN (${marks}) AND availability='available' AND NOT EXISTS(SELECT 1 FROM temp.seen s WHERE s.id=media.id)`).run(now,...completeRoots);
   this.db.prepare(`UPDATE media SET availability='missing',updated_at=? WHERE availability='available' AND root NOT IN (${rootMarks})`).run(now,...roots);
   if(added+changed+missing||foldersChanged)this.bump();this.enable(true);this.db.exec('COMMIT');publishing=false;
   return {enumerated,active:this.count(),added,changed,missing,unchanged:enumerated-added-changed,linksSkipped,statCalls,failedPaths:discovery.failedPaths,foldersChanged,
    elapsedMs:performance.now()-began,publicationMs:performance.now()-publishStarted,rssBefore,rssPeak:Math.max(rssPeak,process.memoryUsage().rss),updateId:this.updateId};
  }catch(e){if(publishing)this.db.exec('ROLLBACK');throw e;}
 }
}
export function indexedExperimentalEntry(r:CatalogRow):ExperimentalEntry {
 return {objectId:r.objectId,filename:r.filename,fingerprint:{path:r.path,size:r.size,mtimeMs:r.mtimeMs},
  sourceState:r.metadata?'cached':'unanalysed',decisions:[],sourceStale:r.availability==='missing',lightweightProbe:r.metadata?{...(r.metadata as any),colorMetadataVersion:(r.metadata as any).colorMetadataVersion??0}:undefined};
}
