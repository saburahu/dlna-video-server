import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPcrBackground} from '../src/pcr-background.js';
import {buildPcrIndex,clearPcrIndexCache} from '../src/pcr-index.js';
import {pcrCacheEntryInfo,configurePcrCache,pcrCacheStatus} from '../src/pcr-cache.js';
import {pcrWork} from '../src/pcr-work.js';
import {syntheticTs} from './ts-fixture.js';

async function fixture(t:any){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-retention-')),media=path.join(dir,'media'),data=path.join(dir,'data');await fs.mkdir(media);
 const old=process.env.PT3_DATA_DIR;process.env.PT3_DATA_DIR=data;clearPcrIndexCache();
 let roots=[media],clock=Date.now()+1e6;const worker=createPcrBackground(data,()=>roots,()=>{},{now:()=>clock,free:async()=>10*1024**3});
 await worker.configure({paused:true,settleMs:0,idleGraceMs:0,cleanupGraceMs:1000});
 const files:string[]=[];for(const folder of ['a','b']){await fs.mkdir(path.join(media,folder));const f=path.join(media,folder,'same.ts');await fs.writeFile(f,syntheticTs(3000,5000));await fs.utimes(f,1,1);files.push(f);}
 const scan=async(failedPaths:string[]=[])=>{const entries=[];for(const file of files){const stat=await fs.stat(file).catch(()=>undefined);if(stat)entries.push({file,stat});}worker.accept({roots:[...roots],entries,failedPaths});await worker.runOnce();};
 await scan();for(const f of files)await buildPcrIndex(f);await scan();
 t.after(async()=>{await worker.stop();pcrWork.pause(false);clearPcrIndexCache();if(old===undefined)delete process.env.PT3_DATA_DIR;else process.env.PT3_DATA_DIR=old;await fs.rm(dir,{recursive:true,force:true});});
 return {dir,media,data,files,worker,scan,advance:()=>clock+=2000,roots:(r:string[])=>roots=r};
}

test('PCR cleanup requires two successful scans/grace, retains same-name sibling and active playback',async t=>{
 const f=await fixture(t),original=await pcrCacheEntryInfo(f.files[0]);assert.ok(original);
 await fs.unlink(f.files[0]);await f.scan();f.advance();await f.worker.configure({paused:false});await f.worker.runOnce();
 assert.ok(await pcrCacheEntryInfo(f.files[0]),'one missing observation is insufficient');
 const release=pcrWork.reserve(f.files[0]);await f.scan();assert.ok(await pcrCacheEntryInfo(f.files[0]));release();
 await f.worker.runOnce();assert.equal(await pcrCacheEntryInfo(f.files[0]),undefined);assert.ok(await pcrCacheEntryInfo(f.files[1]));assert.equal(f.worker.status().cleaned,1);
 assert.equal(f.worker.status().policy.maxDiskBytes,null);
});

test('PCR failed scan and removed root preserve cache; unknown files are never deleted',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.data,'pcr-cache','unrelated.txt'),'keep');await fs.unlink(f.files[0]);f.advance();
 await f.scan([f.media]);await f.scan([f.media]);await f.worker.configure({paused:false});await f.worker.runOnce();assert.ok(await pcrCacheEntryInfo(f.files[0]));
 f.roots([]);await f.scan();await f.scan();assert.ok(await pcrCacheEntryInfo(f.files[0]));assert.equal(f.worker.status().cleaned,0);
 assert.equal(await fs.readFile(path.join(f.data,'pcr-cache','unrelated.txt'),'utf8'),'keep');
});

test('PCR capacity blocks new writes rather than evicting valid cache; low space leaves index usable',async t=>{
 const f=await fixture(t),before=await pcrCacheEntryInfo(f.files[0]);assert.ok(before);const bytes=await fs.readFile(before.file);
 await f.worker.configure({maxDiskBytes:1});const extra=path.join(f.media,'extra.ts');await fs.writeFile(extra,syntheticTs(4000,6000));
 assert.ok(await buildPcrIndex(extra));assert.equal(await pcrCacheEntryInfo(extra),undefined);assert.equal(pcrCacheStatus().skipped,'capacity-limit');
 assert.deepEqual(await fs.readFile(before.file),bytes);
 configurePcrCache({maxDiskBytes:null,minFreeBytes:Number.MAX_SAFE_INTEGER});clearPcrIndexCache();assert.ok(await buildPcrIndex(extra));assert.equal(pcrCacheStatus().skipped,'low-free-space');
 assert.deepEqual(await fs.readFile(before.file),bytes);
});

