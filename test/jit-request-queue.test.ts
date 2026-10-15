import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {JitRequestQueue} from '../src/jit-request-queue.js';

function response(){const events=new EventEmitter();const r=Object.assign(events,{destroyed:false,destroy(){this.destroyed=true;events.emit('close');return this;}});return r as unknown as ServerResponse;}

test('latest request waits for delayed cleanup; superseded waiters cannot claim or clear its slot',async()=>{
 const q=new JitRequestQueue(),a=q.begin('client',1,'a',response())!;await a.ready();
 const b=q.begin('client',2,'b',response())!,waitingB=assert.rejects(b.ready(),/superseded/);
 const c=q.begin('client',3,'c',response())!;let ready=false;const waitingC=c.ready().then(()=>ready=true);
 await Promise.resolve();assert.equal(ready,false);assert.ok(a.signal.aborted&&b.signal.aborted);
 a.finish();await waitingB;assert.equal(ready,false);b.finish();await waitingC;c.check();
 a.finish();b.finish();c.check(); // stale/idempotent cleanup cannot revoke newer ownership
 const stale=response();assert.equal(q.begin('client',2,'late-b',stale),undefined);assert.ok(stale.destroyed);
 c.finish();assert.equal(stale.listenerCount('close'),0);
 assert.equal(q.begin('client',1,'late-after-completion',response()),undefined);
});

test('disconnect while waiting, stop and independent client do not leak request ownership',async()=>{
 const q=new JitRequestQueue(),a=q.begin('a',1,'a1',response())!;await a.ready();
 const other=q.begin('b',2,'b1',response())!;await other.ready();
 const res=response(),next=q.begin('a',3,'a2',res)!;
 const waiting=assert.rejects(next.ready(),/disconnected/);res.destroy();a.finish();await waiting;
 next.finish();other.check();
 const done=q.stop('b');assert.ok(other.signal.aborted);other.finish();await done;
 const recovered=q.begin('a',4,'a3',response())!;await recovered.ready();recovered.check();recovered.finish();
});
