import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RecordingMetadataCache, EitScan, summarizeEit, metadataDisplay } from '../src/recording-metadata.js';
import { browseDIDL } from '../src/upnp.js';
import { profiles } from '../src/core.js';
import type { Program } from '../src/store.js';
function scan(): EitScan {
  const event={eventId:9,startTimeMs:Date.UTC(2026,6,22,14,30),durationSeconds:90,title:'番組 & 第４話',description:'概要 <新>',genres:[0x70],textSuspect:false};
  return {complete:true,clockValid:true,durationSeconds:100,recordingStartTimeMs:event.startTimeMs-5000,counters:{eitSections:10},
    selection:{reason:'recording-overlap',provisional:true,candidates:[{}],primary:{serviceId:141,eventId:9,startTimeMs:event.startTimeMs,durationSeconds:90,overlapSeconds:90}},
    records:[{serviceId:141,eventId:9,startTimeMs:event.startTimeMs,updates:[{tableId:0x4e,current:true,event}]}]} as unknown as EitScan;
}
const program:Program={id:'test',filePath:'original.ts',title:'20260722-original',size:18800,modified:'2026-07-22T14:29:55Z',duration:100,published:true,analysis:'ok'};
async function setup(t: any, strategy: (file:string)=>Promise<EitScan> = async()=>scan(), cleanup=true) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-metadata-'));if(cleanup)t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const folder=path.join(dir,'recordings');await fs.mkdir(folder);const file=path.join(folder,'sample.ts');await fs.writeFile(file,Buffer.alloc(18800,0x47));
  await fs.utimes(file,new Date(0),new Date(0));return {dir,file,cache:new RecordingMetadataCache(path.join(dir,'cache'),strategy,[folder])};
}
test('metadata cache persists compact result; subsequent instance/list lookup never scans',async t=>{
  let calls=0;const {dir,file,cache}=await setup(t,async()=>{calls++;return scan()});
  const before=await fs.readFile(file),st=await fs.stat(file);
  assert.equal((await cache.analyze(file)).metadata.state,'confirmed');
  assert.equal((await cache.analyze(file)).cached,true);
  const reload=new RecordingMetadataCache(path.join(dir,'cache'),async()=>{throw Error('must not scan')});
  assert.equal((await reload.lookup(file)).title,'番組 & 第４話');
  for(let i=0;i<20;i++)browseDIDL('all',0,10,[{...program,metadata:await reload.lookup(file)}],'http://localhost',profiles.standard);
  assert.equal(calls,1);assert.deepEqual(await fs.readFile(file),before);assert.equal((await fs.stat(file)).mtimeMs,st.mtimeMs);
  assert.ok((await fs.stat(path.join(dir,'cache',(await fs.readdir(path.join(dir,'cache')))[0]))).size<65536);
});
for(const change of ['size','mtime'])test(`metadata ${change} invalidates persisted cache`,async t=>{
  let calls=0;const {file,cache}=await setup(t,async()=>{calls++;return scan()});await cache.analyze(file);
  if(change==='size')await fs.appendFile(file,'x');await fs.utimes(file,new Date(1000),new Date(1000));
  assert.equal((await cache.lookup(file)).state,'pending');assert.equal((await cache.analyze(file)).cached,false);assert.equal(calls,2);
});
test('recently modified recordings are deferred with cooldown even while size grows',async t=>{
  let calls=0;const {file,cache}=await setup(t,async()=>{calls++;return scan()});await fs.utimes(file,new Date(),new Date());
  assert.equal((await cache.analyze(file)).metadata.state,'pending');await fs.appendFile(file,'grow');
  assert.equal((await cache.analyze(file)).cached,true);assert.equal(calls,0);assert.equal((await cache.lookup(file)).state,'pending');
});
test('recording changed during scan is never permanently confirmed',async t=>{
  const {file,cache}=await setup(t,async file=>{await fs.appendFile(file,'grow');return scan()});
  const result=await cache.analyze(file);assert.equal(result.metadata.state,'pending');assert.equal(result.metadata.reason,'changed-during-scan');
});
test('cache does not write into recording folder',async t=>{
  const {file}=await setup(t);await assert.rejects(new RecordingMetadataCache(path.join(path.dirname(file),'cache'),async()=>scan()).analyze(file));
});
test('simultaneous requests share one scan',async t=>{
  let calls=0;const {file,cache}=await setup(t,async()=>{calls++;await new Promise(r=>setTimeout(r,20));return scan()});
  await Promise.all([cache.analyze(file),cache.analyze(file)]);assert.equal(calls,1);
});
test('error/no-EIT cached without hiding recording; retry explicitly reanalyzes errors',async t=>{
  let calls=0;const {file,cache}=await setup(t,async()=>{calls++;throw Error('broken TS')});
  assert.equal((await cache.analyze(file)).metadata.state,'error');assert.equal((await cache.analyze(file)).cached,true);
  assert.equal(metadataDisplay({...program,metadata:await cache.lookup(file)}).title,program.title);
  await cache.analyze(file,true);assert.equal(calls,2);
  const s=scan();s.counters.eitSections=0;s.selection=null;s.records=[];assert.equal(summarizeEit(s).state,'no-eit');
});
test('partial/unanchored/minority/ambiguous EIT remains uncertain',()=>{
  for(const mutate of [(s:EitScan)=>s.complete=false,(s:EitScan)=>s.recordingStartTimeMs=null,(s:EitScan)=>s.selection!.primary!.overlapSeconds=10,(s:EitScan)=>s.selection!.primary=null]) {
    const s=scan();mutate(s);const m=summarizeEit(s);assert.equal(m.state,'uncertain');assert.equal(metadataDisplay({...program,metadata:m}).title,program.title);
  }
});
test('ARIB decode failure retains event identity but falls back to filename',()=>{
  const s=scan();s.records[0].updates[0].event.textSuspect=true;const m=summarizeEit(s);
  assert.equal(m.state,'confirmed');assert.equal(m.eventId,9);assert.equal(metadataDisplay({...program,metadata:m}).title,program.title);
});
test('DIDL uses EIT title/description/date/genre while resource remains byte-identical',()=>{
  const plain=browseDIDL('all',0,0,[program],'http://localhost',profiles.standard).didl;
  const enriched=browseDIDL('all',0,0,[{...program,metadata:summarizeEit(scan())}],'http://localhost',profiles.standard).didl;
  assert.match(enriched,/<dc:title>番組 &amp; 第４話<\/dc:title>/);assert.match(enriched,/<dc:description>概要 &lt;新&gt;<\/dc:description>/);
  assert.match(enriched,/<dc:date>2026-07-22T23:30:00.000\+09:00<\/dc:date>/);assert.match(enriched,/<upnp:genre>アニメ／特撮<\/upnp:genre>/);
  assert.equal(enriched.match(/<res .*?<\/res>/)![0],plain.match(/<res .*?<\/res>/)![0]);
  const resources=new Map([[program.id,{url:'http://example/media?unchanged=yes',size:456,profile:profiles.standard}]]);
  assert.equal(browseDIDL('all',0,0,[program],'http://localhost',profiles.standard,false,resources).didl.match(/<res .*?<\/res>/)![0],browseDIDL('all',0,0,[{...program,metadata:summarizeEit(scan())}],'http://localhost',profiles.standard,false,resources).didl.match(/<res .*?<\/res>/)![0]);
});
for(const state of ['no-eit','uncertain'])test(`DIDL ${state} falls back to original title`,()=>{
  assert.match(browseDIDL('all',0,0,[{...program,metadata:{state:state as any,title:'unconfirmed'}}],'http://localhost',profiles.standard).didl,/<dc:title>20260722-original<\/dc:title>/);
});
test('malformed metadata does not fail whole DIDL list',()=>{
  const bad={state:'confirmed',title:{bad:true},genre:'bad'} as any;
  const r=browseDIDL('all',0,0,[{...program,metadata:bad},{...program,id:'second',metadata:summarizeEit(scan())}],'http://localhost',profiles.standard);
  assert.equal(r.numberReturned,2);assert.match(r.didl,/20260722-original/);assert.match(r.didl,/番組 &amp;/);
});
test('corrupt cache is discarded rather than displayed',async t=>{
  const {dir,file,cache}=await setup(t);await cache.analyze(file);const cacheFile=path.join(dir,'cache',(await fs.readdir(path.join(dir,'cache')))[0]);
  const r=JSON.parse(await fs.readFile(cacheFile,'utf8'));r.metadata.title='injected';await fs.writeFile(cacheFile,JSON.stringify(r));assert.equal((await cache.lookup(file)).state,'pending');
  r.metadata.title={bad:true};r.sha256=createHash('sha256').update(JSON.stringify(r.metadata)).digest('hex');await fs.writeFile(cacheFile,JSON.stringify(r));assert.equal((await cache.lookup(file)).state,'pending');
});

