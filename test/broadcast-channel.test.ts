import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {parseNit,broadcastChannel} from '../src/recording-si.js';import {sectionCrc} from '../src/arib-metadata.js';import {RecordingMetadataCache,validMetadata,type RecordingMetadata} from '../src/recording-metadata.js';import {scanRecordingEit} from '../src/eit-scanner.js';import {browseDIDL} from '../src/upnp.js';import {profiles} from '../src/core.js';import {nit,fixture} from './broadcast-fixture.js';
const service=(serviceId:number,transportStreamId:number,originalNetworkId:number)=>({serviceId,transportStreamId,originalNetworkId,name:'S & <TV>',textSuspect:false});
const reseal=(b:Buffer)=>{b.writeUInt32BE(sectionCrc(b.subarray(0,-4)),b.length-4);return b;};
test('NIT actual/current, CRC, bounded loops and remote key/service membership',()=>{
 const rows=parseNit(nit(1048,32739,32739,6));assert.equal(rows[0].delivery,'terrestrial');assert.equal(rows[0].remoteControlKeyId,6);assert.deepEqual(rows[0].remoteServices,[1048]);
 const other=nit();other[0]=0x41;assert.deepEqual(parseNit(other),[]);const next=nit();next[5]&=254;assert.deepEqual(parseNit(next),[]);
 const bad=nit();bad[14]^=1;assert.throws(()=>parseNit(bad));const malformed=nit();malformed[17]=255;assert.throws(()=>parseNit(reseal(malformed)));
});
test('terrestrial channel encoding follows SID service bits, NIT default key and branch zero, not station names',()=>{
 for(const [sid,tsid,key,want]of [[1048,32739,6,60610],[23608,32391,9,90910],[1072,32742,7,70710],[1049,32739,6,60620]]){
  const channel=broadcastChannel(service(sid,tsid,tsid),parseNit(nit(sid,tsid,tsid,key)));assert.deepEqual(channel,{version:1,state:'identified',objectType:'ARIB_TB',channelNr:want});
 }
 const s=service(1048,32739,32739),n=parseNit(nit(1048,32739,32739,6));n[0].remoteServices=[];assert.equal(broadcastChannel(s,n).channelNr,undefined);n[0].remoteServices=[1048];n[0].remoteControlKeyId=13;assert.equal(broadcastChannel(s,n).channelNr,undefined);
 assert.equal(broadcastChannel(service(1048|(1<<7),32739,32739),parseNit(nit(1048|(1<<7),32739,32739,6))).state,'unavailable');
});
test('satellite uses the NIT service number and zero for unassigned one-touch presets; CS and unknown systems stay distinct',()=>{
 for(const [id,onid,type,nr]of [[141,4,'ARIB_BS',1410],[211,4,'ARIB_BS',2110],[301,6,'ARIB_CS',3010]] as const){assert.deepEqual(broadcastChannel(service(id,1,onid as number),parseNit(nit(id as number,1,onid as number))),{version:1,state:'identified',objectType:type,channelNr:nr});}
 assert.equal(broadcastChannel(service(141,1,99),parseNit(nit(141,1,99))).state,'unavailable');
});
test('missing, conflicting or wrong TS/ONID/SID/service type cannot supply channel claims',()=>{
 const s=service(1048,32739,32739),n=parseNit(nit(1048,32739,32739,6));assert.equal(broadcastChannel(s,[]).state,'unavailable');
 for(const key of ['networkId','transportStreamId','originalNetworkId']as const){const b=structuredClone(n);b[0][key]++;assert.equal(broadcastChannel(s,b).state,'unavailable');}
 const b=structuredClone(n);b[0].remoteControlKeyId=7;assert.equal(broadcastChannel(s,[...n,...b]).state,'unavailable');b[0].services[0].serviceType=192;assert.equal(broadcastChannel(s,b).state,'unavailable');
 b[0].services[0].serviceId++;assert.equal(broadcastChannel(s,b).state,'unavailable');
});
test('validated channel fields appear in normal metadata/direct Browse with a self-contained ARIB namespace; no REGZA IDs or URL changes',()=>{
 const metadata:RecordingMetadata={state:'confirmed',method:'full-clock-overlap',serviceId:1048,eventId:1,startTime:'2026-01-01T00:00:00Z',durationSeconds:1800,channelInfo:broadcastChannel(service(1048,32739,32739),parseNit(nit(1048,32739,32739,6)))};
 const p={id:'generic',filePath:'generic.ts',title:'source',size:188,modified:'2026-01-01T00:00:00Z',duration:1800,published:true,analysis:'ok' as const,station:'S & <TV>',metadata};
 const get=(metadata:RecordingMetadata,id='item:generic',direct=false)=>browseDIDL(id,0,200,[{...p,metadata}],'http://test',profiles.standard,!direct).didl;
 for(const xml of [get(metadata),get(metadata,'all',true)]){assert.match(xml,/xmlns:arib="urn:schemas-arib-or-jp:elements-1-0\/"/);assert.match(xml,/<arib:objectType>ARIB_TB<\/arib:objectType>/);assert.match(xml,/<upnp:channelNr>60610<\/upnp:channelNr>/);assert.match(xml,/<upnp:channelName>S &amp; &lt;TV&gt;<\/upnp:channelName>/);assert.doesNotMatch(xml,/regza:|network_id|service_id/);}
 assert.equal(get(metadata).match(/<res\b[\s\S]*?<\/res>/)?.[0],get({...metadata,channelInfo:undefined}).match(/<res\b[\s\S]*?<\/res>/)?.[0]);
 assert(!validMetadata({...metadata,channelInfo:{version:1,state:'identified',objectType:'fake',channelNr:60610}}));assert(!get({...metadata,channelInfo:{version:1,state:'identified',objectType:'fake' as any}}).includes('arib:objectType'));
 assert(!get({...metadata,state:'uncertain'}).includes('arib:objectType'));assert(!validMetadata({...metadata,channelInfo:{version:1,state:'identified',objectType:'ARIB_TB',channelNr:NaN}}));
});
test('old schema2 gains channel info by one bounded prefix while preserving EIT and the already verified recording origin',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'channel-cache-')),source=path.join(root,'media','source.ts'),directory=path.join(root,'cache');await fs.mkdir(path.dirname(source));await fs.writeFile(source,fixture());await fs.utimes(source,new Date(0),new Date(0));t.after(()=>fs.rm(root,{recursive:true,force:true}));let calls=0;
 const c=new RecordingMetadataCache(directory,async(file,options)=>{calls++;const s=await scanRecordingEit(file);if(options?.maxBytes){assert.equal(options.maxBytes,64*1024**2);s.complete=false;for(const r of s.records)for(const u of r.updates)u.event.title='partial event must not replace full EIT';}return s;});
 const original=(await c.analyze(source)).metadata,file=path.join(directory,(await fs.readdir(directory))[0]),row=JSON.parse(await fs.readFile(file,'utf8'));delete row.metadata.channelInfo;row.sha256=createHash('sha256').update(JSON.stringify(row.metadata)).digest('hex');await fs.writeFile(file,JSON.stringify(row));
 const result=await c.analyze(source);assert.equal(calls,2);assert.equal(result.cached,false);assert.deepEqual(result.metadata.channelInfo,{version:1,state:'identified',objectType:'ARIB_BS',channelNr:10});assert.deepEqual(result.metadata.recordingOrigin,original.recordingOrigin);assert.equal(result.metadata.title,original.title);assert.equal(result.metadata.startTime,original.startTime);assert.equal((await c.analyze(source)).cached,true);assert.equal(calls,2);
});
