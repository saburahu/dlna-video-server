import test from 'node:test';
import assert from 'node:assert/strict';
import type {PcrIndex} from '../src/core.js';
import {packetTime,timeSeekSlice} from '../src/time-seek.js';

test('Recording seek maps PCR NPT to whole Content Packets beyond 32-bit wire offsets',()=>{
 const count=24_000_003,ticksPerPacket=2700,origin=(2**33)*300-5400;
 const index:PcrIndex={pid:256,packetCount:count,firstPacket:100,lastPacket:count-50,durationSeconds:(count-150)/10000,averageBitrate:15_040_000,discontinuities:0,invalidIntervals:0,
  points:[100,count-50].map(packet=>({packet,pcr:(origin+packet*ticksPerPacket)%((2**33)*300),unwrappedPcr:origin+packet*ticksPerPacket,discontinuityBefore:false}))};
 const block=192*5000,wireSize=count*192+Math.ceil(count/5000)*14;
 for(const header of ['npt=0-0.5','npt=35.24-36.24','npt=1200-1201',`npt=${count/10000-.1}-`]){
  const s=timeSeekSlice(index,block,header);
  assert.equal(s.firstPacket%5000,0);
  assert.equal(s.startByte,s.firstPacket*192+s.firstPacket/5000*14);
  assert.equal(s.payloadBytes,(s.endPacket-s.firstPacket)*192);
  assert.equal(s.wireBytes,s.payloadBytes+Math.ceil(s.payloadBytes/block)*14);
  assert.ok(s.actualStart<=s.requested.start);assert.ok(s.actualEnd>=s.requested.end);
  assert.ok(s.startByte+s.wireBytes<=wireSize);
  if(header.endsWith('-')){assert.ok(s.startByte>2**32);assert.equal(s.startByte+s.wireBytes,wireSize);assert.equal(s.endPacket,count);}
 }
 assert.ok(Math.abs(packetTime(index,count)-count/10000)<1e-9);
});
test('Recording seek rejects uncertain PCR clocks instead of fabricating NPT duration',()=>{
 const index:PcrIndex={pid:256,packetCount:100,firstPacket:0,lastPacket:99,durationSeconds:.99,averageBitrate:150400,discontinuities:0,invalidIntervals:0,
  points:[0,99].map(packet=>({packet,pcr:packet*270000,unwrappedPcr:packet*270000,discontinuityBefore:false}))};
 for(const changed of [{discontinuities:1},{invalidIntervals:1},{points:[]}]){
  assert.throws(()=>packetTime({...index,...changed},100),/Continuous PCR/);
  assert.throws(()=>timeSeekSlice({...index,...changed},1920,'npt=0-0.5'),/Continuous PCR/);
 }
 assert.throws(()=>timeSeekSlice(index,1920,'npt=1-'),/Unsatisfiable/);
});
