import {test} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import type {IncomingMessage,ServerResponse} from 'node:http';
import {observeExperimentalDrain} from '../src/experimental-drain-observer.js';
test('event-only diagnostics correlate drain and terminal event without altering writes or headers',()=>{
  const r=Object.assign(new EventEmitter(),{writableLength:123,writableNeedDrain:false,write:()=>false}),write=r.write,events:any[]=[];
  observeExperimentalDrain({method:'GET',url:'/media/sampleA.tts',socket:{remoteAddress:'test'}} as IncomingMessage,r as unknown as ServerResponse,'trial',(category,message,detail)=>events.push({category,message,detail}));
  r.emit('drain');r.emit('drain');r.emit('finish');r.emit('close');r.emit('drain');assert.equal(r.write,write);assert.equal(events.length,3);assert.equal(events[2].detail.drainEvents,2);assert.equal(events[2].detail.trialId,'trial');assert.equal(events[2].detail.event,'finish');
});
test('HEAD is not treated as a streamed body and close is recorded once',()=>{
  const r=new EventEmitter(),events:any[]=[];
  observeExperimentalDrain({method:'HEAD',url:'/media/sampleA.tts'} as IncomingMessage,r as ServerResponse,'t',(...a)=>events.push(a));r.emit('drain');assert.equal(events.length,0);
  observeExperimentalDrain({method:'GET',url:'/media/sampleA.tts',socket:{}} as IncomingMessage,r as ServerResponse,'t',(...a)=>events.push(a));r.emit('close');r.emit('finish');assert.equal(events.length,1);
});
