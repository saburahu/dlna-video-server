import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createPcrBackground} from '../src/pcr-background.js';
import {clearPcrIndexCache,pcrIndexCacheStatus} from '../src/pcr-index.js';
import {syntheticTs} from './ts-fixture.js';

test('PCR background settles across scans, yields to playback, pauses at low space and reuses persisted cache',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-prefetch-')),media=path.join(root,'media'),data=path.join(root,'data');await fs.mkdir(media);
 const old=process.env.PT3_DATA_DIR;process.env.PT3_DATA_DIR=data;clearPcrIndexCache();
 let clock=Date.now()+100000,free=10*1024**3,busy=false;
 let worker=createPcrBackground(data,()=>[media],()=>{},{now:()=>clock,free:async()=>free,busy:()=>busy});
 t.after(async()=>{await worker.stop();clearPcrIndexCache();if(old===undefined)delete process.env.PT3_DATA_DIR;else process.env.PT3_DATA_DIR=old;await fs.rm(root,{recursive:true,force:true});});
 await worker.configure({settleMs:0,idleGraceMs:0,readBytesPerSecond:64*1024**2});
 const source=path.join(media,'recording.ts');await fs.writeFile(source,syntheticTs(3000,5000));
 const inventory=async()=>({roots:[media],entries:[{file:source,stat:await fs.stat(source)}],failedPaths:[]});
 worker.accept(await inventory());await worker.runOnce();assert.equal(worker.status().success,0,'one observation is not stable');
 busy=true;worker.accept(await inventory());await worker.runOnce();assert.equal(worker.status().reason,'playback');assert.equal(worker.status().success,0);
 busy=false;free=0;clock+=6000;await worker.runOnce();assert.equal(worker.status().reason,'low-free-space');
 free=10*1024**3;clock+=6000;await worker.runOnce();
 for(let n=0;n<100&&worker.status().success===0;n++)await sleep(10);
 assert.equal(worker.status().success,1);assert.equal(worker.status().usage?.files,1);
 const builds=pcrIndexCacheStatus().builds;await worker.stop();clearPcrIndexCache();
 worker=createPcrBackground(data,()=>[media],()=>{},{now:()=>clock,free:async()=>free});
 worker.accept(await inventory());await worker.runOnce();for(let n=0;n<100&&worker.status().success===0;n++)await sleep(10);
 assert.equal(worker.status().success,1);assert.equal(pcrIndexCacheStatus().builds,builds,'restart validates saved index without rebuilding');
 await worker.configure({paused:true});assert.equal(worker.status().policy.paused,true);
});

test('PCR cache startup failure closes partial SQLite and retries initialization safely',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-prefetch-retry-')),media=path.join(dir,'media'),data=path.join(dir,'data');await fs.mkdir(media);await fs.mkdir(data);
 const cache=path.join(data,'pcr-cache');await fs.writeFile(cache,'owned obstruction');
 const worker=createPcrBackground(data,()=>[media],()=>{});
 t.after(async()=>{await worker.stop();await fs.rm(dir,{recursive:true,force:true});});
 await assert.rejects(worker.configure({paused:true}));
 await fs.unlink(cache);await fs.mkdir(cache);await worker.configure({paused:true});worker.accept({roots:[media],entries:[],failedPaths:[]});await worker.runOnce();
 assert.equal(worker.status().reason,'paused');assert.equal(worker.status().failed,0);assert.equal(worker.status().usage?.files,0);
});
