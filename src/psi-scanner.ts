import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const TsPacket = require('aribts/lib/packet') as new (b: Buffer) => {decode(): {
  PID: number; continuity_counter: number; payload_unit_start_indicator: number;
  transport_error_indicator: number; transport_scrambling_control: number;
  adaptation_field?: {discontinuity_indicator?: number}; data_byte?: Buffer;
}};

/** Bounded PSI assembly, independent of media delivery. Reuses aribts packet decoding. */
export class SectionAssembler {
  private pending = Buffer.alloc(0);
  private counter: number | null = null;
  private previous: Buffer | null = null;
  readonly stats = {continuityErrors: 0, duplicates: 0, malformed: 0, incomplete: 0};
  reset() {if(this.pending.length)this.stats.incomplete++;this.pending=Buffer.alloc(0);this.counter=null;this.previous=null;}
  feed(packet: Buffer): Buffer[] {
    if(packet.length!==188 || packet[0]!==0x47 || ((packet[3]>>4)&3)===0 ||
      (((packet[3]>>4)&2)!==0 && 5+packet[4]>188)) {this.stats.malformed++;this.reset();return [];}
    const p=new TsPacket(packet).decode();
    if(p.transport_error_indicator || p.transport_scrambling_control){this.stats.malformed++;this.reset();return [];}
    if(p.adaptation_field?.discontinuity_indicator)this.reset();
    if(!p.data_byte?.length)return [];
    if(this.counter!==null){
      if(p.continuity_counter===this.counter && this.previous?.equals(packet)){this.stats.duplicates++;return [];}
      if(p.continuity_counter!==((this.counter+1)&15)){this.stats.continuityErrors++;this.reset();}
    }
    this.counter=p.continuity_counter;this.previous=Buffer.from(packet);
    const sections: Buffer[]=[];
    const append=(data: Buffer, allowNew: boolean)=>{
      if(!this.pending.length&&!allowNew)return;
      let combined=this.pending.length?Buffer.concat([this.pending,data]):data;
      this.pending=Buffer.alloc(0);
      while(combined.length){
        if(combined[0]===255)break;
        if(combined.length<3){this.pending=Buffer.from(combined);break;}
        const length=3+((combined[1]&15)<<8)+combined[2];
        if(length<3 || length>4096){this.stats.malformed++;break;}
        if(combined.length<length){this.pending=Buffer.from(combined);break;}
        sections.push(Buffer.from(combined.subarray(0,length)));combined=combined.subarray(length);
        if(!allowNew)break;
      }
    };
    const data=p.data_byte;
    if(p.payload_unit_start_indicator){
      const pointer=data[0];
      if(pointer+1>data.length){this.stats.malformed++;this.reset();return [];}
      if(this.pending.length)append(data.subarray(1,1+pointer),false);
      if(this.pending.length){this.stats.incomplete++;this.pending=Buffer.alloc(0);}
      append(data.subarray(1+pointer),true);
    }else append(data,false);
    return sections;
  }
  finish(){this.reset();}
}
