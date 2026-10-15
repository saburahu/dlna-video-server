import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {JitRequestQueue} from '../src/jit-request-queue.js';
import {SharedJitJobs} from '../src/shared-jit-job.js';
import {saveShadowJson} from '../src/playback-shadow-store.js';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const response=()=>{const emitter=new EventEmitter();return Object.assign(emitter,{destroyed:false,status:0,destroy(){this.destroyed=true;emitter.emit('close');},writeHead(status:number){this.status=status;},end(){}}) as unknown as ServerResponse&{status:number};};
const gate=()=>{let release!:()=>void;return {promise:new Promise<void>(r=>release=r),release:()=>release()};};

test('capacity reserves preparation and cleanup, both latest seekers inherit slots, third never cancels either',async()=>{
 const q=new JitRequestQueue(),a=response(),b=response();
 const a1=q.begin('A',1,'A1',a)!,b1=q.begin('B',2,'B1',b)!;
 await Promise.all([a1.ready(),b1.ready()]);assert.equal(q.status().occupied,2);
 const third=response();assert.equal(q.begin('C',3,'C1',third),undefined);assert.equal(third.status,409);assert.equal(a.destroyed,false);assert.equal(b.destroyed,false);
 const a2=q.begin('A',4,'A2',response())!,b2=q.begin('B',5,'B2',response())!;
 const a3=q.begin('A',6,'A3',response())!;
 let started=0;
 const old=a2.ready().then(()=>assert.fail('superseded waiter ran'),()=>{}).finally(()=>a2.finish());
 const finalA=a3.ready().then(()=>started++),finalB=b2.ready().then(()=>started++);
 assert.equal(q.status().occupied,2);assert.equal(a.destroyed,true);assert.equal(b.destroyed,true);
 await Promise.resolve();assert.equal(started,0);a1.finish();b1.finish();await Promise.all([old,finalA,finalB]);assert.equal(started,2);
 a1.finish();a2.finish();assert.equal(q.status().occupied,2,'late cleanup cannot free the replacement');
 a3.finish();assert.equal(q.status().occupied,1);const c=q.begin('C',7,'C2',response())!;await c.ready();
 assert.equal(q.status().occupied,2);b2.finish();c.finish();assert.equal(q.status().occupied,0);
 const stale=response();assert.equal(q.begin('A',1,'stale',stale),undefined);assert.equal(stale.destroyed,true);
});

test('one-slot rollback and disconnect while waiting retain cleanup ownership',async()=>{
 const q=new JitRequestQueue(),a=q.begin('A',1,'a',response(),1)!;
 const b=response();assert.equal(q.begin('B',2,'b',b,1),undefined);assert.equal(b.status,409);
 const res=response(),replacement=q.begin('A',3,'new',res,1)!;res.destroy();
 let finished=false;const wait=replacement.ready().catch(()=>{}).finally(()=>{replacement.finish();finished=true;});
 await Promise.resolve();assert.equal(finished,false);assert.equal(q.status().occupied,1);
 a.finish();await wait;assert.equal(q.status().occupied,0);
});

test('shared checkpoint fill survives first client cancellation and final cancellation waits for cleanup',async()=>{
 const jobs=new SharedJitJobs<number>(),ready=gate(),finish=gate(),a=new AbortController(),b=new AbortController();let starts=0;
 const work=async(signal:AbortSignal)=>{starts++;ready.release();await finish.promise;signal.throwIfAborted();return 17;};
 const first=jobs.run('source/policy',work,a.signal);await ready.promise;
 const second=jobs.run('source/policy',work,b.signal);a.abort();await assert.rejects(first);assert.equal(starts,1);
 finish.release();assert.equal(await second,17);
 const entered=gate(),cleanup=gate(),only=new AbortController();let aborted=false;
 const pending=jobs.run('other',async signal=>{entered.release();await new Promise<void>(r=>signal.addEventListener('abort',()=>{aborted=true;r();},{once:true}));await cleanup.promise;throw Error('cancelled');},only.signal);
 await entered.promise;only.abort();let returned=false;const rejected=assert.rejects(pending).then(()=>returned=true);
 await new Promise(r=>setImmediate(r));assert.equal(aborted,true);assert.equal(returned,false);cleanup.release();await rejected;
 assert.equal(await jobs.run('other',async()=>23),23);
});

test('simultaneous atomic cache writers never share temporary file or leave partial JSON',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jit-cache-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'cache.json');await Promise.all(Array.from({length:12},(_,i)=>saveShadowJson(file,{i,data:'x'.repeat(20000)})));
 const result=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(result.data.length,20000);assert.deepEqual(await fs.readdir(dir),['cache.json']);
});
