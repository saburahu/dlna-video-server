import test from'node:test';import assert from'node:assert/strict';import{createJitServer}from'../src/jit-server.js';
test('distribution rejects research clock injection before source access or a listener starts',async()=>{
 for(const key of['wmaProClockTrial','wmaProIndexedClockTrial'])await assert.rejects(createJitServer({} as any,{[key]:{enabled:true}} as any),/Research PCM clocks are excluded/);
});
