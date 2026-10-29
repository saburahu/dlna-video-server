import test from 'node:test';import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {spawn,type ChildProcess} from 'node:child_process';import {once} from 'node:events';import {setTimeout as sleep} from 'node:timers/promises';
import {fixture} from './broadcast-fixture.js';

test('normal startup automatically hydrates station and schedule, Browse/Metadata/HEAD/GET agree and restart reuses cache', {timeout:30000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'broadcast-http-')),data=path.join(root,'data'),media=path.join(root,'media'),source=path.join(media,'recording.ts');await fs.mkdir(data);await fs.mkdir(media);const bytes=fixture();await fs.writeFile(source,bytes);await fs.utimes(source,946684800.1238,946684800.1238);
 const sourceStat=await fs.stat(source);assert.notEqual(sourceStat.mtimeMs,Date.parse(sourceStat.mtime.toISOString()),'exercise real filesystem sub-millisecond precision');
 const udn='uuid:00000000-0000-4000-8000-000000000044';
 await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({udn,port:0,interfaceAddress:'127.0.0.1',folders:[media],profile:'standard'}));
 // Test-only policy accelerates the production idle/settle clocks, not parsing or validity checks.
 await fs.writeFile(path.join(data,'pcr-cache-policy.json'),JSON.stringify({settleMs:25,idleGraceMs:300,readBytesPerSecond:64*1024**2,minFreeBytes:0}));
 let child:ChildProcess|undefined;
 const stop=async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}child=undefined;};
 t.after(async()=>{await stop();await fs.rm(root,{recursive:true,force:true});});
 async function start(){child=spawn(process.execPath,['--import','tsx',process.env.PT3_TEST_DIST==='1'?'dist/src/server.js':'src/server.ts'],{env:{...process.env,PT3_DATA_DIR:data,PT3_LOG_DIR:path.join(root,'logs'),PT3_DISABLE_SSDP:'1',PT3_PCR_BACKGROUND_DISABLED:'0'},stdio:['ignore','pipe','pipe']});let output='';
  return new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(output)),10000);child!.once('error',e=>{clearTimeout(timer);reject(e);});child!.stderr!.on('data',b=>output+=b);child!.stdout!.on('data',b=>{output+=b;const port=/localhost:(\d+)/.exec(output);if(port&&output.includes('スキャン完了')){clearTimeout(timer);resolve('http://127.0.0.1:'+port[1]);}});});
 }
 let url=await start();const initial=(await (await fetch(url+'/api/programs')).json())[0];assert(initial);assert.notEqual(initial.metadata.state,'confirmed');
 async function browse(id:string,flag:string){const r=await fetch(url+'/upnp/control/content-directory',{method:'POST',headers:{SOAPAction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'},body:`<ObjectID>${id}</ObjectID><BrowseFlag>${flag}</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>200</RequestedCount>`});assert.equal(r.status,200);return r.text();}
 const before=await browse('all','BrowseDirectChildren');let p:any;
 for(let i=0;i<150;i++){p=(await (await fetch(url+'/api/programs')).json())[0];if(p.metadata.state==='confirmed')break;
  // No refresh/analyze: automatic publication itself must update the listing.
  await sleep(50);}
 assert.equal(p.metadata.state,'confirmed');assert.equal(p.station.normalize('NFKC'),'STATION & <HD>');assert.equal(p.id,initial.id);assert.equal(p.title,initial.title);
 const direct=await browse('all','BrowseDirectChildren'),meta=await browse('item:'+p.id,'BrowseMetadata');assert.match(direct,/scheduledStartTime/);assert.match(meta,/scheduledEndTime/);assert.match(meta,/TOT\/PCR推定/);assert.notEqual(before.match(/<UpdateID>(\d+)/)?.[1],direct.match(/<UpdateID>(\d+)/)?.[1]);
 const decode=(s:string)=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&amp;','&');
 const item=(s:string)=>decode(s.match(/<Result>([\s\S]*?)<\/Result>/)![1]).match(/<item\b[\s\S]*?<\/item>/)![0];assert.equal(item(direct),item(meta));
 const resource=item(meta).match(/<res\b[^>]*>([^<]+)<\/res>/)![1],head=await fetch(resource,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),bytes.length);
 const get=await fetch(resource,{headers:{Range:'bytes=0-187'}});assert.equal(get.status,206);assert.deepEqual(Buffer.from(await get.arrayBuffer()),bytes.subarray(0,188));
 const cacheDir=path.join(data,'eit-cache'),cacheFile=path.join(cacheDir,(await fs.readdir(cacheDir)).find(x=>x.endsWith('.json'))!);const damaged=JSON.parse(await fs.readFile(cacheFile,'utf8'));damaged.metadata.title='corrupt-cache';await fs.writeFile(cacheFile,JSON.stringify(damaged));
 const invalid=await fetch(url+'/api/metadata/refresh',{method:'POST',headers:{'X-PT3-Management':'1'}}).then(r=>r.json());assert.equal(invalid[0].metadata.state,'pending');
 const parallel=await Promise.all(Array.from({length:10},()=>browse('all','BrowseDirectChildren')));assert(parallel.every(x=>!x.includes('corrupt-cache')));
 for(let i=0;i<150;i++){p=(await (await fetch(url+'/api/programs')).json())[0];if(p.metadata.state==='confirmed')break;await sleep(50);}assert.equal(p.metadata.state,'confirmed');assert.notEqual(p.metadata.title,'corrupt-cache');
 assert.equal(item(await browse('item:'+p.id,'BrowseMetadata')).match(/<res\b[^>]*>([^<]+)/)![1],resource);
 const scanned=p.metadata.scannedAt;await stop();url=await start();const reloaded=(await (await fetch(url+'/api/programs')).json())[0];assert.equal(reloaded.metadata.scannedAt,scanned);assert.equal(reloaded.id,p.id);assert.equal(JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8')).udn,udn);assert.deepEqual(await fs.readFile(source),bytes);await stop();
});
