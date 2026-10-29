import {virtualId} from '../src/virtual-folders.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {syntheticTs} from './ts-fixture.js';

test('1500 TS folder HTTP paging and repeated automatic scans create zero indexes; playback reuses and updates one', {timeout:60000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-pcr-folder-')),data=path.join(root,'state'),media=path.join(root,'録画','深い','1500番組');await fs.mkdir(media,{recursive:true});await fs.mkdir(path.join(data,'experimental-catalog'),{recursive:true});
 const bytes=syntheticTs(1000,5000);
 for(let start=0;start<1500;start+=100)await Promise.all(Array.from({length:100},(_,i)=>fs.writeFile(path.join(media,`${String(start+i).padStart(4,'0')}.ts`),bytes)));
 await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({port:0,folders:[path.join(root,'録画')],interfaceAddress:'127.0.0.1',profile:'regza-zp2-buffered'}));
 await fs.writeFile(path.join(data,'experimental-catalog','library.json'),JSON.stringify({version:'recording-library-v1',enabled:true}));
 await fs.writeFile(path.join(data,'experimental-catalog','automatic.json'),JSON.stringify({enabled:true,scanIntervalMs:1000}));
 const child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:process.cwd(),env:{...process.env,PT3_DATA_DIR:data,PT3_EXPERIMENTAL_CATALOG_DIR:path.join(data,'experimental-catalog'),PT3_LOG_DIR:path.join(root,'logs'),PT3_DISABLE_SSDP:'1'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}await fs.rm(root,{recursive:true,force:true});});
 const base=await new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(output)),20000);const consume=(b:Buffer)=>{output+=b.toString();const m=/http:\/\/(?:localhost|127\.0\.0\.1):\d+/.exec(output);if(m){clearTimeout(timer);resolve(m[0].replace('localhost','127.0.0.1'));}};child.stdout.on('data',consume);child.stderr.on('data',consume);child.once('error',e=>{clearTimeout(timer);reject(e);});});
 const status=()=>fetch(base+'/api/status').then(r=>r.json());
 const worker=()=>fetch(base+'/api/experimental/catalog/status').then(r=>r.json());
 // This is a correctness fixture, not a five-second disk throughput benchmark.
 // Concurrent large-library fixtures can delay completion on the same volume.
 const waitForScans=async(min:number)=>{const deadline=Date.now()+20000;let state=await worker();while(state.scans<min&&Date.now()<deadline){await new Promise(r=>setTimeout(r,50));state=await worker();}assert.ok(state.scans>=min,'inventory scans did not complete');};
 await waitForScans(1);
 const browse=async(id:string,start=0,count=100)=>{const at=performance.now();const r=await fetch(base+'/upnp/control/content-directory',{method:'POST',headers:{soapaction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'},body:`<ObjectID>${id}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>${start}</StartingIndex><RequestedCount>${count}</RequestedCount>`});assert.equal(r.status,200);const soap=await r.text(),didl=soap.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&').replaceAll('&quot;','"');return {soap,didl,ms:performance.now()-at};};
 let folder='folders';for(let i=0;i<3;i++){const p=await browse(folder);folder=/<container id="([^"]+)"/.exec(p.didl)![1];}
 const ids:string[]=[],times:number[]=[];let first:string|undefined;
 for(let start=0;start<1500;start+=100){const p=await browse(virtualId(folder,'media',Math.floor(start/1000)*1000,1000),start%1000);assert.ok(p.soap.includes('<TotalMatches>'+Math.min(1000,1500-Math.floor(start/1000)*1000)+'</TotalMatches>'));assert.match(p.soap,/<NumberReturned>100<\/NumberReturned>/);ids.push(...[...p.didl.matchAll(/<item id="([^"]+)"/g)].map(m=>m[1]));times.push(p.ms);first??=p.didl;}
 assert.equal(new Set(ids).size,1500);assert.equal((await status()).pcrCache.builds,0);assert.equal(await fs.stat(path.join(data,'pcr-cache')).catch(()=>undefined),undefined);
 const cap=await browse(virtualId(folder,'media',0,1000),0,0);assert.match(cap.soap,/<NumberReturned>200<\/NumberReturned>/);
 const scans=(await worker()).scans;await waitForScans(scans+2);assert.equal((await status()).pcrCache.builds,0);
 const tag=/<res\b[^>]*>/.exec(first!)![0];assert.ok(!tag.includes('size='));const url=/<res\b[^>]*>([^<]+)<\/res>/.exec(first!)![1].replaceAll('&amp;','&');
 for(let i=0;i<2;i++){const r=await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=0-0.1'}});assert.equal(r.status,200);assert.ok((await r.arrayBuffer()).byteLength>0);assert.equal((await status()).pcrCache.builds,1);}
 const warm=await browse(virtualId(folder,'media',0,1000));assert.ok(/<res\b[^>]*>/.exec(warm.didl)![0].includes('size='));
 await fs.writeFile(path.join(media,'0000.ts'),syntheticTs(2000,5000));
 const stale=await browse(virtualId(folder,'media',0,1000));assert.ok(!/<res\b[^>]*>/.exec(stale.didl)![0].includes('size='));assert.equal((await status()).pcrCache.builds,1);
 const updated=await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=0-0.1'}});assert.equal(updated.status,200);await updated.arrayBuffer();assert.equal((await status()).pcrCache.builds,2);assert.equal((await fs.readdir(path.join(data,'pcr-cache'))).length,1);
 console.log('PCR_FOLDER_1500',JSON.stringify({firstMs:times[0],middleMs:times[7],lastMs:times.at(-1),maxMs:Math.max(...times),pages:times.length,browseBuilds:0,automaticScans:(await worker()).scans,rss:process.memoryUsage().rss}));
});
