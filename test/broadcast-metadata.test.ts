import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {syntheticTs} from './ts-fixture.js';
import {sectionCrc} from '../src/arib-metadata.js';
import {parseSdt,recordingRange} from '../src/recording-si.js';
import {scanRecordingEit} from '../src/eit-scanner.js';
import {RecordingMetadataCache,summarizeEit,metadataDisplay,validMetadata} from '../src/recording-metadata.js';
import {browseDIDL} from '../src/upnp.js';import {profiles} from '../src/core.js';
import {createPcrWork,pcrWork,PcrDeferred} from '../src/pcr-work.js';
import {createPcrBackground} from '../src/pcr-background.js';
import {clearPcrIndexCache,buildPcrIndex} from '../src/pcr-index.js';

import {base,sdt,fixture} from './broadcast-fixture.js';
async function setup(t:any,bytes=fixture()){const root=await fs.mkdtemp(path.join(os.tmpdir(),'broadcast-044-')),media=path.join(root,'media'),data=path.join(root,'data');await fs.mkdir(media);await fs.mkdir(data);const source=path.join(media,'recording.ts');await fs.writeFile(source,bytes);await fs.utimes(source,new Date(0),new Date(0));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,media,data,source};}

test('SDT actual/current CRC and ARIB service decode, no other-TS guesses',()=>{
 assert.equal(parseSdt(sdt())[0].name.normalize('NFKC'),'STATION & <HD>');
 const other=sdt();other[0]=0x46;assert.deepEqual(parseSdt(other),[]);const next=sdt();next[5]&=254;assert.deepEqual(parseSdt(next),[]);
 const bad=sdt();bad[20]^=1;assert.throws(()=>parseSdt(bad));
});
test('full scanner preserves identity, station, schedule, bounded transport-clock summary and original bytes',async t=>{
 const {source}=await setup(t),before=await fs.readFile(source),s=await scanRecordingEit(source),m=summarizeEit(s);
 assert.equal(s.recordingRange.state,'consistent');assert.equal(m.station?.normalize('NFKC'),'STATION & <HD>');assert.equal(m.transportStreamId,1);assert.equal(m.originalNetworkId,4);assert.equal(m.state,'confirmed');assert.equal(m.startTime,new Date(base+10000).toISOString());assert.equal(m.recordingRange?.startTime,new Date(base).toISOString());assert(!JSON.stringify(m).includes('timeAnchors'));assert.deepEqual(await fs.readFile(source),before);
 const modified=structuredClone(s);modified.services.push({...s.services[0],name:'CONFLICT'});assert.equal(summarizeEit(modified).station,undefined);
 modified.services=[{...s.services[0],originalNetworkId:99}];assert.equal(summarizeEit(modified).station,undefined);
 modified.services=[{...s.services[0],transportStreamId:99}];assert.equal(summarizeEit(modified).station,undefined);
 const noTot=fixture();for(let i=0;i<600;i++)if(noTot[i*188+2]===0x14)noTot[i*188+2]=0x15;
 const f=path.join(path.dirname(source),'without-time.ts');await fs.writeFile(f,noTot);assert.equal((await scanRecordingEit(f)).recordingRange.state,'missing');
});
test('time range refuses lone/partial/gapped clocks; handles consistent transport time independently of program',()=>{
 const anchors=[0,10,20,30].map((seconds,packet)=>({packet,seconds,timeMs:base+seconds*1000}));
 assert.equal(recordingRange(anchors,30,0).state,'consistent');assert.equal(recordingRange([],30,0).state,'missing');assert.equal(recordingRange(anchors.slice(0,1),30,0).state,'insufficient');assert.equal(recordingRange(anchors,600,0).state,'insufficient');assert.equal(recordingRange(anchors,30,1).state,'discontinuous');assert.equal(recordingRange(anchors,null,0).state,'insufficient');
 anchors[3].timeMs+=60000;assert.equal(recordingRange(anchors,30,0).state,'inconsistent');
});
test('DIDL keeps dc:date/resource identity and separates schedule from estimated transport recording range',async t=>{
 const {source}=await setup(t),m=summarizeEit(await scanRecordingEit(source)),st=await fs.stat(source),p={id:'stable',filePath:source,title:'filename',size:st.size,modified:st.mtime.toISOString(),duration:60,published:true,analysis:'ok' as const,metadata:m,station:m.station};
 const a=browseDIDL('all',0,200,[p],'http://localhost',profiles.standard).didl,b=browseDIDL('item:stable',0,1,[p],'http://localhost',profiles.standard,true).didl;
 assert.equal(a,b);assert.match(a,/<upnp:channelName>ＳＴＡＴＩＯＮ/);assert.match(a,/<upnp:scheduledStartTime>2026-01-01T09:00:10.000\+09:00/);assert.match(a,/<upnp:scheduledEndTime>2026-01-01T09:00:50.000\+09:00/);assert.match(a,/<dc:date>2026-01-01T09:00:00.000\+09:00/);assert.match(a,/TOT\/PCR推定/);assert.match(a,/duration="00:01:00.000"/);assert.match(a,/<upnp:channelNr>10<\/upnp:channelNr>/);assert.match(a,/<arib:objectType>ARIB_BS<\/arib:objectType>/);assert(!a.includes('recordedStartDateTime'));
 assert.match(browseDIDL('all',0,1,[{...p,station:'局 & <HD>'}],'http://localhost',profiles.standard).didl,/<upnp:channelName>局 &amp; &lt;HD&gt;/);
 const bad=structuredClone(m);bad.recordingRange!.endTime='bad';assert(!validMetadata(bad));assert.equal(metadataDisplay({...p,metadata:bad}).date,p.modified);
});
test('old schema migrates automatically without retaining stale station or mutating source',async t=>{
 const {source,data}=await setup(t),cache=new RecordingMetadataCache(data),first=await cache.analyze(source),file=path.join(data,(await fs.readdir(data))[0]);let row=JSON.parse(await fs.readFile(file,'utf8'));row.version=1;await fs.writeFile(file,JSON.stringify(row));assert.equal((await cache.lookup(source)).reason,'schema-upgrade');
 const r=await new RecordingMetadataCache(data).analyze(source);assert.equal(r.cached,false);assert.equal(r.metadata.station,first.metadata.station);row=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(row.version,2);assert.equal(row.sha256,createHash('sha256').update(JSON.stringify(row.metadata)).digest('hex'));
});
test('physical hard-link aliases share a scan and persist independently; deleted sources do not publish',async t=>{
 const {source,data}=await setup(t),alias=path.join(path.dirname(source),'alias.ts');await fs.link(source,alias);let calls=0;
 const cache=new RecordingMetadataCache(data,async f=>{calls++;await sleep(15);return scanRecordingEit(f)});
 await Promise.all(Array.from({length:20},(_,i)=>cache.analyze(i%2?source:alias)));assert.equal(calls,1);assert.equal((await cache.lookup(alias)).state,'confirmed');assert.equal((await fs.readdir(data)).length,1);
 await fs.unlink(alias);assert.equal((await cache.lookup(alias)).reason,'file-unavailable');await assert.rejects(cache.analyze(alias));assert(!(await fs.readdir(data)).some(x=>x.endsWith('.tmp')));
});
test('background SI abort yields no error cache, then resumes from unchanged source',async t=>{
 const {source,data}=await setup(t);let calls=0;const cache=new RecordingMetadataCache(data,async f=>{if(!calls++)throw new PcrDeferred('playback');return scanRecordingEit(f)});
 await assert.rejects(cache.analyze(source,false,{background:true}),PcrDeferred);assert.equal((await fs.readdir(data)).length,0);assert.equal((await cache.analyze(source,false,{background:true})).metadata.state,'confirmed');
});
test('same-source media preempts metadata while foreground PCR promotion semantics remain independent',async()=>{
 const work=createPcrWork();let started!:()=>void;const begun=new Promise<void>(r=>started=r);
 const job=work.run({source:'source',key:'metadata',background:true,yieldToMedia:true,bytesPerSecond:65536},async c=>{started();await c.charge(1024*1024,'metadata');});
 const rejected=assert.rejects(job,PcrDeferred);await begun;const release=work.reserve('source');await rejected;release();assert.equal(work.status().preemptions,1);
});
test('real throttled SI read stops on playback and leaves no incomplete metadata asset',async t=>{
 const {source,data}=await setup(t);await buildPcrIndex(source);const cache=new RecordingMetadataCache(data);
 const job=cache.analyze(source,false,{background:true,bytesPerSecond:65536}),rejected=assert.rejects(job,e=>e instanceof PcrDeferred||(e as Error).name==='AbortError');
 for(let n=0;n<100&&pcrWork.status().active?.phase!=='metadata-prefix';n++)await sleep(5);
 assert.equal(pcrWork.status().active?.phase,'metadata-prefix');const release=pcrWork.reserve(source);await rejected;release();
 assert.equal((await fs.readdir(data)).length,0);assert.equal((await cache.analyze(source,false,{background:true,bytesPerSecond:64*1024**2})).metadata.state,'confirmed');
});
test('automatic metadata stage uses stable startup inventory, serial bounded work, pause/restart/cache reuse',async t=>{
 const {source,data,media}=await setup(t),old=process.env.PT3_DATA_DIR;process.env.PT3_DATA_DIR=data;clearPcrIndexCache();
 let now=Date.now(),calls=0,worker:ReturnType<typeof createPcrBackground>;const cache=new RecordingMetadataCache(path.join(data,'eit-cache'));
 const make=()=>createPcrBackground(data,()=>[media],()=>{},{now:()=>now,free:async()=>20*1024**3,async metadata(f,options){calls++;await cache.analyze(f,false,options);}});
 worker=make();t.after(async()=>{await worker.stop();clearPcrIndexCache();if(old===undefined)delete process.env.PT3_DATA_DIR;else process.env.PT3_DATA_DIR=old;});
 const inv={roots:[media],entries:[{file:source,stat:await fs.stat(source)}],failedPaths:[]};
 await worker.configure({settleMs:1000,idleGraceMs:0,readBytesPerSecond:64*1024**2});worker.accept(inv);await worker.runOnce();assert.equal(calls,0);
 now+=1001;await worker.configure({paused:true});await worker.runOnce();assert.equal(calls,0);await worker.configure({paused:false});await worker.runOnce();
 for(let n=0;n<200&&!worker.status().metadataSuccess;n++)await sleep(10);assert.equal(worker.status().success,1);assert.equal((await cache.lookup(source)).state,'confirmed');await worker.stop();
 clearPcrIndexCache();worker=make();worker.accept(inv);await worker.runOnce();for(let n=0;n<200&&!worker.status().metadataSuccess;n++)await sleep(10);assert.equal(worker.status().success,1);assert.equal(calls,2);assert.equal((await cache.lookup(source)).state,'confirmed');assert.equal(pcrWork.status().active,null);await worker.stop();
});
test('five thousand inventory entries do not spawn five thousand metadata scans',async t=>{
 const {source,data,media}=await setup(t),old=process.env.PT3_DATA_DIR;process.env.PT3_DATA_DIR=data;clearPcrIndexCache();let now=Date.now()+1000,calls=0;
 const worker=createPcrBackground(data,()=>[media],()=>{},{now:()=>now,free:async()=>20*1024**3,async metadata(){calls++;}});
 t.after(async()=>{await worker.stop();clearPcrIndexCache();if(old===undefined)delete process.env.PT3_DATA_DIR;else process.env.PT3_DATA_DIR=old;});
 await worker.configure({settleMs:100,idleGraceMs:0,readBytesPerSecond:64*1024**2});const stat=await fs.stat(source);
 worker.accept({roots:[media],entries:[{file:path.join(media,'a-deleted.ts'),stat},{file:source,stat},...Array.from({length:4998},(_,i)=>({file:path.join(media,`z-${i}.ts`),stat}))],failedPaths:[]});
 await worker.runOnce();assert.equal(calls,0);now+=101;await worker.runOnce();assert.equal(calls,0,'a disappeared file does not create a metadata scan');await worker.runOnce();for(let i=0;i<200&&!worker.status().metadataSuccess;i++)await sleep(10);
 assert.equal(calls,1);assert.equal(worker.status().success,1);assert.equal(worker.status().work.queued,0);await worker.stop();
});
test('automatic metadata failure backs off and recovers without a new directory scan',async t=>{
 const {source,data,media}=await setup(t),old=process.env.PT3_DATA_DIR;process.env.PT3_DATA_DIR=data;clearPcrIndexCache();let now=Date.now()+1000,calls=0;
 const worker=createPcrBackground(data,()=>[media],()=>{},{now:()=>now,free:async()=>20*1024**3,async metadata(){if(++calls===1)throw Error('transient read failure');}});
 t.after(async()=>{await worker.stop();clearPcrIndexCache();if(old===undefined)delete process.env.PT3_DATA_DIR;else process.env.PT3_DATA_DIR=old;});
 await worker.configure({settleMs:0,idleGraceMs:0,readBytesPerSecond:64*1024**2});worker.accept({roots:[media],entries:[{file:source,stat:await fs.stat(source)}],failedPaths:[]});await worker.runOnce();for(let i=0;i<200&&!worker.status().metadataFailed;i++)await sleep(10);
 assert.equal(worker.status().metadataFailed,1);assert.equal(worker.status().success,1);await worker.runOnce();assert.equal(calls,1);now+=60001;await worker.runOnce();for(let i=0;i<200&&!worker.status().metadataSuccess;i++)await sleep(10);assert.equal(calls,2);assert.equal(worker.status().success,1);assert.equal(worker.status().metadataSuccess,1);await worker.stop();
});
