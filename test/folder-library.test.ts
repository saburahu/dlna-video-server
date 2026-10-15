import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {openMediaIndex,INDEX_FILE} from '../src/media-catalog-index.js';
import {folderIdentity,rootIdentity,rootLabels} from '../src/folder-index.js';
import {createExperimentalCatalog,experimentalBrowseSoap,folderAlias,libraryItem} from '../src/experimental-catalog.js';
import {browseDIDL} from '../src/upnp.js';
import {profiles} from '../src/core.js';

test('folder library: 5000+, independent roots, aliases, paging, incremental updates, restart, no Browse work',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'folder-library-')),a=path.join(temp,'one','録画'),b=path.join(temp,'two','録画'),data=path.join(temp,'data');
 const deep=path.join(a,'アニメ','同名','深い','日本語','第5階層'),other=path.join(b,'アニメ','同名');await fs.mkdir(deep,{recursive:true});await fs.mkdir(other,{recursive:true});await fs.mkdir(data);
 await Promise.all(Array.from({length:5000},(_,i)=>fs.writeFile(path.join(deep,`番組${String(i).padStart(5,'0')}.${i%2?'mkv':'mp4'}`),'fixture')));
 const source=path.join(deep,'番組00000.mp4');await fs.writeFile(path.join(other,'番組00000.mp4'),'different');await fs.writeFile(path.join(other,'番組00000.ts'),'ts');await fs.mkdir(path.join(a,'空フォルダ'));
 await fs.symlink(a,path.join(deep,'循環'),process.platform==='win32'?'junction':'dir');await fs.writeFile(path.join(data,'library.json'),JSON.stringify({version:'recording-library-v1',enabled:true}));
 let db=await openMediaIndex(data);const initial=await db.scan([a,b,deep],data);assert.equal(db.count(),5001);assert.equal(db.folders.count('folders'),3);
 const first=db.folders.page('folders',0,125);assert.equal(new Set(first.rows.map(r=>r.id)).size,3);assert.notEqual(rootLabels([a,b])[0].label,rootLabels([a,b])[1].label);
 const aid=folderIdentity(a,path.relative(a,deep)),bid=folderIdentity(b,path.relative(b,other)),did=folderIdentity(deep,'');
 assert.equal(db.folders.get(aid)?.parent,folderIdentity(a,path.relative(a,path.dirname(deep))));assert.equal(db.folders.count(aid),5000);assert.equal(db.folders.count(did),5000);assert.equal(db.folders.count(bid),2);
 const ids:string[]=[],times:number[]=[];for(let start=0;start<5000;start+=125){const at=performance.now(),page=db.folders.page(aid,start,125);times.push(performance.now()-at);assert.equal(page.total,5000);assert.equal(page.rows.length,125);ids.push(...page.rows.map(r=>r.id));}
 assert.equal(new Set(ids).size,5000);assert.equal(db.folders.page(aid,5000,125).rows.length,0);assert.equal(db.folders.page(aid,0,0).rows.length,200);
 const version=db.updateId,incremental=await db.scan([a,b,deep],data);assert.equal(incremental.foldersChanged,false);assert.equal(db.updateId,version);
 let probes=0;const c=createExperimentalCatalog(data,()=>{},()=>[a,b,deep],{inspect:async()=>{probes++;throw Error('Browse must not inspect');}});t.after(async()=>{await c.closeIndex();db.close();await fs.rm(temp,{recursive:true,force:true});});
 const request=(objectId:string,start=0,count=125,metadata=false)=>({objectId,start,count,metadata});
 const ts=async(file:string)=>`<item id="item:ts" parentID="all" restricted="1"><dc:title>${path.basename(file)}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:video/mpeg:*">http://test/media/ts</res></item>`;
 const top=await c.folderBrowse(request('folders'),'','http://test',ts);assert.equal(top?.total,3);assert.ok(!top!.didl.includes(a));
 const meta=await c.folderBrowse(request(aid,0,1,true),'','http://test',ts);assert.equal(meta?.numberReturned,1);assert.ok(meta!.didl.includes(`childCount="5000"`));
 const page=await c.folderBrowse(request(bid),'','http://test',ts);assert.equal(page?.numberReturned,2);assert.ok(page!.didl.includes(`parentID="${bid}"`));assert.ok(page!.didl.includes('http://test/media/ts'));assert.ok(!page!.didl.includes('/library/jit/'));
 const xmlIds=[...page!.didl.matchAll(/<item id="([^"]+)"/g)].map(m=>m[1]);for(const id of xmlIds){const m=await c.folderBrowse(request(id,0,1,true),'','http://test',ts);assert.equal(m?.numberReturned,1);assert.ok(m!.didl.includes(`parentID="${bid}"`));}
 assert.equal(probes,0);const refA=db.folders.page(aid,0,1).rows[0],refD=db.folders.page(did,0,1).rows[0];assert.notEqual(refA.id,refD.id);assert.equal(refA.source_id,refD.source_id);assert.equal(refA.source_path,source);
 db.close();db=await openMediaIndex(data);assert.equal(db.folders.page(aid,0,1).rows[0].id,refA.id);
 const denied={...fs,opendir:((p:string)=>p===deep?Promise.reject(Error('denied')):fs.opendir(p)) as typeof fs.opendir};const partial=await db.scan([a,b,deep],data,denied);assert.equal(db.folders.count(aid),5000);assert.equal(db.count(),5001);assert.ok(partial.failedPaths.length);
 await fs.appendFile(source,'changed');const change=await db.scan([a,b,deep],data);assert.equal(change.changed,1);assert.equal(db.folders.page(aid,0,1).rows[0].id,refA.id);
 await fs.mkdir(path.join(b,'新規'));const update=db.updateId;await db.scan([a,b,deep],data);assert.ok(db.updateId>update);await fs.rename(path.join(b,'新規'),path.join(b,'移動'));await db.scan([a,b,deep],data);assert.equal(db.folders.get(folderIdentity(b,'新規')),undefined);assert.ok(db.folders.get(folderIdentity(b,'移動')));
 await fs.unlink(source);await db.scan([a,b,deep],data);assert.equal(db.folders.count(aid),4999);assert.equal(db.folders.count(did),4999);
 const httpTimes:number[]=[]; // Full renderer, not only SQL query, on first/middle/final pages.
 for(const start of [0,2500,4875]){const at=performance.now();const p=await c.folderBrowse(request(aid,start),'','http://test',ts);httpTimes.push(performance.now()-at);assert.equal(p?.numberReturned,Math.min(125,4999-start));}
 const server=createServer(async(req,res)=>{const u=new URL(req.url!,'http://test');const page=await c.folderBrowse(request(u.searchParams.get('id')!,Number(u.searchParams.get('start')??0)), '', 'http://test',ts);res.setHeader('Content-Type','text/xml');res.end(experimentalBrowseSoap(page!,0));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const wireTimes:number[]=[];try{for(const [id,start] of [['folders',0],[aid,0],[aid,2500],[aid,4875]] as const){const at=performance.now();const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/?id=${encodeURIComponent(id)}&start=${start}`);const body=await response.text();wireTimes.push(performance.now()-at);assert.equal(response.status,200);assert.ok(body.includes('<TotalMatches>'));}}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 assert.equal(probes,0);
 const report={initial,incremental,sqlPageMs:times,didlBrowseMs:httpTimes,httpBrowseMs:wireTimes,dbBytes:(await fs.stat(path.join(data,INDEX_FILE))).size,rss:process.memoryUsage().rss,probes};console.log('FOLDER_5000 '+JSON.stringify({...report,sqlPageMs:{min:Math.min(...times),max:Math.max(...times)}}));
 if(process.env.PT3_FOLDER_BENCHMARK_REPORT)await fs.writeFile(process.env.PT3_FOLDER_BENCHMARK_REPORT,JSON.stringify(report,null,2));
});

test('schema v2 migration preserves existing media IDs, metadata and fingerprints',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'folder-migration-')),media=path.join(root,'media'),data=path.join(root,'data');await fs.mkdir(media);await fs.writeFile(path.join(media,'a.mp4'),'fixture');let db=await openMediaIndex(data);await db.scan([media],data);const old=db.page(0,1).entries[0];db.setMetadata(old.objectId,{path:old.path,size:old.size,mtimeMs:old.mtimeMs},{cached:true},60);db.close();
 const raw=new DatabaseSync(path.join(data,INDEX_FILE));raw.exec("DROP TABLE folder_media; DROP TABLE folders; UPDATE state SET value=2 WHERE key='version'");raw.close();db=await openMediaIndex(data);t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true});});assert.equal(db.get(old.objectId)?.analysisKey,old.analysisKey);assert.deepEqual(db.get(old.objectId)?.metadata,{cached:true});await db.scan([media],data);assert.equal(db.folders.count('folders'),1);
});

test('root and folder identities are case-independent on Windows and never display-key based',()=>{
 if(process.platform==='win32'){assert.equal(rootIdentity('D:\\録画'),rootIdentity('d:\\録画'));assert.equal(folderIdentity('D:\\録画','Anime'),folderIdentity('d:\\録画','anime'));}
 assert.notEqual(rootIdentity(path.resolve('one','録画')),rootIdentity(path.resolve('two','録画')));
 const labels=rootLabels([path.resolve('one','録画'),path.resolve('two','録画')]);assert.notEqual(labels[0].label,labels[1].label);
});

test('folder display aliases keep the same JIT URL, target protocol and source identity',()=>{
 const entry:any={objectId:'experimental/catalog-item/'+'a'.repeat(32),filename:'同名.mp4',fingerprint:{mtimeMs:0},jit:{durationSeconds:90,protocolInfo:'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T;DLNA.ORG_OP=10'}};
 const original=libraryItem(entry,'http://server'),alias=folderAlias(original,{id:'library/folder-item/'+'b'.repeat(32),parent:'library/folder/'+'c'.repeat(32),root_id:'r',name:'同名.mp4',sort_key:'',kind:'media'});
 assert.equal(/<res[\s\S]*?<\/res>/.exec(original)![0],/<res[\s\S]*?<\/res>/.exec(alias)![0]);assert.ok(alias.includes('parentID="library/folder/'));assert.ok(!alias.includes('parentID="all"'));
});
