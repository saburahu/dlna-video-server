import test from 'node:test';import assert from 'node:assert/strict';
import {mpeg2JitProfile,isMpeg2JitTarget,mpeg2JitArguments,mpeg2Seek,MPEG2_BLOCK_PACKETS} from '../src/mpeg2-jit-target.js';
import {jitRecipeFingerprint} from '../src/jit-client-trial.js';
test('MPEG-2 receiver recipe is an explicit distinct target and bounded Content Packet with no file output',()=>{
 const p=mpeg2JitProfile();assert.ok(isMpeg2JitTarget(p));assert.equal(p.transport.value.profileName,'MPEG_TS_JP_T');assert.equal(MPEG2_BLOCK_PACKETS*192,799872);const a=mpeg2JitArguments('arbitrary.mp4',40);assert.equal(a.at(-1),'pipe:1');assert.ok(a.includes('mpeg2video'));assert.equal(a[a.indexOf('-bf')+1],'2');assert.equal(a[a.indexOf('-streamid')+1],'0:320');assert.ok(a[a.indexOf('-vf')+1].includes('fps=30000/1001'));assert.ok(!a.includes('libx264'));assert.throws(()=>mpeg2JitArguments('x',0));const q=structuredClone(p);q.video.value.codedWidth=1920;assert.ok(!isMpeg2JitTarget(q));assert.notEqual(jitRecipeFingerprint(p),jitRecipeFingerprint(q));
});
test('MPEG-2 seek uses a global CFR tick grid without AVC greedy checkpoint state',()=>{
 const seek=mpeg2Seek(37);assert.equal(seek.firstVideoTicks%3003,0);assert.ok(seek.firstVideoTicks>=37*90000&&seek.firstVideoTicks<37*90000+3003);const a=mpeg2JitArguments('arbitrary.mkv',40,{},seek);assert.equal(a[a.indexOf('-ss')+1],String(seek.firstVideoTicks/90000));assert.equal(a[a.indexOf('-output_ts_offset')+1],String(seek.firstVideoTicks/90000+3003/90000));assert.equal(a[a.indexOf('-t')+1],String(40-seek.firstVideoTicks/90000));
});

test('legacy audio reconciliation applies only the requested audio filter and preserves every other accepted MPEG-2 setting',()=>{
 const original=mpeg2JitArguments('source.avi',8),reconciled=mpeg2JitArguments('source.avi',8,{reconcileAudioTimeline:true});const index=original.indexOf('-af')+1;assert.match(reconciled[index],/^aresample=48000:async=1,/);assert.doesNotMatch(original[index],/async=/);reconciled[index]=original[index];assert.deepEqual(reconciled,original);
});
test('WMA packet-dependent seeks decode from a validated source anchor and trim both tracks to the global target time',()=>{
 const seek={...mpeg2Seek(45.0235),anchor:{pts:0,index:0},preRollSeconds:45.045};
 const a=mpeg2JitArguments('source.asf',46.0235,{sourceAudioCodec:'wmav2',reconcileAudioTimeline:true},seek);
 assert.ok(a.includes('-copyts'));assert.equal(a[a.indexOf('-ss')+1],'0');
 for(const option of ['-vf','-af'])assert.match(a[a.indexOf(option)+1],/trim=start=45\.045/);
 assert.equal(a[a.indexOf('-output_ts_offset')+1],String(seek.firstVideoTicks/90000+3003/90000));
 const original=mpeg2JitArguments('source.mp4',46.0235,{},seek),aac=mpeg2JitArguments('source.mp4',46.0235,{sourceAudioCodec:'aac'},seek);assert.deepEqual(aac,original);
});
