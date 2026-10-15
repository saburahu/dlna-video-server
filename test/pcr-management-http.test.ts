import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {syntheticTs} from './ts-fixture.js';

test('PCR management HTTP observes prefetch, pauses/resumes and persists policy across restart', {timeout:30000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-pcr-api-')),data=path.join(dir,'data'),media=path.join(dir,'media');await fs.mkdir(data);await fs.mkdir(media);
 await fs.writeFile(path.join(media,'sample.ts'),syntheticTs(3000,5000));
 await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({port:0,interfaceAddress:'127.0.0.1',folders:[media],profile:'regza-zp2-buffered'}));
 let child:ChildProcess|undefined,base='';
 const stop=async()=>{if(child?.exitCode===null){const end=once(child,'exit');child.kill();await end;}child=undefined;};
 t.after(async()=>{await stop();await fs.rm(dir,{recursive:true,force:true});});
 const start=async()=>{child=spawn(process.execPath,['--import','tsx','src/server.ts'],{env:{...process.env,PT3_DATA_DIR:data,PT3_LOG_DIR:path.join(dir,'logs'),PT3_DISABLE_SSDP:'1'},stdio:['ignore','pipe','pipe']});base=await new Promise<string>((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error(out)),15000);const read=(b:Buffer)=>{out+=b;const m=/localhost:(\d+)/.exec(out);if(m&&out.includes('スキャン完了')){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}};child!.stdout!.on('data',read);child!.stderr!.on('data',read);child!.once('error',reject);});};
 const get=()=>fetch(base+'/api/pcr-cache').then(r=>r.json());
 const post=(patch:unknown)=>fetch(base+'/api/pcr-cache',{method:'POST',headers:{'X-PT3-Management':'1','content-type':'application/json'},body:JSON.stringify(patch)});
 await start();const initial=await get();assert.equal(initial.policy.maxDiskBytes,null);
 assert.equal((await post({readBytesPerSecond:-1})).status,400);
 assert.equal((await post({settleMs:0,idleGraceMs:0,minFreeBytes:0,readBytesPerSecond:64*1024**2})).status,200);
 assert.equal((await fetch(base+'/api/scan',{method:'POST',headers:{'X-PT3-Management':'1'}})).status,200);
 let s=await get();for(let i=0;i<100&&s.success===0;i++){await sleep(50);s=await get();}
 assert.equal(s.success,1,JSON.stringify(s));assert.equal(s.usage.files,1);assert.ok(s.usage.bytes>0);assert.equal(s.work.active,null);
 const fileNames=await fs.readdir(path.join(data,'pcr-cache'));for(let i=0;i<10;i++)await get();assert.deepEqual(await fs.readdir(path.join(data,'pcr-cache')),fileNames);
 const ui=await fetch(base+'/').then(r=>r.text());assert.match(ui,/id="pcrForm"/);
 assert.equal((await post({paused:true})).status,200);await stop();await start();
 assert.equal((await get()).policy.paused,true);assert.deepEqual(await fs.readdir(path.join(data,'pcr-cache')),fileNames);
 assert.equal((await post({paused:false})).status,200);
 const p=(await fetch(base+'/api/programs').then(r=>r.json()))[0];const r=await fetch(base+'/media/'+p.id,{headers:{'TimeSeekRange.dlna.org':'npt=0-0.1'}});assert.equal(r.status,200);assert.ok((await r.arrayBuffer()).byteLength>0);
 assert.equal((await fetch(base+'/api/status').then(r=>r.json())).pcrCache.builds,0,'restart reuses persisted prefetch cache');
});
