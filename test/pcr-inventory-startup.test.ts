import test from 'node:test';import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';import {createPcrBackground} from '../src/pcr-background.js';

test('PCR inventory is committed as a whole; failed enumeration retains old rows and restart reconciles deletions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-pcr-inventory-')),cache=path.join(root,'pcr-cache');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(cache);
 const name=(s:string)=>s.repeat(64)+'.json',entry=(s:string)=>path.join(cache,name(s));
 await fs.writeFile(entry('a'),'aa');await fs.writeFile(entry('b'),'bbb');
 const create=()=>createPcrBackground(root,()=>[],()=>{}, {free:async()=>8*1024**3});
 const first=create();assert.equal((await first.inspect()).usage?.files,2);await first.stop();
 await fs.unlink(entry('b'));await fs.writeFile(entry('c'),'cccc');await fs.writeFile(entry('d'),'ddddd');
 await fs.writeFile(path.join(cache,'not-a-cache.txt'),'ignore');await fs.mkdir(entry('e'));
 const stat=fs.lstat,retry=create();
 fs.lstat=(async(...args:Parameters<typeof fs.lstat>)=>{if(String(args[0])===entry('d'))throw new Error('synthetic enumeration failure');return (stat as any)(...args);}) as typeof fs.lstat;
 try{await assert.rejects(retry.inspect(),/synthetic enumeration failure/);}finally{fs.lstat=stat;}
 const db=new DatabaseSync(path.join(root,'pcr-cache.sqlite'),{readOnly:true});
 try{assert.deepEqual(db.prepare('SELECT name,bytes FROM pcr_files ORDER BY name').all().map(r=>({...r})),[{name:name('a'),bytes:2},{name:name('b'),bytes:3}]);}finally{db.close();}
 const ready=await retry.inspect();assert.equal(ready.initialInventoryFiles,3);assert.equal(ready.usage?.files,3);assert.equal(ready.usage?.bytes,11);
 await retry.stop();
});

test('stop drains startup enumeration without late DB writes or continued directory reads',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-pcr-stop-')),cache=path.join(root,'pcr-cache');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(cache);
 for(const c of ['a','b'])await fs.writeFile(path.join(cache,c.repeat(64)+'.json'),'{}');
 const manager=createPcrBackground(root,()=>[],()=>{}, {free:async()=>8*1024**3}),original=fs.lstat;
 let release!:()=>void,started!:()=>void,reads=0,stopped=false;
 const blocked=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
 fs.lstat=(async(...args:Parameters<typeof fs.lstat>)=>{if(String(args[0]).startsWith(cache)){reads++;started();await blocked;}return (original as any)(...args);}) as typeof fs.lstat;
 const inspect=manager.inspect();let stop:Promise<void>|undefined;
 try{
  await entered;stop=manager.stop().then(()=>{stopped=true});await new Promise<void>(r=>setImmediate(r));
  assert.equal(stopped,false,'shutdown must await in-flight startup work');release();await Promise.all([inspect,stop]);assert.equal(reads,1);
 }finally{release();fs.lstat=original;await inspect.catch(()=>{});await (stop??manager.stop());}
 const restarted=createPcrBackground(root,()=>[],()=>{}, {free:async()=>8*1024**3});
 try{assert.equal((await restarted.inspect()).initialInventoryFiles,2);}finally{await restarted.stop();}
});
