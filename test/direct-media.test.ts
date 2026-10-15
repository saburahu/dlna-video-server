import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import type {IncomingMessage} from 'node:http';
import {createDirectMedia,directCandidate} from '../src/direct-media.js';
import {createExperimentalCatalog} from '../src/experimental-catalog.js';
import {openMediaIndex} from '../src/media-catalog-index.js';
import {FOLDER_ROOT} from '../src/folder-index.js';
const request=(ua:string,remote='127.0.0.1')=>({headers:{'user-agent':ua},socket:{remoteAddress:remote}} as IncomingMessage);
const probe=(format='mov,mp4,m4a,3gp,3g2,mj2',codec='h264')=>({format:{format_name:format,duration:'4'},streams:[{codec_type:'video',codec_name:codec,width:320,height:240},{codec_type:'audio',codec_name:'aac'}]});

test('direct software hints do not confer JIT permission; format and stream evidence required',()=>{
 const d=createDirectMedia(()=>[],()=>{}),e:any={objectId:'experimental/catalog-item/'+ 'a'.repeat(32),filename:'misleading.mp4',fingerprint:{path:'x',size:20,mtimeMs:0},lightweightProbe:probe()};
 for(const ua of ['VLC/3.0.21 LibVLC/3.0.21','VLC for iOS/3.6','MobileVLCKit/3','Darwin UPnP/1.0 Portable SDK for UPnP devices/1.14'])assert.ok(d.client(request(ua),'127.0.0.1').startsWith('vlc-direct:'));
 for(const ua of ['','REGZA','UPnP/1.0 Intel SDK for UPnP devices/1.2','DiXiM'])assert.equal(d.client(request(ua),'192.0.2.5'),'192.0.2.5');
 assert.equal(directCandidate(e)?.mime,'video/mp4');
 assert.equal(directCandidate({...e,lightweightProbe:probe('asf','wmv3')})?.mime,'video/x-ms-asf');
 for(const p of [undefined,probe('unknown'),probe('avi','unknown'),{...probe(),protection:'DRM'},{...probe(),streams:[{codec_type:'video',codec_name:'h264',width:320,height:240},{codec_type:'audio',codec_name:'unknown'}]}])assert.equal(directCandidate({...e,lightweightProbe:p}),undefined);
 assert.equal(directCandidate({...e,sourceStale:true}),undefined);
});

test('real HTTP original bytes: HEAD, range boundaries, reconnect, identity, stale source, cleanup',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-direct-')),file=path.join(root,'日本語.mp4'),bytes=Buffer.alloc(2*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;await fs.writeFile(file,bytes);
 const st=await fs.stat(file),e:any={objectId:'experimental/catalog-item/'+ 'a'.repeat(32),filename:path.basename(file),fingerprint:{path:file,size:st.size,mtimeMs:st.mtimeMs},lightweightProbe:probe()};
 const events:any[]=[],d=createDirectMedia(()=>[root],(event,detail)=>events.push({event,detail}));
 const server=createServer((req,res)=>void d.deliver(req,res,e));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+(server.address() as any).port;
 const xml=d.item(e,base,d.client(request('VLC/3.0'),'127.0.0.1'))!,url=/<res\b[^>]*>([^<]+)<\/res>/.exec(xml)![1].replaceAll('&amp;','&');
 assert.ok(!xml.includes(root));assert.ok(xml.includes('DLNA.ORG_OP=01'));assert.ok(xml.includes('size="2097152"'));
 assert.equal(d.item(e,base,'192.0.2.10'),undefined);
 const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
 const all=await fetch(url);assert.deepEqual(Buffer.from(await all.arrayBuffer()),bytes);
 for(const [range,start,end] of [['bytes=0-0',0,0],['bytes=65530-65600',65530,65600],['bytes=-50',bytes.length-50,bytes.length-1],['bytes=2097100-',2097100,bytes.length-1],['bytes=2097100-9999999',2097100,bytes.length-1]] as const){
  const res=await fetch(url,{headers:{Range:range,'User-Agent':'different media downloader'}});assert.equal(res.status,206);assert.equal(res.headers.get('content-range'),`bytes ${start}-${end}/${bytes.length}`);assert.deepEqual(Buffer.from(await res.arrayBuffer()),bytes.subarray(start,end+1));
 }
 for(const range of ['bytes=2097152-','bytes=-0','bytes=0-1,5-6','garbage']){const r=await fetch(url,{headers:{Range:range}});assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),`bytes */${bytes.length}`);await r.arrayBuffer();}
 assert.equal((await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=1-2'}})).status,406);
 assert.equal((await fetch(url.replace(/access=.*/, 'access=invalid'))).status,403);
 const other=d.item(e,base,d.client(request('VLC/3','192.0.2.9'),'192.0.2.9'))!;assert.equal((await fetch(/<res\b[^>]*>([^<]+)<\/res>/.exec(other)![1])).status,403);
 const controller=new AbortController();const aborted=await fetch(url,{signal:controller.signal});await aborted.body!.getReader().read();controller.abort();
 const next=await fetch(url,{headers:{Range:'bytes=100-200'}});assert.equal((await next.arrayBuffer()).byteLength,101);
 await fs.appendFile(file,'changed');assert.equal((await fetch(url)).status,409);
 assert.ok(events.some(e=>e.event==='DIRECT_END'&&e.detail.reason==='complete'));
});

