import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {libraryPagePlan,librarySwitch} from '../src/recording-library.js';
import {jitDeliveryEnd} from '../src/jit-server.js';
import {sourceAudioEndpoint,validateJitSegmentEnd} from '../src/jit-segment.js';
import {newJitStats} from '../src/jit-stream.js';
import {ENCODE_RECIPE} from '../src/prepare-executor.js';
import {openMediaIndex} from '../src/media-catalog-index.js';
import {createExperimentalCatalog,experimentalBrowseSoap} from '../src/experimental-catalog.js';
import {browseDIDL,browseRequest} from '../src/upnp.js';
import {profiles} from '../src/core.js';

test('full source is explicit; diagnostic cap and requested endpoint remain bounded',()=>{
 assert.equal(jitDeliveryEnd({seconds:150,timeSeek:true,durationMode:'source'},1800),1800);
 assert.equal(jitDeliveryEnd({seconds:150,timeSeek:true,durationMode:'source'},1800,61),61);
 assert.equal(jitDeliveryEnd({seconds:150,timeSeek:true,durationMode:'source'},1800,2000),1800);
 assert.equal(jitDeliveryEnd({seconds:150,timeSeek:true,durationMode:'diagnostic'},1800),150);
 assert.equal(jitDeliveryEnd({seconds:150},100),100);
});
test('natural audio endpoint differs from video: explicit source evidence, no silence or relaxed tolerance',()=>{
 assert.equal(sourceAudioEndpoint({streams:[{codec_type:'audio',duration:'99.76',start_time:'0'}]}),99.76);
 assert.ok(Math.abs(sourceAudioEndpoint({streams:[{codec_type:'audio',tags:{'DURATION-eng':'00:01:39.760000000'}}]})!-99.76)<1e-9);
 assert.equal(sourceAudioEndpoint({streams:[{codec_type:'audio'}]}),undefined);
 const s={...newJitStats(),videoPictures:30,audioFrames:45,pcrIntervals:10,firstVideoPts:ENCODE_RECIPE.commonShiftTicks+99*90000,lastVideoPts:ENCODE_RECIPE.commonShiftTicks+99.99*90000,firstAudioPts:ENCODE_RECIPE.commonShiftTicks+99*90000,lastAudioFramePts:ENCODE_RECIPE.commonShiftTicks+99.76*90000-1920};
 assert.throws(()=>validateJitSegmentEnd(s,99,100),/endpoint/);
 assert.ok(Math.abs(validateJitSegmentEnd(s,99,100,99.76).audioEnd-99.76)<1e-9);
 assert.throws(()=>validateJitSegmentEnd({...s,lastAudioFramePts:s.lastAudioFramePts!-9000},99,100,99.76),/endpoint/);
});
test('library pagination preserves TS prefix and applies bounded catalog offset',()=>{
 assert.deepEqual(libraryPagePlan(10,125,16),{limit:125,tsStart:10,tsCount:6,catalogStart:0,catalogCount:119});
 assert.equal(libraryPagePlan(2000,0,16).limit,200);
 assert.equal(libraryPagePlan(2000,125,16).catalogStart,1984);
 assert.throws(()=>libraryPagePlan(-1,125,16));
});
test('integration missing or invalid configuration is off',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'library-switch-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const enabled=librarySwitch(dir);assert.equal(await enabled(),false);
 await fs.writeFile(path.join(dir,'library.json'),JSON.stringify({version:'recording-library-v1',enabled:true}));assert.equal(await enabled(),true);
 await fs.writeFile(path.join(dir,'library.json'),JSON.stringify({version:'recording-library-v1',enabled:false,revision:3}));assert.equal(await enabled(),false);assert.equal(await enabled.revision(),3);
 await fs.writeFile(path.join(dir,'library.json'),'invalid configuration');assert.equal(await enabled(),false);
});

test('5000 normal library items: bounded SQL paging, restart-stable IDs, zero Browse probes and isolated TS XML',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'library-5000-')),media=path.join(root,'media'),dir=path.join(root,'index');await fs.mkdir(media);await fs.mkdir(dir);
 await Promise.all(Array.from({length:5000},(_,i)=>fs.writeFile(path.join(media,`同名番組-${String(i).padStart(5,'0')}.mkv`),'fixture')));
 await fs.writeFile(path.join(dir,'library.json'),JSON.stringify({version:'recording-library-v1',enabled:true}));
 let db=await openMediaIndex(dir);const indexStart=performance.now();await db.scan([media],dir);const indexMs=performance.now()-indexStart;
 let probes=0;const catalog=createExperimentalCatalog(dir,()=>{},()=>[],{inspect:async()=>{probes++;throw Error('Browse must not probe');}});
 t.after(async()=>{await catalog.closeIndex();db.close();await fs.rm(root,{recursive:true,force:true});});
 const ts={id:'existing-ts',published:true,title:'通常TS',filename:'通常.ts',size:188,mtimeMs:0,path:'unchanged.ts'} as any;
 const legacy=(start:number,count:number,metadata:boolean)=>browseDIDL('all',start,count,[ts],'http://test',profiles.standard,metadata);
 const old=legacy(0,1,false),prefix=/<item\b[\s\S]*?<\/item>/.exec(old.didl)![0],times:number[]=[],ids:string[]=[];
 for(let start=0;start<5001;start+=125){const at=performance.now();const page=await catalog.libraryBrowse({objectId:'all',start,count:125,metadata:false},'', 'http://test',legacy);times.push(performance.now()-at);assert.equal(page?.total,5001);assert.equal(page?.numberReturned,Math.min(125,5001-start));if(!start)assert.ok(page!.didl.includes(prefix));ids.push(...[...page!.didl.matchAll(/<item id="([^"]+)"/g)].map(m=>m[1]));assert.ok(!page!.didl.includes('/library/jit/'),'unanalysed entries have no false resource');}
 assert.equal(ids.length,5001);assert.equal(new Set(ids).size,5001);assert.equal(ids[0],'item:existing-ts');assert.equal(probes,0);
 const all=await catalog.libraryBrowse({objectId:'all',start:0,count:0,metadata:false},'','http://test',legacy);assert.equal(all?.numberReturned,200);
 const before=db.page(2500,125).entries.map(r=>r.objectId);await catalog.closeIndex();db.close();db=await openMediaIndex(dir);assert.deepEqual(db.page(2500,125).entries.map(r=>r.objectId),before);
 const http=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const r=browseRequest(Buffer.concat(chunks).toString());const page=await catalog.libraryBrowse(r,'','http://test',legacy);res.setHeader('Content-Type','text/xml');res.end(experimentalBrowseSoap(page!,0));});
 await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));t.after(()=>{http.closeAllConnections();http.close();});const httpMs:number[]=[];
 for(const start of [0,2500,4876]){const at=performance.now();const response=await fetch(`http://127.0.0.1:${(http.address() as {port:number}).port}`,{method:'POST',body:`<ObjectID>all</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>${start}</StartingIndex><RequestedCount>125</RequestedCount>`});const xml=await response.text();httpMs.push(performance.now()-at);assert.ok(xml.includes('<NumberReturned>125</NumberReturned>'));assert.ok(xml.includes('<TotalMatches>5001</TotalMatches>'));}assert.equal(probes,0);
 const dbBytes=(await fs.stat(path.join(dir,'media-index.sqlite'))).size;
 console.log('LIBRARY_5000 '+JSON.stringify({indexMs,dbBytes,browseMinMs:Math.min(...times),browseMaxMs:Math.max(...times),httpMs,pages:times.length,probes,rss:process.memoryUsage().rss}));
});
