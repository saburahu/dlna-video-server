import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('one periodic catalog traversal also publishes TS changes, preserves IDs/UpdateID, protects failed roots and stops cleanly',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'automatic-ts-')),data=path.join(root,'state'),media=path.join(root,'録画'),directory=path.join(data,'experimental-catalog');
 await fs.mkdir(media);await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'automatic.json'),JSON.stringify({enabled:true,scanIntervalMs:1000}));
 process.env.PT3_DATA_DIR=data;const store=await import('../src/store.js');await store.loadStore();await store.updateSettings({folders:[media]});
 const {createCatalogBackground}=await import('../src/catalog-background.js'),{openMediaIndex}=await import('../src/media-catalog-index.js');
 let probes=0;const worker=createCatalogBackground(directory,()=>store.settings.folders,()=>{},{busy:()=>true,probe:async()=>{probes++;throw Error('No probe allowed in stat-only test');},recordings:i=>store.scanFolders(()=>{},i)});
 const db=await openMediaIndex(directory);t.after(async()=>{await worker.stop();db.close();await fs.rm(root,{recursive:true,force:true});});
 const first=path.join(media,'最初.ts');await fs.writeFile(first,'fixture');await fs.writeFile(path.join(media,'映画.mp4'),'fixture');
 worker.start();const until=async(predicate:()=>boolean)=>{for(let n=0;n<150&&!predicate();n++)await new Promise(r=>setTimeout(r,20));assert.ok(predicate());await worker.runOnce();};
 await until(()=>store.programs.length===1&&db.count()===1);const id=store.programs[0].id,update=store.systemUpdateId,sqlUpdate=db.updateId;
 await worker.runOnce(true);assert.equal(store.systemUpdateId,update);assert.equal(db.updateId,sqlUpdate);assert.equal(probes,0);
 const nested=path.join(media,'深い');await fs.mkdir(nested);const added=path.join(nested,'追加.ts'),avi=path.join(nested,'追加.avi');await fs.writeFile(added,'fixture');await fs.writeFile(avi,'fixture');
 await until(()=>store.programs.length===2&&db.count()===2);assert.equal(store.programs.find(p=>p.filePath===first)!.id,id);
 await fs.appendFile(first,'more');await worker.runOnce(true);assert.equal(store.programs.find(p=>p.id===id)!.size,11);
 await fs.unlink(added);await fs.unlink(avi);await until(()=>store.programs.length===1&&db.count()===1);
 const open=fs.opendir;try{fs.opendir=((folder:any)=>folder===media?Promise.reject(Object.assign(Error('denied'),{code:'EACCES'})):open(folder)) as typeof fs.opendir;await worker.runOnce(true);assert.equal(store.programs.length,1);assert.equal(store.programs[0].id,id);assert.equal(db.count(),1);}finally{fs.opendir=open;}
 await store.scanFolders(()=>{},{roots:[path.join(root,'stale-root')],entries:[],failedPaths:[]});assert.equal(store.programs.length,1);
 const a=store.scanFolders(()=>{}),b=store.scanFolders(()=>{});assert.equal(a,b);await a;
 await worker.stop();await fs.writeFile(path.join(media,'停止後.ts'),'fixture');await worker.runOnce(true);assert.equal(store.programs.length,1);assert.equal(probes,0);
});

test('5000-entry mixed library shares TS stat inventory with the indexed scan without probes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'inventory-5000-')),media=path.join(root,'media'),directory=path.join(root,'index');await fs.mkdir(media);await fs.mkdir(directory);
 await fs.writeFile(path.join(directory,'automatic.json'),JSON.stringify({enabled:true,scanIntervalMs:60000}));
 await Promise.all(Array.from({length:5000},(_,i)=>fs.writeFile(path.join(media,`番組-${String(i).padStart(5,'0')}.${i%50===0?'ts':'mkv'}`),'fixture')));
 const {createCatalogBackground}=await import('../src/catalog-background.js'),{openMediaIndex}=await import('../src/media-catalog-index.js');
 let recordings=0,probes=0;const worker=createCatalogBackground(directory,()=>[media],()=>{},{busy:()=>true,probe:async()=>{probes++;throw Error('unexpected probe');},recordings:async i=>{recordings=i.entries.length;}}),db=await openMediaIndex(directory);
 t.after(async()=>{await worker.stop();db.close();await fs.rm(root,{recursive:true,force:true});});
 const start=performance.now();await worker.runOnce(true);const initialMs=performance.now()-start,version=db.updateId;
 const again=performance.now();await worker.runOnce(true);const incrementalMs=performance.now()-again;
 const at=performance.now();assert.equal(db.page(2450,125).entries.length,125);const browseMs=performance.now()-at;
 assert.equal(db.count(),4900);assert.equal(recordings,100);assert.equal(db.updateId,version);assert.equal(probes,0);
 console.log('AUTOMATIC_INVENTORY_5000 '+JSON.stringify({initialMs,incrementalMs,browseMs,recordings,encoded:db.count(),probes,rss:process.memoryUsage().rss}));
});
