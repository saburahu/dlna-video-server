import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {promises as fs} from 'node:fs';
import {openMediaIndex} from '../src/media-catalog-index.js';
import {createCatalogBackground} from '../src/catalog-background.js';
import {createExperimentalCatalog} from '../src/experimental-catalog.js';
import {browseDIDL} from '../src/upnp.js';
import {profiles} from '../src/core.js';

const probe={format:{duration:'1800',format_name:'matroska'},streams:[{codec_type:'video',codec_name:'hevc',profile:'Main',level:123,width:1920,height:1080,pix_fmt:'yuv420p',field_order:'progressive'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}]};
test('5000 asynchronous metadata transitions: bounded SQL queue, restart/cache reuse and zero Browse probes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-jobs-')),media=path.join(root,'media'),directory=path.join(root,'cache');
 await fs.mkdir(media);await fs.mkdir(directory);await fs.writeFile(path.join(directory,'automatic.json'),JSON.stringify({enabled:true,scanIntervalMs:3600000}));
 await Promise.all(Array.from({length:5000},(_,i)=>fs.writeFile(path.join(media,`日本語-${String(i).padStart(5,'0')}.mkv`),'fixture')));
 let calls=0,active=0,max=0;const jobs=createCatalogBackground(directory,()=>[media],()=>{},{probe:async()=>{calls++;active++;max=Math.max(max,active);await Promise.resolve();active--;return {probe,cacheHit:calls%2===0};}});
 const catalog=createExperimentalCatalog(directory,()=>{});let db=await openMediaIndex(directory);
 t.after(async()=>{await jobs.stop();await catalog.closeIndex();db.close();await fs.rm(root,{recursive:true,force:true});});
 const began=performance.now();await jobs.runOnce();assert.equal(jobs.status().queued,4999);
 const before=calls,at=performance.now();const page=await catalog.browse({objectId:'experimental',start:2500,count:125,metadata:false},'', 'http://test',m=>browseDIDL('0',0,0,[],'http://test',profiles.standard,m));
 assert.equal(page?.numberReturned,125);assert.equal(calls,before);
 const browseMs=performance.now()-at;
 await Promise.all([jobs.runOnce(),jobs.runOnce(),jobs.runOnce()]);assert.equal(max,1);
 while(jobs.status().queued)await jobs.runOnce();assert.equal(calls,5000);assert.equal(db.nextProbe(),undefined);assert.equal(db.get(db.page(0,1).entries[0].objectId)?.probeStatus,'ready');
 const elapsedMs=performance.now()-began;await jobs.stop();db.close();db=await openMediaIndex(directory);
 const restarted=createCatalogBackground(directory,()=>[media],()=>{},{probe:async()=>{throw Error('Ready cache must not probe');}});
 await restarted.runOnce();assert.equal(restarted.status().queued,0);await restarted.stop();
 console.log('CATALOG_METADATA_5000 '+JSON.stringify({elapsedMs,browseMs,initialQueue:5000,maxConcurrent:max,calls,cacheHits:jobs.status().cacheHits,metadataUpdateMs:jobs.status().metadataUpdateMs,restartQueue:0,browseProbeStarts:0}));
});

test('failed probe retry budget, source changes, deletion, busy pause and cancellation are isolated',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-job-errors-')),media=path.join(root,'media'),directory=path.join(root,'cache');await fs.mkdir(media);await fs.mkdir(directory);
 const file=path.join(media,'source.mp4');await fs.writeFile(file,'original');await fs.writeFile(path.join(directory,'automatic.json'),JSON.stringify({enabled:true}));
 const db=await openMediaIndex(directory);let busy=true,calls=0;
 const worker=createCatalogBackground(directory,()=>[media],()=>{},{busy:()=>busy,probe:async()=>{calls++;throw Error('broken header');}});
 t.after(async()=>{await worker.stop();db.close();await fs.rm(root,{recursive:true,force:true});});
 await worker.runOnce();assert.equal(calls,0);busy=false;await worker.runOnce();assert.equal(calls,1);await worker.runOnce();assert.equal(calls,1);assert.equal(db.find(file)?.probeStatus,'failed');
 await fs.appendFile(file,'changed');await worker.runOnce(true);assert.equal(calls,2);
 await fs.unlink(file);await worker.runOnce(true);assert.equal(db.find(file)?.availability,'missing');assert.equal(worker.status().queued,0);await worker.stop();
 await fs.writeFile(file,'returned');const cancelling=createCatalogBackground(directory,()=>[media],()=>{},{probe:async(_d,_f,signal)=>new Promise((_r,reject)=>signal!.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))});
 const running=cancelling.runOnce();while(!cancelling.status().active)await new Promise(r=>setTimeout(r,5));await cancelling.stop();await running;assert.equal(cancelling.status().active,0);assert.equal(db.find(file)?.probeStatus,'pending');
});