test('PCR Windows path case variants share one entry and legacy cache remains readable', {skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),before=await pcrCacheEntryInfo(f.files[0]);assert.ok(before);
 clearPcrIndexCache();assert.ok(await buildPcrIndex(f.files[0].toUpperCase()));
 assert.equal((await pcrCacheEntryInfo(f.files[0].toUpperCase()))?.file,before.file);
 const {createHash}=await import('node:crypto');const legacy=path.join(f.data,'pcr-cache',createHash('sha256').update(path.resolve(f.files[0])).digest('hex')+'.json');
 if(legacy!==before.file){await fs.rename(before.file,legacy);clearPcrIndexCache();assert.ok(await buildPcrIndex(f.files[0]));assert.equal((await pcrCacheEntryInfo(f.files[0]))?.file,legacy);assert.equal(await fs.stat(before.file).catch(()=>undefined),undefined);}
});

test('PCR replaced root identity does not authorize deletion even with complete empty scans',async t=>{
 const f=await fixture(t);await fs.rename(f.media,f.media+'-offline');await fs.mkdir(f.media);f.advance();
 await f.scan();await f.scan();await f.worker.configure({paused:false});await f.worker.runOnce();
 assert.ok(await pcrCacheEntryInfo(f.files[0]));assert.ok(await pcrCacheEntryInfo(f.files[1]));assert.equal(f.worker.status().cleaned,0);
});

test('PCR missing confirmation survives restart without deleting other caches',async t=>{
 const f=await fixture(t);await fs.unlink(f.files[0]);await f.scan();f.advance();await f.worker.configure({paused:false});await f.worker.stop();
 const restored=createPcrBackground(f.data,()=>[f.media],()=>{},{now:()=>Date.now()+2e6,free:async()=>10*1024**3});
 try{restored.accept({roots:[f.media],entries:[{file:f.files[1],stat:await fs.stat(f.files[1])}],failedPaths:[]});await restored.runOnce();
 assert.equal(await pcrCacheEntryInfo(f.files[0]),undefined);assert.ok(await pcrCacheEntryInfo(f.files[1]));assert.equal(restored.status().cleaned,1);}finally{await restored.stop();}
});

test('PCR mass disappearance holds all automatic deletions for review',async t=>{
 const f=await fixture(t);for(let n=0;n<21;n++){const file=path.join(f.media,n+'.ts');await fs.writeFile(file,syntheticTs(1000,5000));f.files.push(file);}
 await f.scan();for(const file of f.files)await buildPcrIndex(file);
 const before=await fs.readdir(path.join(f.data,'pcr-cache'));for(const file of f.files)await fs.unlink(file);
 await f.scan();f.advance();await f.scan();await f.worker.configure({paused:false});await f.worker.runOnce();
 assert.equal(f.worker.status().cleanupHold,'mass-disappearance');assert.equal(f.worker.status().cleaned,0);assert.deepEqual(await fs.readdir(path.join(f.data,'pcr-cache')),before);
});

test('PCR restored source with identical fingerprint is queued and persisted again',async t=>{
 const f=await fixture(t),old=await fs.stat(f.files[0]);await fs.unlink(f.files[0]);await f.scan();f.advance();await f.scan();await f.worker.configure({paused:false});await f.worker.runOnce();
 assert.equal(await pcrCacheEntryInfo(f.files[0]),undefined);
 await fs.writeFile(f.files[0],syntheticTs(3000,5000));await fs.utimes(f.files[0],1,1);assert.equal((await fs.stat(f.files[0])).mtimeMs,old.mtimeMs);
 await f.scan();assert.equal(await pcrCacheEntryInfo(f.files[0]),undefined,'restoration must settle again');await f.scan();
 for(let i=0;i<100&&!await pcrCacheEntryInfo(f.files[0]);i++)await new Promise(r=>setTimeout(r,10));
 assert.ok(await pcrCacheEntryInfo(f.files[0]));
});

test('PCR explicit linked root maps physical inventory without duplicate cache and cleans only confirmed deletion',async t=>{
 const f=await fixture(t),link=path.join(f.dir,'registered-link');await fs.symlink(f.media,link,process.platform==='win32'?'junction':'dir');f.roots([link]);
 const added=path.join(f.media,'new.ts');await fs.writeFile(added,syntheticTs(1000,5000));f.files.push(added);await f.scan();await f.scan();await f.worker.configure({paused:false});
 for(let i=0;i<100&&!await pcrCacheEntryInfo(added);i++){await f.worker.runOnce();await new Promise(r=>setTimeout(r,10));}
 assert.ok(await pcrCacheEntryInfo(added));assert.equal((await fs.readdir(path.join(f.data,'pcr-cache'))).length,3);
 await fs.unlink(added);await f.scan();f.advance();await f.scan();await f.worker.runOnce();assert.equal(await pcrCacheEntryInfo(added),undefined);assert.ok(await pcrCacheEntryInfo(f.files[0]));
});
