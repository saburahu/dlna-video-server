import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {browseDIDL} from '../src/upnp.js';import {profiles} from '../src/core.js';import {createExperimentalCatalog} from '../src/experimental-catalog.js';import {openMediaIndex} from '../src/media-catalog-index.js';
import {developmentDirectory,DEVELOPMENT_DIRECTORY_ROOTS,menuRevisionSoap} from '../src/public-directory.js';import {folderIdentity} from '../src/folder-index.js';

test('normal recording menu has only all and folders; removed virtual IDs return no stale objects',()=>{
 const base=(id:string,start=0,count=0,metadata=false)=>browseDIDL(id,start,count,[],'http://test',profiles.standard,metadata);
 for(const start of [0,1,2,3])for(const count of [0,1,2,20]){const page=base('rec',start,count),ids=[...page.didl.matchAll(/<container id="([^"]+)"/g)].map(m=>m[1]);assert.deepEqual(ids,['all','folders'].slice(start,count?start+count:undefined));assert.equal(page.total,2);assert.equal(page.numberReturned,ids.length);}
 assert.match(base('rec',0,0,true).didl,/childCount="2"/);assert.match(base('0').didl,/<container id="rec"[^>]*childCount="2"/);
 for(const id of ['unwatched','date','station','genre','folder','recent'])for(const metadata of [false,true]){const p=base(id,0,0,metadata);assert.equal(p.total,0);assert.equal(p.numberReturned,0);}
 assert.equal(menuRevisionSoap('<UpdateID>4294967295</UpdateID>','Browse'),'<UpdateID>3</UpdateID>');assert.equal(menuRevisionSoap('<Id>7</Id>','GetSystemUpdateID'),'<Id>11</Id>');assert.equal(menuRevisionSoap('<Source>unchanged</Source>','GetProtocolInfo'),'<Source>unchanged</Source>');
});

test('public root pages omit development nodes, preserve photos and real folders, without inspecting sources',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'public-directory-')),sources=path.join(temp,'sources'),directory=path.join(temp,'data'),real=path.join(sources,'Experimental Media');await fs.mkdir(real,{recursive:true});await fs.mkdir(directory);await fs.writeFile(path.join(real,'動画.mkv'),'catalog-only');
 let db=await openMediaIndex(directory);await db.scan([sources],directory);db.close();let inspections=0;const c=createExperimentalCatalog(directory,()=>{},()=>[sources],{inspect:async()=>{inspections++;throw Error('No source work in menu');}});t.after(async()=>{await c.closeIndex();await fs.rm(temp,{recursive:true,force:true});});
 const old=(metadata:boolean)=>browseDIDL('0',0,0,[],'http://test',profiles.standard,metadata),browse=(id:string,start=0,count=0,metadata=false)=>c.browse({objectId:id,start,count,metadata},'','http://test',old,true);
 const root=await browse('0');assert.equal(root?.total,1);assert.match(root!.didl,/<container id="rec"/);assert.doesNotMatch(root!.didl,/id="experimental"/);
 for(const id of DEVELOPMENT_DIRECTORY_ROOTS)for(const objectId of [id,id+'/cached-item'])for(const metadata of [false,true]){assert.ok(developmentDirectory(objectId));const p=await browse(objectId,0,0,metadata);assert.equal(p?.total,0);assert.equal(p?.numberReturned,0);}
 // The real directory is identified by root + relative path, not its display name.
 await fs.writeFile(path.join(directory,'library.json'),JSON.stringify({version:'recording-library-v1',enabled:true}));const actual=await c.folderBrowse({objectId:folderIdentity(sources,'Experimental Media'),start:0,count:10,metadata:false},'','http://test',async()=>undefined);assert.equal(actual?.total,1);
 await fs.writeFile(path.join(sources,'image.webp'),'metadata-only');db=await openMediaIndex(directory);await db.scan([sources],directory);db.close();
 for(const start of [0,1,2,3])for(const count of [0,1,2,20]){const p=await browse('0',start,count);const ids=[...p!.didl.matchAll(/<container id="([^"]+)"/g)].map(m=>m[1]);assert.deepEqual(ids,['rec','photos'].slice(start,count?start+count:undefined));assert.equal(p?.total,2);assert.equal(p?.numberReturned,ids.length);}
 assert.match((await browse('0',0,0,true))!.didl,/childCount="2"/);assert.equal(inspections,0);
});
