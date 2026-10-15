import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {sectionCrc,aribDate,decodeArib} from '../src/arib-metadata.js';
import {SectionAssembler} from '../src/psi-scanner.js';
import {parseEitSection} from '../src/eit-section.js';
import {scanRecordingEit} from '../src/eit-scanner.js';
import {syntheticTs} from './ts-fixture.js';
const base=Date.parse('2026-08-21T20:59:00+09:00');
const bcd=(n:number)=>((Math.floor(n/10)<<4)|(n%10));
function date(ms:number){const d=new Date(ms+9*3600000),b=Buffer.alloc(5);b.writeUInt16BE(Math.floor((ms+9*3600000)/86400000)+40587);b[2]=bcd(d.getUTCHours());b[3]=bcd(d.getUTCMinutes());b[4]=bcd(d.getUTCSeconds());return b;}
function seal(b:Buffer){const out=Buffer.alloc(b.length+4);b.copy(out);const length=out.length-3;out[1]=(out[1]&240)|(length>>8);out[2]=length&255;out.writeUInt32BE(sectionCrc(out.subarray(0,-4)),out.length-4);return out;}
function eit(id=2,role=0,service=1,version=0,offset=60,duration=3240,desc=Buffer.from('4d0c6a706e050e54455354020e58','hex')){
 const b=Buffer.alloc(26+desc.length);b[0]=0x4e;b[1]=0xb0;b.writeUInt16BE(service,3);b[5]=0xc1|(version<<1);b[6]=role;b[7]=1;b.writeUInt16BE(1,8);b.writeUInt16BE(4,10);b[12]=1;b[13]=0x4e;
 b.writeUInt16BE(id,14);date(base+offset*1000).copy(b,16);b[21]=bcd(Math.floor(duration/3600));b[22]=bcd(Math.floor(duration/60)%60);b[23]=bcd(duration%60);b[24]=0x80|(desc.length>>8);b[25]=desc.length&255;desc.copy(b,26);return seal(b);
}
function packets(s:Buffer,pid=0x12,counter=0){const rows:Buffer[]=[];let pos=0;while(pos<s.length){const b=Buffer.alloc(188,255);b[0]=0x47;b[1]=(pid>>8)|(pos===0?0x40:0);b[2]=pid&255;b[3]=0x10|(counter++&15);const start=pos===0?5:4;if(pos===0)b[4]=0;const n=Math.min(s.length-pos,188-start);s.copy(b,start,pos,pos+n);pos+=n;rows.push(b);}return rows;}
function fixture(mode='normal'){
 const b=syntheticTs(33900,10); // 56m30s in a compact low-rate TS, no wall-clock waiting.
 seal(b.subarray(5,17)).copy(b,5);let cc=0;
 for(let n=5;n<33900;n+=100){const t=n/10,id=t<60?1:t<3300?2:3,offset=id===1?-3540:id===2?60:3300,duration=id===1?3600:id===2?3240:1800;
  const event=mode==='following'?eit(2,1):eit(id,0,1,Math.floor(t/60)%32,offset,duration);
  const pkt=packets(event,0x12,cc++);pkt[0].copy(b,n*188);
  if(t<60&&mode==='normal')packets(eit(2,1),0x12,cc++)[0].copy(b,(n+1)*188);
  if(mode==='multiple')packets(eit(8,0,2),0x12,cc++)[0].copy(b,(n+1)*188);
 }
 const tot=Buffer.alloc(10);tot[0]=0x73;tot[1]=0x70;date(base).copy(tot,3);tot[8]=0xf0;tot[9]=0;packets(seal(tot),0x14)[0].copy(b,8*188);
 return b;
}
async function scan(b:Buffer,options:Parameters<typeof scanRecordingEit>[1]={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-eit-'));try{const file=path.join(dir,'fixture.ts');await fs.writeFile(file,b);const before=await fs.stat(file);const r=await scanRecordingEit(file,options);assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs);return r;}finally{await fs.rm(dir,{recursive:true,force:true});}}

test('EIT基本解析: JST、CRC、ARIBタイトル、running、未知descriptor',()=>{
 const d=Buffer.concat([Buffer.from('4d0c6a706e050e54455354020e58','hex'),Buffer.from([0xfe,1,0xab])]);
 const s=eit(2,1,1,3,60,3240,d),r=parseEitSection(s);assert.equal(r.version,3);assert.equal(r.sectionNumber,1);assert.equal(r.events[0].runningStatus,4);assert.equal(r.events[0].startTimeMs,base+60000);assert.equal(r.events[0].durationSeconds,3240);assert.equal(r.events[0].title?.normalize('NFKC'),'TEST');assert.equal(r.events[0].description?.normalize('NFKC'),'X');assert.equal(r.events[0].descriptors[1].dataHex,'ab');assert.equal(sectionCrc(s),0);
 assert.equal(aribDate(Buffer.alloc(5,255)),null);assert.equal(decodeArib(Buffer.from([0x0e,0x41])).text?.normalize('NFKC'),'A');
});
test('PSI再構築: 分割section、途中開始、TS重複、continuity不連続と回復',()=>{
 const unknown=Buffer.concat(Array.from({length:3},()=>Buffer.concat([Buffer.from([0xfe,120]),Buffer.alloc(120)]))),s=eit(2,0,1,0,60,3240,unknown),p=packets(s);
 const a=new SectionAssembler();assert.equal(a.feed(p[1]).length,0);assert.equal(a.feed(p[0]).length,0);assert.equal(a.feed(p[0]).length,0);assert.equal(a.stats.duplicates,1);assert.equal(a.feed(p[1]).length,0);assert.deepEqual(a.feed(p[2])[0],s);
 const broken=new SectionAssembler();broken.feed(p[0]);const lost=Buffer.from(p[1]);lost[3]=0x17;assert.equal(broken.feed(lost).length,0);assert.ok(broken.stats.continuityErrors);const small=eit();assert.deepEqual(broken.feed(packets(small,0x12,8)[0])[0],small);
});
test('PSI pointerが前section終端と次sectionを同一packetに含む',()=>{
 const d=Buffer.concat([Buffer.from([0xfe,170]),Buffer.alloc(170)]),s=eit(2,0,1,0,60,3240,d),p=packets(s),small=eit();const rest=s.subarray(183),b=Buffer.alloc(188,255);b[0]=0x47;b[1]=0x40;b[2]=0x12;b[3]=0x11;b[4]=rest.length;rest.copy(b,5);small.copy(b,5+rest.length);const a=new SectionAssembler();a.feed(p[0]);assert.deepEqual(a.feed(b),[s,small]);
});
test('壊れたCRC・length・descriptorを拒否、TEI・scramblingでpendingを捨てる',()=>{
 const b=eit();b[b.length-1]^=1;assert.throws(()=>parseEitSection(b));assert.throws(()=>parseEitSection(eit(2,0,1,0,60,3240,Buffer.from([0x4d,200,0]))));
 for(const bit of [0x80,0x40]){const a=new SectionAssembler(),p=packets(eit())[0];if(bit===0x80)p[1]|=bit;else p[3]|=bit;assert.equal(a.feed(p).length,0);assert.equal(a.stats.malformed,1);}
});
test('実ファイルスキャン: 前1分/対象54分/後90秒、繰り返し・versionを集約',async()=>{
 const r=await scan(fixture());assert.equal(r.complete,true);assert.equal(r.selection?.primary?.eventId,2);assert.equal(r.selection?.primary?.overlapSeconds,3240);assert.ok(r.selection!.primary!.present.count>300);assert.equal(r.selection?.primary?.following.count,6);assert.equal(r.records.filter(c=>c.eventId===2).length,1);assert.ok(r.records.find(c=>c.eventId===2)!.updates.length>1);assert.equal(r.counters.invalidSections,0);
});
test('followingのみも候補に保持し、録画との重なりで選定',async()=>{const r=await scan(fixture('following'));assert.equal(r.selection?.primary?.eventId,2);assert.equal(r.selection?.primary?.present.count,0);assert.ok(r.selection!.primary!.following.count>300);});
test('複数service: 全候補を保持しPAT対象を選ぶ、明示service・予約優先',async()=>{
 const r=await scan(fixture('multiple'));assert.equal(r.serviceId,1);assert.equal(r.selection?.primary?.serviceId,1);assert.ok(r.records.some(c=>c.serviceId===2));const other=await scan(fixture('multiple'),{serviceId:2,reservation:{serviceId:2,eventId:8}});assert.equal(other.selection?.primary?.eventId,8);assert.equal(other.selection?.reason,'reservation');
});
test('EITなし・不正section: 未確定、同期なしTSは解析エラー',async()=>{
 const no=await scan(syntheticTs(1000));assert.equal(no.counters.eitPackets,0);assert.equal(no.selection?.primary,null);
 const b=syntheticTs(1000),s=eit();s[s.length-1]^=1;packets(s)[0].copy(b,5*188);const bad=await scan(b);assert.ok(bad.counters.invalidSections);assert.equal(bad.selection?.primary,null);await assert.rejects(scan(Buffer.alloc(1000)));
});
test('途中sectionからサンプリング: 実packet位置を維持し完全走査と区別',async()=>{
 const b=fixture(),r=await scan(b,{startByte:1000*188,maxBytes:2000*188,serviceId:1});assert.equal(r.firstPacket,1000);assert.equal(r.complete,false);assert.ok(r.records.every(c=>c.firstPacket>=1000));assert.equal(r.selection?.provisional,true);
});
test('同じeventのdescriptor更新を保持し、section versionだけで候補を増やさない',async()=>{
 const b=fixture(),desc=(text:string)=>{const name=Buffer.concat([Buffer.from([0x0e]),Buffer.from(text)]),payload=Buffer.concat([Buffer.from('jpn'),Buffer.from([name.length]),name,Buffer.from([0])]);return Buffer.concat([Buffer.from([0x4d,payload.length]),payload]);};
 packets(eit(2,0,1,0,60,3240,desc('AAA')),0x12,7)[0].copy(b,605*188);
 packets(eit(2,0,1,1,60,3240,desc('BBB')),0x12,8)[0].copy(b,705*188);
 const r=await scan(b),rows=r.records.filter(c=>c.eventId===2);assert.equal(rows.length,1);assert.ok(rows[0].updates.some(u=>u.event.title?.normalize('NFKC')==='AAA'));assert.ok(rows[0].updates.some(u=>u.event.title?.normalize('NFKC')==='BBB'));
});
test('設定可能なEIT PIDと192バイトTS、PCRなしでは候補だけ保持',async()=>{
 const b=fixture();for(let n=0;n<b.length;n+=188)if(b[n+2]===0x12)b[n+2]=0x26;
 const wrapped=Buffer.alloc(b.length/188*192);for(let n=0;n<b.length/188;n++)b.copy(wrapped,n*192+4,n*188,n*188+188);
 const r=await scan(wrapped,{eitPids:[0x26]});assert.equal(r.packetSize,192);assert.equal(r.selection?.primary?.eventId,2);
 const withoutPcr=fixture();for(let n=0;n<withoutPcr.length;n+=188)if(withoutPcr[n+3]===0x20)withoutPcr[n+5]=0;
 const no=await scan(withoutPcr);assert.equal(no.clockValid,false);assert.equal(no.selection,null);assert.ok(no.records.length);assert.ok(no.records.some(c=>c.present.count>0&&c.present.firstPacket!==undefined&&c.present.firstSeconds===null));
});
test('current_next=0は記録するが主番組判定に混入しない',async()=>{
 const b=syntheticTs(1000),s=eit();s[5]&=0xfe;seal(s.subarray(0,-4)).copy(s);packets(s)[0].copy(b,5*188);
 const r=await scan(b);assert.equal(r.counters.nextSections,1);assert.equal(r.records.length,1);assert.equal(r.records[0].updates[0].current,false);assert.equal(r.selection?.primary,null);
});
