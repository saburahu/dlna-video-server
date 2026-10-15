import test from 'node:test';import assert from 'node:assert/strict';
import {splitTsPcr,splitPcrPackets,PcrPidSplitter} from '../src/split-ts-pcr.js';import {tsPackets} from '../src/jit-stream.js';import {readPcr} from '../src/core.js';import {sectionCrc} from '../src/arib-metadata.js';
function fixture(){
 const pmt=Buffer.alloc(188,255);pmt.set([0x47,0x41,1,0x10,0]);
 const s=Buffer.from([2,0xb0,0x17,0,141,0xc1,0,0,0xe1,0x40,0xf0,0,2,0xe1,0x40,0xf0,0,15,0xe1,0x41,0xf0,0,0,0,0,0]);s.writeUInt32BE(sectionCrc(s.subarray(0,-4)),s.length-4);s.copy(pmt,5);
 const video=Buffer.alloc(188,42);video.set([0x47,0x41,0x40,0x30,7,0x50,0,0,0,0,0x7e,0]);
 return {pmt,video,bytes:Buffer.concat([pmt,video])};
}
test('PCR split preserves PES payload/CC/RAI/PCR value, updates only PMT PCR PID/version/CRC and adds adaptation-only packet',()=>{
 const f=fixture(),r=splitTsPcr(f.bytes,257,320,256);assert.equal(r.clocks,1);assert.equal(r.pmts,1);assert.equal(r.bytes.length,f.bytes.length+188);
 const section=r.bytes.subarray(5,31);assert.equal(sectionCrc(section),0);assert.equal(section[9],0);assert.equal((section[5]>>1)&31,1);assert.deepEqual(section.subarray(12,-4),f.pmt.subarray(17,27));
 const pcr=r.bytes.subarray(188,376),v=r.bytes.subarray(376);assert.equal(readPcr(pcr,0),readPcr(f.video,0));assert.equal(readPcr(v,0),null);assert.equal(pcr[3],0x20);assert.equal(pcr[4],183);assert.equal(v[5],0x40);assert.equal(v[3],f.video[3]);assert.deepEqual(v.subarray(12),f.video.subarray(12));assert.deepEqual(v.subarray(6,12),Buffer.alloc(6,255));
});
test('PCR split rejects collisions, invalid CRC, partial PMT and malformed TS',()=>{
 const f=fixture();assert.throws(()=>splitTsPcr(f.bytes,257,320,320));assert.throws(()=>splitTsPcr(f.bytes.subarray(1),257,320,256));
 const bad=Buffer.from(f.bytes);bad[10]^=1;assert.throws(()=>splitTsPcr(bad,257,320,256));
 const collision=Buffer.from(f.video);collision[1]=0x41;collision[2]=0;assert.throws(()=>splitTsPcr(Buffer.concat([f.bytes,collision]),257,320,256));
 const partial=Buffer.from(f.bytes);partial[1]&=~0x40;assert.throws(()=>splitTsPcr(partial,257,320,256));
});
test('incremental PCR split is byte-exact with bounded transform for arbitrary pipe chunks',async()=>{
 const f=fixture(),expected=splitTsPcr(f.bytes,257,320,256).bytes;
 for(const n of [1,187,188,189,377]){async function* chunks(){for(let p=0;p<f.bytes.length;p+=n)yield f.bytes.subarray(p,p+n);}const output=[];for await(const p of splitPcrPackets(tsPackets(chunks()),257,320,256))output.push(p);assert.deepEqual(Buffer.concat(output),expected);}
 const s=new PcrPidSplitter(257,320,256);assert.throws(()=>s.finish());assert.throws(()=>s.push(Buffer.alloc(187)));
});
