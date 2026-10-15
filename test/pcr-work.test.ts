import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createPcrWork,PcrDeferred} from '../src/pcr-work.js';

test('PCR prefetch promotes shared source without restarting or throttling foreground',async()=>{
 const w=createPcrWork();let reads=0;
 const background=w.run({source:'a.ts',key:'1',background:true,bytesPerSecond:65536},async c=>{reads++;await c.charge(65536,'read');return 7;});
 await sleep(25);const release=w.reserve('a.ts');
 const foreground=w.run({source:'a.ts',key:'1'},async()=>{throw Error('duplicate reader');});
 assert.equal(background,foreground);assert.equal(await foreground,7);release();
 assert.equal(reads,1);assert.equal(w.status().promotions,1);
});

test('PCR different-source playback preempts prefetch; foreground readers remain serial',async()=>{
 const w=createPcrWork();let active=0,max=0;const order:string[]=[];
 const bg=w.run({source:'a.ts',key:'1',background:true,bytesPerSecond:65536},async c=>{await c.charge(65536,'read');});
 const rejected=assert.rejects(bg,PcrDeferred);await sleep(20);
 const release=w.reserve('b.ts');
 const action=(name:string)=>async()=>{active++;max=Math.max(max,active);order.push(name);await sleep(10);active--;return name;};
 const b=w.run({source:'b.ts',key:'1'},action('b'));
 const c=w.run({source:'c.ts',key:'1'},action('c'));
 await rejected;assert.deepEqual(await Promise.all([b,c]),['b','c']);release();
 assert.equal(max,1);assert.deepEqual(order,['b','c']);
});

test('PCR pause holds queued background and shutdown cancels it without waiting for playback',async()=>{
 const w=createPcrWork();w.pause(true);let ran=false;
 const bg=w.run({source:'a.ts',key:'1',background:true},async()=>{ran=true;});
 const rejected=assert.rejects(bg,PcrDeferred);await sleep(10);assert.equal(ran,false);
 w.cancelBackground('shutdown');await rejected;assert.equal(w.status().queued,0);
 w.pause(false);const release=w.reserve();
 const next=w.run({source:'b.ts',key:'1',background:true},async()=>5);
 await sleep(10);assert.equal(w.status().active,null);release();assert.equal(await next,5);
});

test('PCR background read budget is enforced and foreground is not delayed',async()=>{
 const w=createPcrWork();const start=performance.now();
 await w.run({source:'a.ts',key:'1',background:true,bytesPerSecond:65536},async c=>{await c.charge(8192,'prefix');await c.charge(8192,'index');});
 assert.ok(performance.now()-start>=240);assert.equal(w.status().readBytes,16384);
 const fg=performance.now();await w.run({source:'b.ts',key:'1'},async c=>{await c.charge(1024*1024,'index');});
 assert.ok(performance.now()-fg<500);
});
