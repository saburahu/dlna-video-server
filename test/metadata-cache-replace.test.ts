import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RecordingMetadataCache,type EitScan} from '../src/recording-metadata.js';import {PcrDeferred} from '../src/pcr-work.js';
import {createPcrBackground} from '../src/pcr-background.js';

async function setup(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-cache-replace-lock-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const media=path.join(root,'media'),directory=path.join(root,'cache');await fs.mkdir(media);const source=path.join(media,'generated.ts');await fs.writeFile(source,Buffer.alloc(1880));await fs.utimes(source,0,0);
 let scans=0;const cache=new RecordingMetadataCache(directory,async()=>{scans++;return {complete:true,clockValid:false,counters:{eitSections:0},records:[]} as unknown as EitScan;});
 await cache.analyze(source);const filename=path.join(directory,(await fs.readdir(directory))[0]),r=JSON.parse(await fs.readFile(filename,'utf8'));r.version=1;await fs.writeFile(filename,JSON.stringify(r));
 return {source,directory,cache,filename,before:await fs.readFile(filename),scans:()=>scans};
}
test('Windows held destination read handle: atomic metadata replacement recovers after close without rescanning',{skip:process.platform!=='win32'},async t=>{
 const x=await setup(t),held=await fs.open(x.filename,'r'),rename=fs.rename;let calls=0,closed=false,timer:ReturnType<typeof setTimeout>|undefined;
 const close=async()=>{if(!closed){closed=true;await held.close();}};
 fs.rename=(async(...args:Parameters<typeof fs.rename>)=>{if(String(args[1])===x.filename)calls++;try{return await rename(...args);}catch(e){if(calls===1)timer=setTimeout(()=>void close(),120);throw e;}}) as typeof fs.rename;
 try{const result=await x.cache.analyze(x.source);assert.equal(result.metadata.state,'no-eit');assert.ok(calls>1&&calls<=5);assert.equal(x.scans(),2);assert.equal((await x.cache.lookup(x.source)).state,'no-eit');}
 finally{clearTimeout(timer);await close();fs.rename=rename;}
 assert.deepEqual((await fs.readdir(x.directory)).filter(f=>f.endsWith('.tmp')),[]);
});
test('Windows permanent destination lock: bounded failure preserves old cache and removes incomplete asset',{skip:process.platform!=='win32'},async t=>{
 const x=await setup(t),held=await fs.open(x.filename,'r'),rename=fs.rename;let calls=0;
 fs.rename=(async(...args:Parameters<typeof fs.rename>)=>{if(String(args[1])===x.filename)calls++;return rename(...args);}) as typeof fs.rename;
 try{await assert.rejects(x.cache.analyze(x.source),(e:any)=>e.code==='EPERM'||e.code==='EBUSY');assert.equal(calls,5);assert.deepEqual(await fs.readFile(x.filename),x.before);}
 finally{await held.close();fs.rename=rename;}
 assert.deepEqual((await fs.readdir(x.directory)).filter(f=>f.endsWith('.tmp')),[]);assert.equal((await x.cache.lookup(x.source)).reason,'schema-upgrade');
});
test('source change while Windows replacement is blocked aborts publication rather than saving stale metadata',{skip:process.platform!=='win32'},async t=>{
 const x=await setup(t),held=await fs.open(x.filename,'r'),rename=fs.rename;let changed=false,closed=false;
 fs.rename=(async(...args:Parameters<typeof fs.rename>)=>{try{return await rename(...args);}catch(e){if(String(args[1])===x.filename&&!changed){changed=true;await fs.appendFile(x.source,'x');await held.close();closed=true;}throw e;}}) as typeof fs.rename;
 try{await assert.rejects(x.cache.analyze(x.source),(e:any)=>e instanceof PcrDeferred&&e.reason==='source-changed');assert.deepEqual(await fs.readFile(x.filename),x.before);}
 finally{if(!closed)await held.close();fs.rename=rename;}
 assert.equal(changed,true);assert.deepEqual((await fs.readdir(x.directory)).filter(f=>f.endsWith('.tmp')),[]);
});
test('non-transient metadata I/O errors are not retried or converted into success',async t=>{
 const x=await setup(t),rename=fs.rename;let calls=0;
 fs.rename=(async(...args:Parameters<typeof fs.rename>)=>{if(String(args[1])===x.filename){calls++;throw Object.assign(Error('synthetic I/O failure'),{code:'EIO'});}return rename(...args);}) as typeof fs.rename;
 try{await assert.rejects(x.cache.analyze(x.source),(e:any)=>e.code==='EIO');assert.equal(calls,1);assert.deepEqual(await fs.readFile(x.filename),x.before);}
 finally{fs.rename=rename;}
 assert.deepEqual((await fs.readdir(x.directory)).filter(f=>f.endsWith('.tmp')),[]);
});

test('shutdown waits for a blocked metadata publication and leaves no temporary asset or DB operation',{skip:process.platform!=='win32'},async t=>{
 const x=await setup(t),held=await fs.open(x.filename,'r'),rename=fs.rename;let entered!:()=>void,stopped=false;
 const blocked=new Promise<void>(r=>entered=r),data=path.join(path.dirname(x.directory),'manager');
 const manager=createPcrBackground(data,()=>[path.dirname(x.source)],()=>{}, {free:async()=>8*1024**3,metadata:async()=>{await x.cache.analyze(x.source)}});
 fs.rename=(async(...args:Parameters<typeof fs.rename>)=>{try{return await rename(...args);}catch(e){if(String(args[1])===x.filename)entered();throw e;}}) as typeof fs.rename;
 try{
  await manager.configure({settleMs:0,idleGraceMs:0,minFreeBytes:0});manager.accept({roots:[path.dirname(x.source)],entries:[{file:x.source,stat:await fs.stat(x.source)}],failedPaths:[]});await manager.runOnce();
  await blocked;const stop=manager.stop().then(()=>{stopped=true});await new Promise<void>(r=>setImmediate(r));assert.equal(stopped,false);await stop;
  assert.deepEqual(await fs.readFile(x.filename),x.before);assert.deepEqual((await fs.readdir(x.directory)).filter(f=>f.endsWith('.tmp')),[]);
 }finally{await held.close();fs.rename=rename;if(!stopped)await manager.stop();}
});
