import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverLibrary,withinSourcePath,type DiscoveryState} from '../src/library-discovery.js';
import {openMediaIndex} from '../src/media-catalog-index.js';

test('discovery preserves native readdir ordering including mixed case names',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'library-order-'));t.after(async()=>{await fs.rm(root,{recursive:true,force:true});});
 for(const name of ['no-audio.ts','PMT.ts','AAC.ts','video.ts'])await fs.writeFile(path.join(root,name),'fixture');
 const expected=(await fs.readdir(root)).filter(name=>name.endsWith('.ts')),actual=[];
 for await(const f of discoverLibrary([root],/\.ts$/i,{failedPaths:[],linksSkipped:0}))actual.push(path.basename(f.file));
 assert.deepEqual(actual,expected);
});

test('recursive discovery: mixed formats, overlapping roots, same names, link cycle and partial errors',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'recursive-library-')),root=path.join(temp,'media'),cache=path.join(temp,'cache');
 const good=path.join(root,'日本語','深い','階層'),bad=path.join(root,'拒否');
 await fs.mkdir(good,{recursive:true});await fs.mkdir(bad,{recursive:true});
 for(const f of [path.join(root,'同名.TS'),path.join(good,'同名.TS'),path.join(good,'映画.MKV'),path.join(bad,'番組.mp4')])await fs.writeFile(f,'fixture');
 await fs.symlink(root,path.join(good,'cycle'),process.platform==='win32'?'junction':'dir');
 const db=await openMediaIndex(cache);t.after(async()=>{db.close();await fs.rm(temp,{recursive:true,force:true});});
 const state:DiscoveryState={failedPaths:[],linksSkipped:0},found=[];
 for await(const f of discoverLibrary([root,good],/\.(ts|mp4|mkv)$/i,state))found.push(f.file);
 assert.equal(found.length,4);assert.equal(new Set(found).size,4);assert.equal(state.linksSkipped,1);
 const first=await db.scan([root],cache);assert.equal(first.active,2);const existing=db.find(path.join(bad,'番組.mp4'))!;
 const denied={...fs,opendir:((folder:string)=>{if(folder===bad)return Promise.reject(Object.assign(new Error('denied'),{code:'EACCES'}));return fs.opendir(folder);}) as typeof fs.opendir};
 await fs.writeFile(path.join(good,'追加.mp4'),'new');
 const partial=await db.scan([root],cache,denied);assert.equal(partial.added,1);assert.equal(partial.missing,0);assert.deepEqual(partial.failedPaths,[bad]);assert.equal(db.get(existing.objectId)?.availability,'available');
 await fs.unlink(path.join(bad,'番組.mp4'));const complete=await db.scan([root],cache);assert.equal(complete.missing,1);
 assert.equal(withinSourcePath(path.join(root,'sibling-file'),bad),false);
 const deniedState:DiscoveryState={failedPaths:[],linksSkipped:0};const other=[];
 for await(const f of discoverLibrary([root],/\.(ts|mp4|mkv)$/i,deniedState,denied))other.push(f.file);
 assert.equal(other.length,4);assert.deepEqual(deniedState.failedPaths,[bad]);
});
