import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {configurePcrCache,pcrCacheEntryInfo} from './pcr-cache.js';
import {buildPcrIndex,forgetPcrIndex} from './pcr-index.js';
import {pcrWork,PcrDeferred} from './pcr-work.js';
import {sourcePathKey,withinSourcePath,type RecordingInventory} from './library-discovery.js';
import {DiagnosticLog} from './diagnostic-log.js';
import type {DatabaseSync} from 'node:sqlite';

export interface PcrBackgroundPolicy {enabled:boolean;paused:boolean;readBytesPerSecond:number;settleMs:number;idleGraceMs:number;minFreeBytes:number;maxDiskBytes:number|null;cleanupEnabled:boolean;cleanupGraceMs:number;cleanupBatch:number}
export const DEFAULT_PCR_POLICY:PcrBackgroundPolicy={enabled:true,paused:false,readBytesPerSecond:32*1024*1024,settleMs:120000,idleGraceMs:15000,minFreeBytes:2*1024**3,maxDiskBytes:null,cleanupEnabled:true,cleanupGraceMs:86400000,cleanupBatch:5};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export function validatePcrPolicy(input:unknown):PcrBackgroundPolicy{
 const p={...DEFAULT_PCR_POLICY,...input as object};
 for(const k of ['enabled','paused','cleanupEnabled'] as const)if(typeof p[k]!=='boolean')throw Error('Invalid '+k);
 for(const k of ['readBytesPerSecond','settleMs','idleGraceMs','minFreeBytes','cleanupGraceMs','cleanupBatch'] as const)if(!Number.isSafeInteger(p[k])||p[k]<0)throw Error('Invalid '+k);
 if(p.readBytesPerSecond<65536||p.readBytesPerSecond>64*1024**2||p.cleanupBatch<1||p.cleanupBatch>20||p.maxDiskBytes!==null&&(!Number.isSafeInteger(p.maxDiskBytes)||p.maxDiskBytes<1))throw Error('Invalid PCR resource limit');return p;
}
export function createPcrBackground(data:string,folders:()=>string[],trace:(event:string,detail:unknown)=>void,deps:{now?:()=>number;free?:()=>Promise<number>;busy?:()=>boolean;metadata?:(source:string,options:{background:true;bytesPerSecond:number})=>Promise<void>}={}){
 data=path.resolve(data);const cacheDir=path.join(data,'pcr-cache'),policyFile=path.join(data,'pcr-cache-policy.json'),now=deps.now??Date.now;
 let configuration:Promise<unknown>=Promise.resolve();let opening:Promise<void>|undefined;let db:DatabaseSync|undefined,policy={...DEFAULT_PCR_POLICY},timer:ReturnType<typeof setTimeout>|undefined,maintenance:Promise<void>|undefined,generation:Promise<void>|undefined;
 let closed=false,started=false,pending:RecordingInventory|undefined,lastMedia=now(),lastSpaceCheck=0,lastError:string|null=null,freeBytes:number|null=null,reason='starting',cleanupHold:string|null=null;
 const counters={success:0,failed:0,deferred:0,metadataSuccess:0,metadataFailed:0,metadataDeferred:0,cleaned:0,scans:0,initialInventoryFiles:0};
 async function initialize(){
  if(db)return;await fs.mkdir(data,{recursive:true});new DiagnosticLog(cacheDir).assertSeparate(folders());
  try{policy=validatePcrPolicy(JSON.parse(await fs.readFile(policyFile,'utf8')));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(path.join(data,'pcr-cache.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS pcr_sources(path_key TEXT PRIMARY KEY,source TEXT NOT NULL,root TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,stable_since REAL NOT NULL,observations INTEGER NOT NULL,last_seen INTEGER NOT NULL,retry_at REAL NOT NULL DEFAULT 0,error TEXT,cache_name TEXT,cache_key TEXT,cache_bytes INTEGER NOT NULL DEFAULT 0,missing_since REAL,missing_count INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS pcr_queue ON pcr_sources(state,retry_at,stable_since,path_key);
   CREATE TABLE IF NOT EXISTS pcr_roots(path_key TEXT PRIMARY KEY,source TEXT NOT NULL,identity TEXT,last_complete REAL,blocked TEXT);
   CREATE TABLE IF NOT EXISTS pcr_files(name TEXT PRIMARY KEY,bytes INTEGER NOT NULL,source_key TEXT,cache_key TEXT,valid INTEGER NOT NULL DEFAULT 0);
   UPDATE pcr_sources SET state='pending' WHERE state IN ('building','ready');`);
  const columns=new Set((db.prepare('PRAGMA table_info(pcr_sources)').all() as any[]).map(c=>c.name));
  for(const [name,type]of [['metadata_state','TEXT'],['metadata_retry_at','INTEGER NOT NULL DEFAULT 0'],['metadata_error','TEXT'],['metadata_attempts','INTEGER NOT NULL DEFAULT 0']])if(!columns.has(name))db.exec(`ALTER TABLE pcr_sources ADD COLUMN ${name} ${type}`);
  // Validate the existing metadata schema/fingerprint lazily, one row at a time.
  db.exec("UPDATE pcr_sources SET metadata_state=NULL,metadata_retry_at=0,metadata_error=NULL WHERE metadata_state='ready' OR metadata_state IS NULL");
  // One bounded-metadata directory reconciliation at startup, never per Browse/UI.
  const seen=new Set<string>();for(const name of await fs.readdir(cacheDir).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
   if(!/^[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(name))continue;
   const st=await fs.lstat(path.join(cacheDir,name));if(!st.isFile()||st.isSymbolicLink())continue;seen.add(name);db.prepare('INSERT INTO pcr_files(name,bytes) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes').run(name,st.size);counters.initialInventoryFiles++;
  }
  for(const row of db.prepare('SELECT name FROM pcr_files').all() as any[])if(!seen.has(row.name))db.prepare('DELETE FROM pcr_files WHERE name=?').run(row.name);
  installCachePolicy();pcrWork.pause(policy.paused||!policy.enabled);pcrWork.observer(trace);
 }
 function installCachePolicy(){configurePcrCache({maxDiskBytes:policy.maxDiskBytes,minFreeBytes:policy.minFreeBytes,usage:()=>Number((db!.prepare('SELECT coalesce(sum(bytes),0) bytes FROM pcr_files').get() as any).bytes)},entry=>{
  if(!db||closed)return;const key=sourcePathKey(entry.source),name=path.basename(entry.file);
  db.prepare('INSERT INTO pcr_files(name,bytes,source_key,cache_key,valid) VALUES(?,?,?,?,1) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes,source_key=excluded.source_key,cache_key=excluded.cache_key,valid=1').run(name,entry.bytes,key,entry.key);
  db.prepare("UPDATE pcr_sources SET cache_name=?,cache_key=?,cache_bytes=?,state=CASE WHEN fingerprint=? AND state IN ('pending','building','failed') THEN 'ready' ELSE state END WHERE path_key=?").run(name,entry.key,entry.bytes,entry.key,key);
 });}
 async function open(){if(opening)return opening;if(db)return;opening=initialize().catch(e=>{db?.close();db=undefined;throw e;}).finally(()=>{opening=undefined;});return opening;}
 async function ingest(snapshot:RecordingInventory){
  if(JSON.stringify(snapshot.roots)!==JSON.stringify(folders()))return;
  const roots=[...snapshot.roots].map(r=>path.resolve(r)).sort((a,b)=>b.length-a.length),serial=Number((db!.prepare('SELECT coalesce(max(last_seen),0)+1 value FROM pcr_sources').get() as any).value);counters.scans++;
  const actualRoots=new Map<string,string>(),identities=new Map<string,string>();for(const root of roots){try{const actual=await fs.realpath(root),s=await fs.stat(actual);actualRoots.set(sourcePathKey(root),actual);identities.set(sourcePathKey(root),JSON.stringify([sourcePathKey(actual),s.dev,s.ino]));}catch{}}
  if(JSON.stringify(snapshot.roots)!==JSON.stringify(folders()))return;
  db!.exec('BEGIN');try{
   for(const root of roots){const key=sourcePathKey(root),identity=identities.get(key),old=db!.prepare('SELECT identity FROM pcr_roots WHERE path_key=?').get(key) as any;
    const failed=snapshot.failedPaths.some(f=>withinSourcePath(f,root)||withinSourcePath(root,f));
    db!.prepare('INSERT INTO pcr_roots(path_key,source,identity,last_complete,blocked) VALUES(?,?,?,?,?) ON CONFLICT(path_key) DO UPDATE SET identity=coalesce(pcr_roots.identity,excluded.identity),source=excluded.source,last_complete=excluded.last_complete,blocked=excluded.blocked').run(key,root,identity??null,!failed&&identity?now():null,!identity||failed?'incomplete-scan':old?.identity&&old.identity!==identity?'root-identity-changed':null);
   }
   for(const {file,stat} of snapshot.entries){const root=roots.find(r=>withinSourcePath(file,actualRoots.get(sourcePathKey(r))??r));if(!root)continue;const key=sourcePathKey(file),fingerprint=`${stat.size}:${stat.mtimeMs}`,old=db!.prepare('SELECT * FROM pcr_sources WHERE path_key=?').get(key) as any;
    const changed=!old||old.fingerprint!==fingerprint||['missing','detached','cleaned'].includes(old.state);const name=old?.cache_name??hash(sourcePathKey(file))+'.json';
    db!.prepare(`INSERT INTO pcr_sources(path_key,source,root,size,mtime,fingerprint,state,stable_since,observations,last_seen,cache_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(path_key) DO UPDATE SET root=excluded.root,size=excluded.size,mtime=excluded.mtime,fingerprint=excluded.fingerprint,state=excluded.state,stable_since=excluded.stable_since,observations=excluded.observations,last_seen=excluded.last_seen,missing_since=NULL,missing_count=0,retry_at=CASE WHEN pcr_sources.fingerprint=excluded.fingerprint THEN pcr_sources.retry_at ELSE 0 END,error=CASE WHEN pcr_sources.fingerprint=excluded.fingerprint THEN pcr_sources.error ELSE NULL END`)
     .run(key,old?.source??path.resolve(file),sourcePathKey(root),stat.size,stat.mtimeMs,fingerprint,changed||['missing','detached'].includes(old?.state)?'pending':old.state,changed?now():old.stable_since,changed?1:old.observations+1,serial,name);
    db!.prepare('UPDATE pcr_files SET source_key=? WHERE name=?').run(key,name);
    if(changed)db!.prepare('UPDATE pcr_sources SET metadata_state=NULL,metadata_retry_at=0,metadata_error=NULL,metadata_attempts=0 WHERE path_key=?').run(key);
   }
   for(const old of db!.prepare('SELECT * FROM pcr_sources WHERE last_seen<>?').all(serial) as any[]){
    const current=roots.some(r=>sourcePathKey(r)===old.root),root=db!.prepare('SELECT blocked FROM pcr_roots WHERE path_key=?').get(old.root) as any;
    if(!current)db!.prepare("UPDATE pcr_sources SET state='detached',missing_count=0 WHERE path_key=?").run(old.path_key);
    else if(!root?.blocked)db!.prepare("UPDATE pcr_sources SET state='missing',missing_since=coalesce(missing_since,?),missing_count=missing_count+1 WHERE path_key=?").run(now(),old.path_key);
    else db!.prepare('UPDATE pcr_sources SET missing_count=0 WHERE path_key=?').run(old.path_key);
   }
   db!.exec('COMMIT');
  }catch(e){db!.exec('ROLLBACK');throw e;}
 }
 async function space(){if(freeBytes===null||now()-lastSpaceCheck>5000){freeBytes=deps.free?await deps.free():await fs.statfs(data).then(s=>s.bavail*s.bsize);lastSpaceCheck=now();}return freeBytes!;}
 async function generate(row:any){
  db!.prepare("UPDATE pcr_sources SET state='building',error=NULL WHERE path_key=?").run(row.path_key);
  try{
   const st=await fs.stat(row.source);if(`${st.size}:${st.mtimeMs}`!==row.fingerprint)throw new PcrDeferred('source-changed');
   const existing=await pcrCacheEntryInfo(row.source);
   if((row.observations<2||row.stable_since>now()-policy.settleMs||st.mtimeMs>now()-policy.settleMs)&&existing?.key!==row.fingerprint)throw new PcrDeferred('source-settling');
   const index=await buildPcrIndex(row.source,{background:true,bytesPerSecond:policy.readBytesPerSecond});
   const cache=await pcrCacheEntryInfo(row.source);
   if(!cache||cache.key!==row.fingerprint)throw new PcrDeferred('cache-not-persisted');
   db!.prepare("UPDATE pcr_sources SET state=?,cache_key=?,cache_bytes=?,error=NULL,retry_at=0 WHERE path_key=? AND fingerprint=? AND state IN ('building','ready')").run(index?'ready':'unsupported',row.fingerprint,cache?.bytes??0,row.path_key,row.fingerprint);
   if(cache)db!.prepare('INSERT INTO pcr_files(name,bytes,source_key,cache_key,valid) VALUES(?,?,?,?,1) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes,source_key=excluded.source_key,cache_key=excluded.cache_key,valid=1').run(row.cache_name,cache.bytes,row.path_key,row.fingerprint);
   counters.success++;trace('PCR_BACKGROUND_COMPLETE',{source:row.source,valid:!!index});
   const metadata=db!.prepare('SELECT * FROM pcr_sources WHERE path_key=?').get(row.path_key) as any;
   if(deps.metadata&&metadata.metadata_state!=='failed'&&metadata.metadata_retry_at<=now())await generateMetadata(metadata);
  }catch(e){const deferred=e instanceof PcrDeferred||(e as Error).name==='AbortError';if(deferred)counters.deferred++;else counters.failed++;
   db!.prepare("UPDATE pcr_sources SET state=?,error=?,retry_at=? WHERE path_key=? AND fingerprint=? AND state IN ('building','ready')").run(deferred?'pending':'failed',String(e),now()+(deferred?5000:60000),row.path_key,row.fingerprint);trace('PCR_BACKGROUND_DEFERRED',{source:row.source,error:String(e),deferred});
   if(deps.metadata&&e instanceof PcrDeferred&&e.reason==='source-changed')db!.prepare('UPDATE pcr_sources SET observations=1,stable_since=? WHERE path_key=?').run(now(),row.path_key);
  }
 }
 async function generateMetadata(row:any){
  try{
   if(pcrWork.busy()||deps.busy?.())throw new PcrDeferred('playback');
   const st=await fs.stat(row.source);if(`${st.size}:${st.mtimeMs}`!==row.fingerprint)throw new PcrDeferred('source-changed');
   await deps.metadata!(row.source,{background:true,bytesPerSecond:policy.readBytesPerSecond});
   db!.prepare("UPDATE pcr_sources SET metadata_state='ready',metadata_retry_at=0,metadata_error=NULL,metadata_attempts=0 WHERE path_key=? AND fingerprint=?").run(row.path_key,row.fingerprint);counters.metadataSuccess++;
  }catch(e){const deferred=e instanceof PcrDeferred||(e as Error).name==='AbortError';if(deferred)counters.metadataDeferred++;else counters.metadataFailed++;
   const attempts=(row.metadata_attempts??0)+(deferred?0:1),exhausted=attempts>=3;
   db!.prepare("UPDATE pcr_sources SET metadata_state=?,metadata_retry_at=?,metadata_error=?,metadata_attempts=? WHERE path_key=? AND fingerprint=?").run(exhausted?'failed':'pending',exhausted?0:now()+(deferred?5000:attempts===1?60000:300000),String(e),attempts,row.path_key,row.fingerprint);
   if(e instanceof PcrDeferred&&e.reason==='source-changed')db!.prepare("UPDATE pcr_sources SET state='pending',observations=1,stable_since=? WHERE path_key=?").run(now(),row.path_key);
   trace('RECORDING_METADATA_DEFERRED',{source:row.source,deferred,error:String(e)});
  }
 }
 async function cleanup(){
  cleanupHold=null;if(!policy.cleanupEnabled||generation)return;
  const rows=db!.prepare("SELECT s.*,r.source root_source,r.identity,r.blocked FROM pcr_sources s JOIN pcr_roots r ON r.path_key=s.root WHERE s.state='missing' AND s.missing_count>=2 AND s.missing_since<=? AND r.blocked IS NULL ORDER BY s.missing_since,s.path_key LIMIT ?").all(now()-policy.cleanupGraceMs,policy.cleanupBatch) as any[];
  for(const row of rows){
   if(!folders().some(r=>sourcePathKey(r)===row.root)||pcrWork.busy(row.source))continue;
   const mass=db!.prepare("SELECT count(*) total,sum(CASE WHEN state='missing' THEN 1 ELSE 0 END) missing FROM pcr_sources WHERE root=? AND state<>'cleaned'").get(row.root) as any;
   if(mass.missing>Math.max(20,mass.total/4)){cleanupHold='mass-disappearance';continue;}
   try{
    const real=await fs.realpath(row.root_source),st=await fs.stat(real);
    if(!withinSourcePath(row.source,real)||JSON.stringify([sourcePathKey(real),st.dev,st.ino])!==row.identity){cleanupHold='root-identity-changed';continue;}
    await fs.readdir(row.root_source);
    try{await fs.stat(row.source);cleanupHold='source-present';continue;}catch(e:any){if(e.code!=='ENOENT'){cleanupHold='source-inaccessible';continue;}}
    const dir=await fs.lstat(cacheDir);if(!dir.isDirectory()||dir.isSymbolicLink()){cleanupHold='cache-directory-link';continue;}
    if(![hash(sourcePathKey(row.source))+'.json',hash(path.resolve(row.source))+'.json'].includes(row.cache_name)){cleanupHold='unmapped-cache';continue;}
    const entry=await pcrCacheEntryInfo(row.source);
    if(!entry||path.basename(entry.file)!==row.cache_name||!row.cache_key||entry.key!==row.cache_key){cleanupHold='cache-key-unconfirmed';continue;}
    const current=db!.prepare('SELECT state,missing_count,cache_key FROM pcr_sources WHERE path_key=?').get(row.path_key) as any;
    if(pcrWork.busy()||deps.busy?.()||pcrWork.busy(row.source)||current?.state!=='missing'||current.missing_count<2||current.cache_key!==entry.key)continue;
    await fs.unlink(entry.file);
    forgetPcrIndex(row.source);
    db!.prepare('DELETE FROM pcr_files WHERE name=?').run(row.cache_name);db!.prepare("UPDATE pcr_sources SET state='cleaned',cache_bytes=0 WHERE path_key=?").run(row.path_key);
    counters.cleaned++;trace('PCR_CACHE_CLEANED',{source:row.source,cache:row.cache_name,bytes:entry.bytes});
   }catch(e){cleanupHold='cleanup-access-error';trace('PCR_CACHE_CLEANUP_HELD',{source:row.source,error:String(e)});}
  }
 }
 async function cycle(){
  await open();if(closed)return;if(pending){const snapshot=pending;pending=undefined;await ingest(snapshot);}
  if(pcrWork.busy()||deps.busy?.()){lastMedia=now();reason='playback';if(deps.busy?.())pcrWork.interrupt('jit-playback');return;}
  if(!policy.enabled||process.env.PT3_PCR_BACKGROUND_DISABLED==='1'){reason='disabled';return;}
  if(policy.paused){reason='paused';return;}
  if(now()-lastMedia<policy.idleGraceMs){reason='idle-grace';return;}
  if(await space()<policy.minFreeBytes+64*1024**2){reason='low-free-space';pcrWork.interrupt(reason);return;}
  await cleanup();
  if(policy.maxDiskBytes!==null&&Number((db!.prepare('SELECT coalesce(sum(bytes),0) bytes FROM pcr_files').get() as any).bytes)>=policy.maxDiskBytes){reason='capacity-limit';return;}
  if(generation){reason='generating';return;}
  // A stable startup inventory must not wait for the next (possibly 30 minute)
  // directory scan. Confirm at most one source stat per cycle after settling.
  if(deps.metadata){const candidate=db!.prepare("SELECT s.* FROM pcr_sources s JOIN pcr_roots r ON r.path_key=s.root WHERE s.state='pending' AND s.observations<2 AND s.retry_at<=? AND s.stable_since<=? AND s.mtime<=? AND r.blocked IS NULL ORDER BY s.retry_at,s.path_key LIMIT 1").get(now(),now()-policy.settleMs,now()-policy.settleMs) as any;
   if(candidate)try{const s=await fs.stat(candidate.source);if(`${s.size}:${s.mtimeMs}`===candidate.fingerprint)db!.prepare('UPDATE pcr_sources SET observations=2 WHERE path_key=?').run(candidate.path_key);
    else db!.prepare('UPDATE pcr_sources SET size=?,mtime=?,fingerprint=?,stable_since=?,retry_at=?,observations=1 WHERE path_key=?').run(s.size,s.mtimeMs,`${s.size}:${s.mtimeMs}`,now(),now()+policy.settleMs,candidate.path_key);
   }catch(e:any){db!.prepare("UPDATE pcr_sources SET state=?,retry_at=?,error=? WHERE path_key=?").run(e.code==='ENOENT'?'missing':'pending',now()+60000,String(e),candidate.path_key);}
  }
  const row=db!.prepare("SELECT s.* FROM pcr_sources s LEFT JOIN pcr_roots r ON r.path_key=s.root WHERE s.state IN ('pending','failed') AND s.retry_at<=? AND r.blocked IS NULL AND ((s.observations>=2 AND s.stable_since<=? AND s.mtime<=?) OR EXISTS(SELECT 1 FROM pcr_files f WHERE f.name=s.cache_name)) ORDER BY s.retry_at,s.path_key LIMIT 1").get(now(),now()-policy.settleMs,now()-policy.settleMs) as any;
  if(!row){
   const metadata=deps.metadata&&db!.prepare("SELECT s.* FROM pcr_sources s LEFT JOIN pcr_roots r ON r.path_key=s.root WHERE s.state IN ('ready','unsupported') AND coalesce(s.metadata_state,'pending')='pending' AND s.metadata_retry_at<=? AND r.blocked IS NULL ORDER BY s.metadata_retry_at,s.path_key LIMIT 1").get(now()) as any;
   if(metadata){reason='metadata';generation=generateMetadata(metadata).finally(()=>{generation=undefined;});return;}
   reason='settling-or-complete';return;
  }reason='generating';generation=generate(row).finally(()=>{generation=undefined;});
 }
 function run(){if(maintenance)return maintenance;maintenance=cycle().catch(e=>{lastError=String(e);reason='error';trace('PCR_BACKGROUND_ERROR',{error:String(e)});}).finally(()=>{maintenance=undefined;});return maintenance;}
 async function tick(){await run();if(!closed){timer=setTimeout(tick,1000);timer.unref();}}
 return {
  /** Cache refresh remains read-only w.r.t. TS; only enqueue invalidated cache rows. */
  async recheckMetadata(sources:string[]){await open();if(closed)return;db!.exec('BEGIN');try{for(const source of sources)db!.prepare("UPDATE pcr_sources SET metadata_state='pending',metadata_retry_at=0,metadata_attempts=0 WHERE path_key=? AND state IN ('ready','unsupported')").run(sourcePathKey(source));db!.exec('COMMIT');}catch(e){db!.exec('ROLLBACK');throw e;}},
  accept(snapshot:RecordingInventory){pending=snapshot;},
  start(){if(!started&&!closed){started=true;void tick();}},
  runOnce:run,
  async inspect(){await open();try{await space();}catch(e){lastError=String(e);}return this.status();},
  status(){const counts=db?.prepare('SELECT state,count(*) count FROM pcr_sources GROUP BY state').all()??[],usage=db?.prepare('SELECT count(*) files,coalesce(sum(bytes),0) bytes FROM pcr_files').get();const rootHolds=db?.prepare('SELECT source,blocked reason FROM pcr_roots WHERE blocked IS NOT NULL').all()??[],recentErrors=db?.prepare('SELECT source,error,retry_at FROM pcr_sources WHERE error IS NOT NULL ORDER BY retry_at DESC LIMIT 5').all()??[];const metadataCounts=db?.prepare("SELECT coalesce(metadata_state,'pending') state,count(*) count FROM pcr_sources GROUP BY metadata_state").all()??[];return {policy:{...policy},reason,cleanupHold,rootHolds,recentErrors,metadataCounts,freeBytes,lastError,...counters,counts,usage,work:pcrWork.status()};},
  configure(patch:Partial<PcrBackgroundPolicy>){const job=configuration.then(async()=>{await open();if(closed)throw Error('PCR manager stopped');const next=validatePcrPolicy({...policy,...patch}),tmp=policyFile+'.tmp';await fs.writeFile(tmp,JSON.stringify(next,null,2));await fs.rename(tmp,policyFile);policy=next;installCachePolicy();pcrWork.pause(policy.paused||!policy.enabled);lastSpaceCheck=0;return this.status();});configuration=job.catch(()=>{});return job;},
  async stop(){closed=true;if(timer)clearTimeout(timer);pcrWork.cancelBackground('shutdown');await configuration;await maintenance;await generation;pcrWork.observer(()=>{});configurePcrCache({maxDiskBytes:null,minFreeBytes:2*1024**3});db?.close();db=undefined;}
 };
}
