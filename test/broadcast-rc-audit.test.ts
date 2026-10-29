import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {fixture} from './broadcast-fixture.js';import {scanRecordingEit} from '../src/eit-scanner.js';import {summarizeEit,metadataDisplay,validMetadata} from '../src/recording-metadata.js';import {sectionCrc} from '../src/arib-metadata.js';import {createPcrBackground} from '../src/pcr-background.js';import {clearPcrIndexCache} from '../src/pcr-index.js';
async function setup(t:any){const root=await fs.mkdtemp(path.join(os.tmpdir(),'broadcast-rc-')),media=path.join(root,'media'),data=path.join(root,'data');await fs.mkdir(media);await fs.mkdir(data);const source=path.join(media,'source.ts');await fs.writeFile(source,fixture());await fs.utimes(source,new Date(0),new Date(0));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,media,data,source};}
test('explicit timezone and real calendar dates required; zero duration does not create a schedule',async t=>{
 const {source}=await setup(t),m=summarizeEit(await scanRecordingEit(source));
 for(const date of ['2026-02-30T00:00:00Z','2026-13-01T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:00','not-time']){const bad={...m,startTime:date};assert.equal(validMetadata(bad),false,date);assert.equal(metadataDisplay({title:'filename',modified:'2026-01-01T00:00:00Z',metadata:bad}).date,'2026-01-01T00:00:00Z');}
 assert.equal(validMetadata({...m,startTime:'2026-01-01T09:00:00+09:00'}),true);
 assert.equal(metadataDisplay({title:'filename',modified:'2026-01-01T00:00:00Z',metadata:{...m,durationSeconds:0}}).scheduledEndTime,undefined);
});
test('PAT transport identity change makes station, event and recording range uncertain',async t=>{
 const {source}=await setup(t),b=fixture(),pat=Buffer.from(b.subarray(0,188));pat[3]=(pat[3]&240)|1;pat.writeUInt16BE(2,8);const section=pat.subarray(5,21);section.writeUInt32BE(sectionCrc(section.subarray(0,-4)),section.length-4);pat.copy(b,350*188);await fs.writeFile(source,b);
 const s=await scanRecordingEit(source),m=summarizeEit(s);assert.equal(s.scopeConsistent,false);assert.notEqual(m.state,'confirmed');assert.equal(m.station,undefined);assert.notEqual(m.recordingRange?.state,'consistent');
});
test('permanent failures stop after three attempts, survive restart, and reset only on source change',async t=>{
 const {source,data,media}=await setup(t),old=process.env.PT3_DATA_DIR;process.env.PT3_DATA_DIR=data;clearPcrIndexCache();let now=Date.now()+1000,calls=0;
 const make=()=>createPcrBackground(data,()=>[media],()=>{},{now:()=>now,free:async()=>20*1024**3,async metadata(){calls++;throw Error('permanent invalid SI');}});let worker=make();
 t.after(async()=>{await worker.stop();clearPcrIndexCache();if(old===undefined)delete process.env.PT3_DATA_DIR;else process.env.PT3_DATA_DIR=old;});
 const inventory=async()=>({roots:[media],entries:[{file:source,stat:await fs.stat(source)}],failedPaths:[]});await worker.configure({settleMs:0,idleGraceMs:0,readBytesPerSecond:64*1024**2});worker.accept(await inventory());
 for(const [i,advance]of [0,60001,300001].entries()){now+=advance;await worker.runOnce();for(let j=0;j<100&&worker.status().metadataFailed<i+1;j++)await sleep(10);assert.equal(calls,i+1);await worker.runOnce();assert.equal(calls,i+1);}
 now+=86400000;for(let i=0;i<5;i++)await worker.runOnce();assert.equal(calls,3);await worker.stop();clearPcrIndexCache();worker=make();worker.accept(await inventory());await worker.runOnce();await sleep(40);await worker.runOnce();assert.equal(calls,3,'restart must not erase the retry cap');
 await fs.utimes(source,new Date(2000),new Date(2000));worker.accept(await inventory());await worker.runOnce();for(let i=0;i<100&&calls===3;i++)await sleep(10);assert.equal(calls,4);await worker.stop();
});
