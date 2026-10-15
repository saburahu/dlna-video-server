import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {openMediaIndex,INDEX_FILE,CATALOG_PAGE_LIMIT,catalogSourceKey} from '../src/media-catalog-index.js';
import {createExperimentalCatalog,experimentalObjectId,experimentalBrowseSoap} from '../src/experimental-catalog.js';
import {browseDIDL} from '../src/upnp.js';
import {profiles} from '../src/core.js';
import {auditCadenceQuantization} from '../src/audit-cadence-quantization.js';

test('5000 file catalog: incremental atomic index, stable IDs, paged Browse without probes, restart and missing recovery',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'media-index-5000-')),media=path.join(root,'media'),cache=path.join(root,'cache');
 let db=await openMediaIndex(cache);const controllers:ReturnType<typeof createExperimentalCatalog>[]=[];
 t.after(async()=>{for(const c of controllers)await c.closeIndex();db.close();await fs.rm(root,{recursive:true,force:true});});
 const files:string[]=[];
 for(let d=0;d<20;d++){const folder=path.join(media,`日本語 ${String(d).padStart(3,'0')}`,...Array.from({length:8},(_,i)=>`階層${i}`));await fs.mkdir(folder,{recursive:true});
  await Promise.all(Array.from({length:250},(_,i)=>{const file=path.join(folder,`同名 ${String(i).padStart(4,'0')}.${i%2?'MKV':'mp4'}`);files.push(file);return fs.writeFile(file,'not video: do not probe');}));}
 await fs.writeFile(path.join(media,'ignored.ts'),'original');
 await fs.symlink(media,path.join(media,'cycle'),process.platform==='win32'?'junction':'dir');
 const initial=await db.scan([media],cache);assert.equal(initial.active,5000);assert.equal(initial.added,5000);assert.equal(initial.linksSkipped,1);
 const id=experimentalObjectId(files[0]),before=db.get(id)!;assert.ok(before);const originalVersion=db.updateId;
 const unchanged=await db.scan([media,media],cache);assert.equal(unchanged.added+unchanged.changed+unchanged.missing,0);assert.equal(db.updateId,originalVersion);
 assert.equal(db.find(files[0])?.objectId,id);assert.equal(db.get(id)!.updatedAt,before.updatedAt);
 const fp={path:before.path,size:before.size,mtimeMs:before.mtimeMs};assert.equal(catalogSourceKey(fp),before.analysisKey);
 assert.equal(db.setMetadata(id,fp,{format:{duration:'60'},streams:[]},60),true);assert.equal(db.get(id)?.durationSeconds,60);
 const request=(start:number,count:number,metadata=false,objectId='experimental')=>({objectId,start,count,metadata});
 const legacy=(metadata:boolean)=>browseDIDL('0',0,0,[], 'http://fixture',profiles.standard,metadata);
 let probes=0,executors=0;
 const c=createExperimentalCatalog(cache,()=>{},()=>[],{
  inspect:async()=>{probes++;throw Error('Browse must not inspect');},
  createRuntime:async()=>{executors++;throw Error('Browse must not encode');}
 });controllers.push(c);
 const times:Record<string,number>={},ids:string[]=[];
 for(let start=0;start<5000;start+=125){const began=performance.now(),page=await c.browse(request(start,125),'','http://fixture',legacy);assert.ok(page);assert.equal(page.total,5000);assert.equal(page.numberReturned,125);assert.ok(!page.didl.includes('<res'));assert.ok(!page.didl.includes(media));
  if([0,2500,4875].includes(start))times[String(start)]=performance.now()-began;
  ids.push(...[...page.didl.matchAll(/<item id="([^"]+)"/g)].map(m=>m[1]));}
 assert.equal(new Set(ids).size,5000);assert.equal(ids.length,5000);
 assert.equal(probes,0);assert.equal(executors,0);
 const all=await c.browse(request(0,0),'','http://fixture',legacy);assert.equal(all?.numberReturned,CATALOG_PAGE_LIMIT);
 const beyond=await c.browse(request(5000,25),'','http://fixture',legacy);assert.equal(beyond?.numberReturned,0);assert.equal(beyond?.total,5000);
 const http=createServer(async(req,res)=>{
  const u=new URL(req.url!,'http://localhost');const page=await c.browse(request(Number(u.searchParams.get('start')),125),'','http://fixture',legacy);
  res.setHeader('Content-Type','text/xml');res.end(experimentalBrowseSoap(page!,999));
 });http.listen(0,'127.0.0.1');await once(http,'listening');
 const httpTimes:Record<string,number>={};
 try{const address=http.address() as {port:number};for(const start of [0,2500,4875]){const began=performance.now();const response=await fetch(`http://127.0.0.1:${address.port}/browse?start=${start}`);const xml=await response.text();assert.ok(xml.includes('<NumberReturned>125</NumberReturned><TotalMatches>5000</TotalMatches>'));httpTimes[String(start)]=performance.now()-began;}}
 finally{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));}
 const meta=await c.browse(request(100,1,true,id),'','http://fixture',legacy);assert.equal(meta?.numberReturned,1);assert.equal(meta?.total,1);
 assert.ok(experimentalBrowseSoap(meta!,999).includes(`<UpdateID>${db.updateId}</UpdateID>`));
 assert.equal(await c.browse(request(0,20,false,'rec'),'','',legacy),undefined);
 const rootPage=await c.browse(request(0,2,false,'0'),'','http://fixture',legacy);assert.ok(rootPage?.didl.includes('childCount="5000"'));
 const newFile=path.join(media,'追加.mp4');await fs.writeFile(newFile,'added');await fs.appendFile(files[0],'changed');await fs.unlink(files[1]);
 const changed=await db.scan([media],cache);assert.equal(changed.added,1);assert.equal(changed.changed,1);assert.equal(changed.missing,1);assert.equal(changed.active,5000);
 assert.equal(db.get(id)?.objectId,id);assert.equal(db.get(id)?.metadata,undefined);assert.notEqual(db.get(id)?.analysisKey,before.analysisKey);assert.equal(db.get(experimentalObjectId(files[1]))?.availability,'missing');
 const failed=await db.scan([path.join(root,'absent')],cache);assert.equal(failed.failedPaths.length,1);assert.equal(db.count(),5000); // configured root list changed: folder UpdateID legitimately changes
 db.close();db=await openMediaIndex(cache);assert.equal(db.get(id)?.objectId,id);assert.equal(db.count(),5000);
 const current=db.get(id)!;await fs.utimes(files[0],new Date(),new Date(current.mtimeMs+2000));
 const mtime=await db.scan([media],cache);assert.equal(mtime.changed,1);assert.equal(db.get(id)?.objectId,id);
 const moved=path.join(media,'移動.mp4');await fs.rename(newFile,moved);const move=await db.scan([media],cache);assert.equal(move.added,1);assert.equal(move.missing,1);
 assert.equal(db.get(experimentalObjectId(newFile))?.availability,'missing');assert.ok(db.get(experimentalObjectId(moved)));
 const second=createExperimentalCatalog(cache,()=>{});controllers.push(second);assert.equal((await second.browse(request(0,25),'','http://fixture',legacy))?.total,5000);
 const storage:Record<string,number>={};for(const suffix of ['', '-wal','-shm'])storage[suffix||'database']=await fs.stat(path.join(cache,INDEX_FILE+suffix)).then(s=>s.size,()=>0);
 const data={initial,unchanged,changed,mtime,move,browseMs:times,httpBrowseMs:httpTimes,dbBytes:storage.database,storageBytes:storage,totalStorageBytes:Object.values(storage).reduce((a,b)=>a+b,0),ffmpegStartsDuringBrowse:executors,metadataProbesDuringBrowse:probes,idsStableAcrossRestart:true};
 console.log('CATALOG_5000 '+JSON.stringify(data));
 if(process.env.PT3_CATALOG_BENCHMARK_REPORT)await fs.writeFile(process.env.PT3_CATALOG_BENCHMARK_REPORT,JSON.stringify(data,null,2));
});

test('quantization audit distinguishes genuine short intervals and 33ms candidate artifacts without changing selection',()=>{
 const r=auditCadenceQuantization([0,2970,6030,9000,10530,11970],2989,.001);
 assert.equal(r.quantized33msCount,2);assert.equal(r.shortIntervalCount,2);assert.equal(r.quantized33msDeficitTicks,19);
 assert.equal(r.dropped,3);assert.equal(r.droppedByImmediateSourceInterval.quantized33ms,2);
});
