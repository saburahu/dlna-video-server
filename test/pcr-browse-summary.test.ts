import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {cachedPcrSummary,buildPcrIndex,clearPcrIndexCache,pcrIndexCacheStatus} from '../src/pcr-index.js';
import {syntheticTs} from './ts-fixture.js';

test('Browse summary: cold/legacy/corrupt/changed sources never build; saved and memory metadata agree',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-pcr-summary-')),media=path.join(root,'media'),data=path.join(root,'state');await fs.mkdir(media);
 const old=process.env.PT3_DATA_DIR;process.env.PT3_DATA_DIR=data;clearPcrIndexCache();
 t.after(async()=>{if(old===undefined)delete process.env.PT3_DATA_DIR;else process.env.PT3_DATA_DIR=old;clearPcrIndexCache();await fs.rm(root,{recursive:true,force:true});});
 const file=path.join(media,'fixture.ts');await fs.writeFile(file,syntheticTs(3000,5000));const before=pcrIndexCacheStatus().builds;
 assert.equal(await cachedPcrSummary(file),undefined);assert.equal(pcrIndexCacheStatus().builds,before);
 const index=await buildPcrIndex(file);assert.ok(index);const memory=await cachedPcrSummary(file);assert.equal(memory?.packetCount,3000);
 clearPcrIndexCache();assert.deepEqual(await cachedPcrSummary(file),memory);assert.equal(pcrIndexCacheStatus().builds,before+1);
 const names=await fs.readdir(path.join(data,'pcr-cache'));assert.equal(names.length,1);const cacheFile=path.join(data,'pcr-cache',names[0]),original=JSON.parse(await fs.readFile(cacheFile,'utf8'));
 const accessed=(await fs.stat(cacheFile)).mtimeMs;await cachedPcrSummary(file);assert.equal((await fs.stat(cacheFile)).mtimeMs,accessed,'Browse does not touch cache LRU timestamps');
 await fs.writeFile(cacheFile,JSON.stringify({...original,summary:{...original.summary,averageBitrate:1}}));assert.equal(await cachedPcrSummary(file),undefined);
 const {summary,summarySha256,...legacy}=original;await fs.writeFile(cacheFile,JSON.stringify(legacy));assert.equal(await cachedPcrSummary(file),undefined);
 assert.deepEqual(await buildPcrIndex(file),index);assert.equal(pcrIndexCacheStatus().builds,before+1,'Legacy playback still reuses full cache');
 clearPcrIndexCache();await fs.writeFile(file,syntheticTs(4000,6000));assert.equal(await cachedPcrSummary(file),undefined);assert.equal(pcrIndexCacheStatus().builds,before+1);
 await buildPcrIndex(file);assert.equal(pcrIndexCacheStatus().builds,before+2);assert.equal((await fs.readdir(path.join(data,'pcr-cache'))).length,1,'Source update replaces, never appends a fingerprint-named file');
});