test('invalid EIT sections without valid events are analysis errors',()=>{
  const s=scan();s.counters.eitSections=0;s.counters.eitPackets=10;s.counters.invalidSections=10;s.selection=null;s.records=[];
  assert.equal(summarizeEit(s).state,'error');
});
test('real management API and SOAP Browse hydrate cache without TS parsing', {timeout:30000},async t=>{
  const {dir,file}=await setup(t,undefined,false);const data=path.join(dir,'data');await fs.mkdir(data);
  // Deliberately invalid TS: any accidental EIT scan would fail. Only persisted metadata is consumed.
  const cache=new RecordingMetadataCache(path.join(data,'eit-cache'),async()=>scan());await cache.analyze(file);
  const st=await fs.stat(file);const p={...program,id:'abcdef',filePath:file,size:st.size,modified:st.mtime.toISOString()};
  await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({port:0,interfaceAddress:'127.0.0.1',folders:[path.dirname(file)],profile:'standard'}));
  await fs.writeFile(path.join(data,'programs.json'),JSON.stringify([p]));
  const child=spawn(process.execPath,['--import','tsx','src/server.ts'],{env:{...process.env,PT3_DATA_DIR:data,PT3_LOG_DIR:path.join(dir,'logs'),PT3_DISABLE_SSDP:'1'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}await fs.rm(dir,{recursive:true,force:true});});
  let output='';const url=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(output)),15000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',()=>{clearTimeout(timer);reject(Error(output))});child.stderr.on('data',b=>output+=b);child.stdout.on('data',b=>{output+=b;const port=/localhost:(\d+)/.exec(output);if(port&&output.includes('スキャン完了')){clearTimeout(timer);resolve('http://127.0.0.1:'+port[1]);}})});
  const list=await (await fetch(url+'/api/programs')).json();assert.equal(list[0].displayTitle,'番組 & 第４話');assert.equal(list[0].title,p.title);assert.equal(list[0].metadata.eventId,9);
  const payload='<ObjectID>all</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>10</RequestedCount>';
  const browse=async()=>{const r=await fetch(url+'/upnp/control/content-directory',{method:'POST',headers:{SOAPAction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'},body:payload});assert.equal(r.status,200);return r.text()};
  const xml=await browse();assert.match(xml,/番組 &amp;amp; 第４話/);assert.match(xml,/20260722-original.ts/);
  // Replace the valid cache with a new title and refresh through the normal API.
  const replacement=scan();replacement.records[0].updates[0].event.title='更新タイトル';
  await fs.utimes(file,new Date(1000),new Date(1000));await new RecordingMetadataCache(path.join(data,'eit-cache'),async()=>replacement).analyze(file);
  const refreshed=await fetch(url+'/api/metadata/refresh',{method:'POST',headers:{'X-PT3-Management':'1'}});assert.equal(refreshed.status,200);assert.equal((await refreshed.json())[0].displayTitle,'更新タイトル');
  assert.match(await browse(),/更新タイトル/);assert.equal((await fs.readdir(path.join(data,'eit-cache'))).length,1);
  const status=await (await fetch(url+'/api/status')).json();assert.equal(status.logStorage.error,null);
});
