import assert from 'node:assert/strict';
import {syntheticTs} from './ts-fixture.js';
import {sectionCrc} from '../src/arib-metadata.js';
export const base=Date.UTC(2026,0,1),bcd=(n:number)=>((Math.floor(n/10)<<4)|(n%10));
function date(ms:number){const d=new Date(ms+9*3600000),b=Buffer.alloc(5);b.writeUInt16BE(Math.floor((ms+9*3600000)/86400000)+40587);b[2]=bcd(d.getUTCHours());b[3]=bcd(d.getUTCMinutes());b[4]=bcd(d.getUTCSeconds());return b;}
function seal(b:Buffer){const s=Buffer.concat([b,Buffer.alloc(4)]);s[1]=(s[1]&240)|((s.length-3)>>8);s[2]=(s.length-3)&255;s.writeUInt32BE(sectionCrc(s.subarray(0,-4)),s.length-4);return s;}
function packet(s:Buffer,pid:number,cc=0){assert(s.length<=183);const p=Buffer.alloc(188,255);p[0]=0x47;p[1]=(pid>>8)|0x40;p[2]=pid&255;p[3]=0x10|(cc&15);p[4]=0;s.copy(p,5);return p;}
export function sdt(name='STATION & <HD>',sid=1,tsid=1,onid=4){const text=Buffer.concat([Buffer.from([0x0e]),Buffer.from(name)]),descriptor=Buffer.concat([Buffer.from([0x48,text.length+3,1,0,text.length]),text]),s=Buffer.alloc(16);s[0]=0x42;s[1]=0xb0;s.writeUInt16BE(tsid,3);s[5]=0xc1;s.writeUInt16BE(onid,8);s[10]=255;s.writeUInt16BE(sid,11);s[14]=0x80;s[15]=descriptor.length;return seal(Buffer.concat([s,descriptor]));}
export function fixture(){const b=syntheticTs(600,10);seal(b.subarray(5,17)).copy(b,5);
 for(let n=5;n<600;n+=100){packet(sdt(),0x11,n/100|0).copy(b,n*188);
  const title=Buffer.from([0x4d,8,0x6a,0x70,0x6e,3,0x0e,0x54,0x56,0]),s=Buffer.alloc(26);s[0]=0x4e;s[1]=0xb0;s.writeUInt16BE(1,3);s[5]=0xc1;s.writeUInt16BE(1,8);s.writeUInt16BE(4,10);s.writeUInt16BE(9,14);date(base+10000).copy(s,16);s[23]=0x40;s[25]=title.length;packet(seal(Buffer.concat([s,title])),0x12,n/100|0).copy(b,(n+1)*188);
 }
 for(const [i,n]of [10,210,410,590].entries()){const s=Buffer.alloc(10);s[0]=0x73;s[1]=0x70;date(base+n*100).copy(s,3);s[8]=0xf0;packet(seal(s),0x14,i).copy(b,n*188);}return b;
}
