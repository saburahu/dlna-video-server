import {createReadStream,promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {inspectTs} from './core.js';
import {buildPcrIndex} from './pcr-index.js';
import {packetTime} from './time-seek.js';
import {SectionAssembler} from './psi-scanner.js';
import {parseEitSection,EitEvent} from './eit-section.js';
import {aribDate,sectionCrc} from './arib-metadata.js';
import {EitObservation,ReservationEvent,selectRecordingEvent} from './recording-event.js';
import {pcrWork,PcrDeferred,type PcrWorkControl} from './pcr-work.js';
import type {PcrIndex} from './core.js';
import {parseSdt,recordingRange,type BroadcastService,type TimeAnchor} from './recording-si.js';

export interface EitScanOptions {
  serviceId?: number; reservation?: ReservationEvent;
  /** Explicit prefix diagnostics only, never mistaken for a full scan. */
  maxBytes?: number; startByte?: number; eitPids?: number[]; maxObservations?: number;
  background?:boolean;bytesPerSecond?:number;
}
export async function scanRecordingEit(filePath: string, options: EitScanOptions = {}) {
  if(!options.background)return scan(filePath,options);
  const st=await fs.stat(filePath),index=await buildPcrIndex(filePath,{background:true,bytesPerSecond:options.bytesPerSecond});
  return pcrWork.run({source:filePath,key:`eit:${st.size}:${st.mtimeMs}`,background:true,yieldToMedia:true,bytesPerSecond:options.bytesPerSecond},control=>scan(filePath,options,control,index,st));
}
async function scan(filePath:string,options:EitScanOptions,control?:PcrWorkControl,preparedIndex?:PcrIndex|null,preparedSource?:{size:number;mtimeMs:number}){
  const before=await fs.stat(filePath),started=performance.now();
  if(preparedSource&&(before.size!==preparedSource.size||before.mtimeMs!==preparedSource.mtimeMs))throw new PcrDeferred('source-changed');
  control?.check();
  const handle=await fs.open(filePath,'r');let initial:Buffer;
  try{initial=Buffer.alloc(Math.min(before.size,8*1024*1024));let filled=0;while(filled<initial.length){control?.check();const r=await handle.read(initial,filled,Math.min(initial.length-filled,control?256*1024:initial.length),filled);if(!r.bytesRead)break;filled+=r.bytesRead;await control?.charge(r.bytesRead,'metadata-prefix');}initial=initial.subarray(0,filled);}finally{await handle.close();}
  const inspection=inspectTs(initial);
  if(!inspection.packetSize || inspection.syncOffset===null)throw new Error('No supported TS packet sync');
  const indexStarted=performance.now(),index=preparedIndex===undefined?await buildPcrIndex(filePath):preparedIndex,indexMs=performance.now()-indexStarted;
  const clockValid=!!index && !index.discontinuities && !index.invalidIntervals;
  const seconds=(packet:number)=>clockValid?packetTime(index!,packet):null;
  const observations:EitObservation[]=[],anchors:{packet:number;startTimeMs:number}[]=[];
  const timeAnchors:TimeAnchor[]=[],services=new Map<string,BroadcastService>();
  const records=new Map<string,{
    serviceId:number;eventId:number;transportStreamId:number;originalNetworkId:number;startTimeMs:number|null;
    count:number;firstPacket:number;lastPacket:number;firstSeconds:number|null;lastSeconds:number|null;
    present:{count:number;firstPacket?:number;lastPacket?:number;firstSeconds?:number|null;lastSeconds?:number|null};
    following:{count:number;firstPacket?:number;lastPacket?:number;firstSeconds?:number|null;lastSeconds?:number|null};
    updates:{version:number;tableId:number;sectionNumber:number;current:boolean;packet:number;event:EitEvent}[];
  }>();
  const pat=new Map<number,number>(),pids=options.eitPids??[0x12];
  if(pids.some(p=>!Number.isInteger(p)||p<0||p>8191))throw new Error('Invalid EIT PID');
  if(options.maxBytes!==undefined&&(!Number.isFinite(options.maxBytes)||options.maxBytes<=0))throw new Error('Invalid scan limit');
  if(options.startByte!==undefined&&(!Number.isFinite(options.startByte)||options.startByte<0||options.startByte>=before.size))throw new Error('Invalid scan start');
  if(options.serviceId!==undefined&&(!Number.isInteger(options.serviceId)||options.serviceId<0||options.serviceId>65535))throw new Error('Invalid service ID');
  const assemblers=new Map([...new Set([0,0x11,0x14,...pids])].map(p=>[p,new SectionAssembler()]));
  const counters={eitPackets:0,eitSections:0,invalidSections:0,syncErrors:0,tableIds:{} as Record<string,number>,unclassifiedPfSections:0,nextSections:0};
  let patTsid:number|undefined,updateCount=0,scopeConsistent=true;
  const fingerprints=new Map<string,string>();
  const accept=(pid:number,s:Buffer,packet:number)=>{
    try{
      if(pid===0 && s[0]===0){
        if(s.length<12 || sectionCrc(s)!==0 || !(s[5]&1))return;
        const tsid=s.readUInt16BE(3);if(patTsid!==undefined&&patTsid!==tsid)scopeConsistent=false;patTsid=tsid;
        for(let n=8;n<s.length-4;n+=4){if(n+4>s.length-4)throw new Error('Malformed PAT');const id=s.readUInt16BE(n);if(id)pat.set(id,((s[n+2]&31)<<8)+s[n+3]);}
      }else if(pid===0x11){
        for(const service of parseSdt(s)){if(services.size>=4096)throw Error('SDT service limit exceeded');services.set(JSON.stringify(service),service);}
      }else if(pid===0x14&&s[0]===0x73){
        if(s.length<14 || sectionCrc(s)!==0)throw new Error('Invalid TOT');
        const time=aribDate(s.subarray(3,8)),t=seconds(packet);if(time!==null&&t!==null){if(anchors.length>=20000)throw Error('Time anchor limit exceeded');anchors.push({packet,startTimeMs:time-t*1000});timeAnchors.push({packet,seconds:t,timeMs:time});}
      }else if(pids.includes(pid)){
        counters.tableIds[s[0]]=1+(counters.tableIds[s[0]]??0);
        if(s[0]!==0x4e&&s[0]!==0x4f)return; // schedule counted, not substituted for p/f
        const table=parseEitSection(s);counters.eitSections++;if(!table.current)counters.nextSections++;
        const role=table.sectionNumber===0?'present':table.sectionNumber===1?'following':null;
        if(!role)counters.unclassifiedPfSections++;
        for(const event of table.events){
          const key=JSON.stringify([table.originalNetworkId,table.transportStreamId,table.serviceId,event.eventId,event.startTimeMs]);
          let record=records.get(key);const t=seconds(packet);
          if(!record){if(records.size>=10000)throw new Error('EIT event limit exceeded');record={serviceId:table.serviceId,eventId:event.eventId,transportStreamId:table.transportStreamId,originalNetworkId:table.originalNetworkId,
            startTimeMs:event.startTimeMs,count:0,firstPacket:packet,lastPacket:packet,firstSeconds:t,lastSeconds:t,present:{count:0},following:{count:0},updates:[]};records.set(key,record);}
          record.count++;record.lastPacket=packet;record.lastSeconds=t;
          if(role){const observed=record[role];if(!observed.count){observed.firstPacket=packet;observed.firstSeconds=t;}observed.count++;observed.lastPacket=packet;observed.lastSeconds=t;}
          const fingerprint=createHash('sha256').update(JSON.stringify([table.version,table.tableId,table.sectionNumber,table.current,event])).digest('hex');
          const stateKey=key+':'+table.tableId+':'+table.sectionNumber+':'+table.current;
          if(fingerprints.get(stateKey)!==fingerprint){
            if(record.updates.length>=256 || ++updateCount>10000)throw new Error('Event update limit exceeded');
            record.updates.push({version:table.version,tableId:table.tableId,sectionNumber:table.sectionNumber,current:table.current,packet,event});fingerprints.set(stateKey,fingerprint);
          }
          if(role && table.current && table.tableId===0x4e && t!==null){
            if(observations.length>=(options.maxObservations??500000))throw new Error('EIT observation limit exceeded');
            observations.push({serviceId:table.serviceId,eventId:event.eventId,transportStreamId:table.transportStreamId,originalNetworkId:table.originalNetworkId,
              startTimeMs:event.startTimeMs,durationSeconds:event.durationSeconds,role,recordingSeconds:Math.max(0,t)});
          }
        }
      }
    }catch(e){
      if(String(e).includes('limit exceeded'))throw e;
      counters.invalidSections++;
    }
  };
  const size=inspection.packetSize,sync=inspection.syncOffset,packetStart=Math.max(0,sync-(size===192?4:0)),prefix=sync-packetStart;
  const scanStart=packetStart+Math.floor((options.startByte??0)/size)*size;
  const limit=Math.min(before.size,scanStart+(options.maxBytes??before.size));
  const firstPacket=Math.floor((scanStart-packetStart)/size);
  let pending:Buffer=Buffer.alloc(0),packet=firstPacket,readBytes=0;
  for await(const chunk of createReadStream(filePath,{start:scanStart,end:limit-1,highWaterMark:control?256*1024:4*1024*1024,signal:control?.signal})){
    control?.check();
    readBytes+=chunk.length;const data=pending.length?Buffer.concat([pending,chunk]):chunk as Buffer;let pos=0;
    for(;pos+size<=data.length;pos+=size,packet++){
      const b=data.subarray(pos+prefix,pos+prefix+188);
      if(b[0]!==0x47){counters.syncErrors++;for(const a of assemblers.values())a.reset();continue;}
      const pid=((b[1]&31)<<8)+b[2],assembler=assemblers.get(pid);
      if(assembler){if(pids.includes(pid))counters.eitPackets++;for(const s of assembler.feed(b))accept(pid,s,packet);}
    }
    pending=Buffer.from(data.subarray(pos));
    await control?.charge(chunk.length,'metadata-si');
  }
  for(const a of assemblers.values())a.finish();
  const duration=clockValid?packetTime(index!,index!.packetCount):null;
  const offsets=anchors.map(a=>a.startTimeMs).sort((a,b)=>a-b),spread=offsets.length?offsets.at(-1)!-offsets[0]:null;
  const recordingStartTimeMs=offsets.length && spread!<2000?offsets[Math.floor(offsets.length/2)]:undefined;
  for(const o of observations)if(recordingStartTimeMs!==undefined)o.observedTimeMs=recordingStartTimeMs+o.recordingSeconds*1000;
  const serviceId=options.serviceId??options.reservation?.serviceId??(pat.size===1?[...pat.keys()][0]:undefined);
  const selection=duration===null?null:selectRecordingEvent(observations,{durationSeconds:duration,startTimeMs:recordingStartTimeMs,serviceId,transportStreamId:patTsid},options.reservation);
  const complete=firstPacket===0&&limit===before.size;
  const range=recordingRange(timeAnchors,complete&&scopeConsistent&&pat.size===1?duration:null,Math.max(index?.discontinuities??0,index?.invalidIntervals??0));
  if(selection && (!complete || recordingStartTimeMs===undefined))selection.provisional=true;
  const after=await fs.stat(filePath);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Recording changed during EIT scan');
  return {complete,readBytes,packetCount:packet-firstPacket,firstPacket,endPacket:packet,packetSize:size,trailingBytes:pending.length,
    elapsedMs:performance.now()-started,indexMs,clockValid,durationSeconds:duration,recordingStartTimeMs:recordingStartTimeMs??null,
    timeAnchorCount:anchors.length,timeAnchorSpreadMs:spread,serviceId:serviceId??null,patServices:[...pat.keys()],
    transportStreamId:patTsid,scopeConsistent,services:[...services.values()],recordingRange:range,
    counters,assembly:Object.fromEntries([...assemblers].map(([p,a])=>[p,a.stats])),records:[...records.values()],selection};
}
