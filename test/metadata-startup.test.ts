import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {RecordingMetadataCache,type EitScan} from '../src/recording-metadata.js';
import {programs,refreshMetadata,systemUpdateId} from '../src/store.js';

test('cached lookup reuses identity/stat only within the call; later corruption/deletion/change remain visible',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-startup-cache-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const media=path.join(root,'media');await fs.mkdir(media);
 const source=path.join(media,'generated.ts');await fs.writeFile(source,Buffer.alloc(1880));await fs.utimes(source,0,0);
 let scans=0;
 const cache=new RecordingMetadataCache(path.join(root,'cache'),async()=>{scans++;return {complete:true,clockValid:false,counters:{eitSections:0},records:[]} as unknown as EitScan;});
 await cache.analyze(source);assert.equal(scans,1);
 const original=fs.stat;let sourceStats=0,cacheStats=0;
 fs.stat=(async(...args:Parameters<typeof fs.stat>)=>{if(String(args[0])===source)sourceStats++;else if(String(args[0]).startsWith(cache.directory))cacheStats++;return (original as any)(...args);}) as typeof fs.stat;
 try{assert.equal((await cache.lookup(source)).state,'no-eit');}finally{fs.stat=original;}
 assert.equal(sourceStats,3,'identity before/after JSON and final size/mtime remain checked');assert.equal(cacheStats,1,'reuse size bound stat');
 const file=path.join(cache.directory,(await fs.readdir(cache.directory))[0]),saved=await fs.readFile(file,'utf8');
 await fs.writeFile(file,'{broken');assert.equal((await cache.lookup(source)).state,'pending');
 await fs.writeFile(file,saved);assert.equal((await cache.lookup(source)).state,'no-eit');
 const changed=JSON.parse(saved);changed.metadata.reason='tampered';await fs.writeFile(file,JSON.stringify(changed));assert.equal((await cache.lookup(source)).state,'pending');
 await fs.writeFile(file,saved);await fs.appendFile(source,'x');assert.equal((await cache.lookup(source)).reason,'file-changed');
 await fs.unlink(source);assert.equal((await cache.lookup(source)).state,'error');assert.equal(scans,1,'lookup never scans TS');
});

test('same-size and same-mtime replacement during JSON read cannot publish the old physical file metadata',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-cache-replace-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const media=path.join(root,'media');await fs.mkdir(media);const source=path.join(media,'generated.ts'),replacement=path.join(media,'replacement.ts');
 await fs.writeFile(source,Buffer.alloc(1880));await fs.utimes(source,0,0);await fs.writeFile(replacement,Buffer.alloc(1880,1));await fs.utimes(replacement,0,0);
 const cache=new RecordingMetadataCache(path.join(root,'cache'),async()=>({complete:true,clockValid:false,counters:{eitSections:0},records:[]} as unknown as EitScan));await cache.analyze(source);
 const before=await fs.stat(source),read=fs.readFile;let replaced=false;
 fs.readFile=(async(...args:Parameters<typeof fs.readFile>)=>{const value=await (read as any)(...args);if(!replaced&&String(args[0]).startsWith(cache.directory)){replaced=true;await fs.rename(replacement,source);}return value;}) as typeof fs.readFile;
 try{assert.equal((await cache.lookup(source)).reason,'file-changed');}finally{fs.readFile=read;}
 const after=await fs.stat(source);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(replaced,true);
});

test('bounded refresh waits for all rows, keeps order and newer publications, advances UpdateID once',async()=>{
 const previous=programs.splice(0),lookup=RecordingMetadataCache.prototype.lookup;
 let active=0,peak=0,finished=0;
 const newer={state:'no-eit' as const,reason:'published-during-refresh'};
 try{
  programs.push(...Array.from({length:137},(_,i)=>({id:String(i),filePath:`generated-${i}.ts`,title:`file ${i}`,size:188,modified:'2026-01-01T00:00:00.000Z',published:true,analysis:'ok' as const})));
  RecordingMetadataCache.prototype.lookup=async source=>{
   peak=Math.max(peak,++active);
   if(source==='generated-0.ts')programs[0].metadata=newer;
   await new Promise(r=>setTimeout(r,1));active--;finished++;
   return {state:'no-eit',reason:source};
  };
  const before=systemUpdateId;await refreshMetadata(false);
  assert.equal(finished,137);assert.equal(active,0);assert.equal(peak,8);
  assert.deepEqual(programs.map(p=>p.id),Array.from({length:137},(_,i)=>String(i)));
  assert.equal(programs[0].metadata,newer);assert.equal(programs[136].metadata?.reason,'generated-136.ts');
  assert.equal(systemUpdateId,before+1);
 }finally{RecordingMetadataCache.prototype.lookup=lookup;programs.splice(0,programs.length,...previous);}
});
