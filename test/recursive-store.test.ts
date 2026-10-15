import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('TS store: recursive stat-only scan preserves IDs and inaccessible branches',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'recursive-ts-')),media=path.join(temp,'media'),data=path.join(temp,'data'),child=path.join(media,'日本語','深い');
 await fs.mkdir(child,{recursive:true});await fs.mkdir(data,{recursive:true});
 const direct=path.join(media,'同名.TS'),nested=path.join(child,'同名.TS');
 await fs.writeFile(direct,'synthetic');await fs.writeFile(nested,'synthetic');
 await fs.writeFile(path.join(child,'ignored.mp4'),'synthetic');
 await fs.symlink(media,path.join(child,'cycle'),process.platform==='win32'?'junction':'dir');
 process.env.PT3_DATA_DIR=data;const store=await import('../src/store.js');await store.loadStore();await store.updateSettings({folders:[media,child]});
 t.after(async()=>{await fs.rm(temp,{recursive:true,force:true});});
 const first=await store.scanFolders(()=>{});assert.equal(first.length,2);assert.equal(new Set(first.map(p=>p.id)).size,2);assert.ok(first.every(p=>p.analysis==='pending'));
 const version=store.systemUpdateId;await store.scanFolders(()=>{});assert.equal(store.systemUpdateId,version);
 const ids=first.map(p=>p.id).sort();await store.loadStore();assert.deepEqual((await store.scanFolders(()=>{})).map(p=>p.id).sort(),ids);
 const original=fs.opendir;fs.opendir=((folder:string,...args:any[])=>{if(folder===child)return Promise.reject(Object.assign(new Error('denied'),{code:'EACCES'}));return (original as any)(folder,...args);}) as typeof fs.opendir;
 try{const partial=await store.scanFolders(()=>{});assert.equal(partial.length,2);assert.deepEqual(partial.map(p=>p.id).sort(),ids);}finally{fs.opendir=original;}
 await fs.unlink(nested);const complete=await store.scanFolders(()=>{});assert.equal(complete.length,1);assert.equal(complete[0].id,first.find(p=>p.filePath===direct)!.id);
 await fs.appendFile(direct,'changed');assert.equal((await store.scanFolders(()=>{}))[0].id,complete[0].id);
});