test('catalog all/folder/metadata/paging use same original source without probe or JIT; unknown retains old DIDL',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-direct-catalog-')),media=path.join(root,'media'),dir=path.join(root,'index');await fs.mkdir(path.join(media,'下層'),{recursive:true});await fs.mkdir(dir);
 const formats={mp4:'mov,mp4',mkv:'matroska,webm',avi:'avi',wmv:'asf',asf:'asf'};
 for(const extension of Object.keys(formats))await fs.writeFile(path.join(media,'下層','動画.'+extension),'original-'+extension);
 await fs.writeFile(path.join(dir,'library.json'),JSON.stringify({version:'recording-library-v1',enabled:true}));
 const db=await openMediaIndex(dir);await db.scan([media],dir);for(const r of db.page(0,200).entries)db.setMetadata(r.objectId,{path:r.path,size:r.size,mtimeMs:r.mtimeMs},probe(formats[r.container as keyof typeof formats]),4);
 let probes=0;const catalog=createExperimentalCatalog(dir,()=>{},()=>[media],{inspect:async()=>{probes++;throw Error('No probe');}});
 t.after(async()=>{await catalog.closeIndex();await catalog.stopBackground();db.close();await fs.rm(root,{recursive:true,force:true});});
 const client=await catalog.client(request('VLC/3'));
 const legacy=()=>({didl:'<DIDL-Lite></DIDL-Lite>',numberReturned:0,total:0});
 const pages=[];for(let start=0;start<5;start+=2)pages.push(await catalog.libraryBrowse({objectId:'all',start,count:2,metadata:false},client,'http://test',legacy));
 assert.deepEqual(pages.map(p=>p!.numberReturned),[2,2,1]);assert.ok(pages.every(p=>p!.total===5));assert.equal(pages.map(p=>(p!.didl.match(/\/library\/direct\//g)??[]).length).reduce((a,b)=>a+b),5);
 const unknown=await catalog.libraryBrowse({objectId:'all',start:0,count:200,metadata:false},'127.0.0.1','http://test',legacy);assert.ok(!unknown!.didl.includes('<res'));
 const row=db.page(0,1).entries[0],id=row.objectId.replace('experimental/item/','library/item/');
 const metadata=await catalog.libraryBrowse({objectId:id,start:0,count:1,metadata:true},client,'http://test',legacy);assert.ok(metadata!.didl.includes('<res'));assert.ok(metadata!.didl.includes(id));
 let folder=FOLDER_ROOT;for(let depth=0;depth<3;depth++){const page=await catalog.folderBrowse({objectId:folder,start:0,count:200,metadata:false},client,'http://test',async()=>undefined);const child=/<container id="([^"]+)"/.exec(page!.didl);if(!child){assert.equal((page!.didl.match(/\/library\/direct\//g)??[]).length,5);assert.ok(page!.didl.includes(`parentID="${folder}"`));break;}folder=child[1];}
 assert.equal(probes,0);assert.equal(catalog.jitStatus().length,0);
});
