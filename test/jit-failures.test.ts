import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeJitFailures} from '../src/jit-failures.js';
test('Server failures correlate requests/source without counting stop, replacement or finite EOF as failure',()=>{
 const common={at:'2026-10-10T00:00:00Z',trialId:'trial'};
 const report=summarizeJitFailures([
  {...common,category:'JIT_DECISION',detail:{sourceFingerprint:{path:'source',size:42}}},
  {...common,category:'HTTP_REQUEST',detail:{requestId:'r',headers:{'timeseekrange.dlna.org':'npt=37-'}}},
  {...common,category:'ERROR',detail:{requestId:'r',error:'Packet timeline not one ordered picture/AU',phase:'request-preparation'}},
  {...common,category:'JIT_END',detail:{cancelled:true,completed:false,error:'client disconnected'}},
  {...common,category:'EXECUTOR_EXIT',detail:{code:255}},
  {...common,category:'JIT_END',detail:{completed:true,startupReason:'validated-segment-end'}},
 ]);
 assert.equal(report.failures.length,1);assert.equal(report.cancelled,1);assert.equal(report.completed,1);
 assert.equal(report.failures[0].kind,'source-timestamp-checkpoint');assert.equal(report.failures[0].headers['timeseekrange.dlna.org'],'npt=37-');assert.deepEqual(report.failures[0].sourceFingerprint,{path:'source',size:42});
});

test('A legacy error without request identity cannot pick a source from a multi-source trial',()=>{
 const common={at:'now',trialId:'shared'};
 const r=summarizeJitFailures([{...common,category:'JIT_DECISION',detail:{sourceFingerprint:{path:'a'}}},{...common,category:'JIT_DECISION',detail:{sourceFingerprint:{path:'b'}}},{...common,category:'ERROR',detail:{error:'unknown'}}]);
 assert.equal(r.failures[0].sourceFingerprint,undefined);assert.equal(r.failures[0].correlation,'unresolved');
});
