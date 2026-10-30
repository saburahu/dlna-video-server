import test from 'node:test';import assert from 'node:assert/strict';
import {recordingDidlTrial,recordingDidlTrialAccess,regzaRecordingIdentity} from '../src/recording-didl-trial.js';
import {escapeXml} from '../src/core.js';
const item=(cls='object.item.videoItem.videoBroadcast',id='item:opaque')=>`<item id="${id}" parentID="all" restricted="1"><dc:title>A &amp; B</dc:title><upnp:class>${cls}</upnp:class><dc:date>2026-10-25T21:44:49.692+09:00</dc:date><upnp:scheduledStartTime>2026-10-25T21:45:00.000+09:00</upnp:scheduledStartTime><upnp:scheduledEndTime>2026-10-25T22:39:00.000+09:00</upnp:scheduledEndTime><arib:objectType>ARIB_TB</arib:objectType><upnp:channelName>TEST</upnp:channelName><upnp:channelNr>60610</upnp:channelNr><res protocolInfo="http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=MPEG_TS_JP_T" size="5920621562" duration="00:54:20.332">http://server/media/opaque</res></item>`;
const soap=(didl:string)=>`<Result>${escapeXml('<DIDL-Lite>'+didl+'</DIDL-Lite>')}</Result><NumberReturned>1</NumberReturned><TotalMatches>1</TotalMatches><UpdateID>100</UpdateID>`;
test('A/B/C/D alter only intended recording presentation fields and revision',()=>{
 const t=recordingDidlTrial(true),original=item(),unrelated=item('object.item.videoItem','library/item/other'),base=soap(original+unrelated);
 for(const c of ['A','B','C','D','A']){
  t.select(c);let wanted=original;
  if(c==='B'||c==='D')wanted=wanted.replace('object.item.videoItem.videoBroadcast','object.item.videoItem');
  if(c==='C'||c==='D')wanted=wanted.replace('.692+09:00','+09:00').replaceAll('.000+09:00','+09:00');
  assert.equal(t.soap(base,'Browse'),soap(wanted+unrelated).replace('<UpdateID>100','<UpdateID>'+String(100+t.revision)));
 }
 assert.equal(t.soap(base,'GetProtocolInfo'),base);assert.equal(t.soap('<Id>100</Id>','GetSystemUpdateID'),`<Id>${100+t.revision}</Id>`);
});
test('scene-date comparison changes dc:date only, preserving recording origin, resource, JST and schedule',()=>{
 const metadata=identityMetadata(),snapshot=structuredClone(metadata),t=recordingDidlTrial(true,()=>metadata),source=soap(item().replace('/media/opaque','/media/aa11/recording'));
 for(const condition of ['B','D']){
  t.select(condition,true);const baseline=t.soap(source,'Browse'),revision=t.revision;t.select(condition,true,true);
  const expected=baseline.replace(condition==='B'?'2026-10-25T21:44:49.692+09:00':'2026-10-25T21:44:49+09:00',condition==='B'?'2026-10-25T21:45:00.000+09:00':'2026-10-25T21:45:00+09:00').replace(`<UpdateID>${100+revision}</UpdateID>`,`<UpdateID>${100+t.revision}</UpdateID>`);
  assert.equal(t.soap(source,'Browse'),expected);assert.deepEqual(metadata,snapshot);assert.equal(t.status().sceneProgramDate,true);
  t.select(condition,true);assert.equal(t.status().sceneProgramDate,false);assert.equal(t.soap(source,'Browse').replace(/<UpdateID>\d+<\/UpdateID>/,''),baseline.replace(/<UpdateID>\d+<\/UpdateID>/,''));
 }
 // This is the intended presentation tradeoff, not evidence of correct scene jumps.
 assert.equal(Date.parse('2026-10-25T21:45:00.000+09:00')-Date.parse('2026-10-25T21:44:49.692+09:00'),10308);
});
test('scene-date comparison is off by default and cannot invent a date for uncertain or missing schedules',()=>{
 assert.equal(recordingDidlTrial(true).status().sceneProgramDate,false);
 const t=recordingDidlTrial(true,()=>identityMetadata());for(const value of ['true',null,1])assert.throws(()=>t.select('B',true,value));assert.throws(()=>t.select('B',false,true));
 t.select('B',true,true);for(const raw of [item().replace('/media/opaque','/media/aa11/recording').replace(/<upnp:scheduledStartTime>[\s\S]*?<\/upnp:scheduledStartTime>/,''),item().replace('/media/opaque','/media/aa11/recording').replace('2026-10-25T21:45:00.000+09:00','invalid')])assert.ok(t.soap(soap(raw),'Browse').includes('2026-10-25T21:44:49.692+09:00'));
 const uncertain=recordingDidlTrial(true,()=>({...identityMetadata(),state:'uncertain'}));uncertain.select('B',true,true);assert.ok(uncertain.soap(soap(item().replace('/media/opaque','/media/aa11/recording')),'Browse').includes('2026-10-25T21:44:49.692+09:00'));
});
test('disabled and restarted trials are A; rejected conditions cannot change state',()=>{
 const off=recordingDidlTrial();assert.equal(off.soap(soap(item()),'Browse'),soap(item()));assert.throws(()=>off.select('B'));
 const t=recordingDidlTrial(true);t.select('D');const previous=t.status();for(const invalid of ['E',['B'],null,undefined,1])assert.throws(()=>t.select(invalid));assert.deepEqual(t.status(),previous);assert.equal(recordingDidlTrial(true).status().condition,'A');
});
test('only explicit JST recording date fields lose precision; resources and unknown dates do not',()=>{
 const t=recordingDidlTrial(true);t.select('C');const xml=soap(item().replace('2026-10-25T21:44:49.692+09:00','2026-10-25T12:44:49.692Z'));
 const out=t.soap(xml,'Browse');assert.ok(out.includes('2026-10-25T12:44:49.692Z'));assert.ok(out.includes('duration=&quot;00:54:20.332&quot;'));
 assert.equal(Date.parse('2026-10-25T21:44:49.692+09:00')-Date.parse('2026-10-25T21:44:49+09:00'),692);
});
test('control requires loopback source, local Host, same origin and JSON',()=>{
 const ok=(ip:string,host='127.0.0.1:19090',origin:string|undefined=undefined,type='application/json')=>recordingDidlTrialAccess(ip,host,origin,type,19090);
 assert.ok(ok('127.0.0.1'));assert.ok(ok('::ffff:127.0.0.1'));assert.ok(ok('::1','[::1]:19090'));
 assert.ok(ok('127.0.0.1','localhost:19090','http://localhost:19090','application/json; charset=utf-8'));
 assert.equal(ok('192.0.2.1'),false);assert.equal(ok('127.0.0.1','evil.test:19090'),false);assert.equal(ok('127.0.0.1','localhost:19090','http://evil.test'),false);assert.equal(ok('127.0.0.1','localhost:19090',undefined,'text/plain'),false);
});
const identityMetadata=(type='ARIB_BS',onid=4,tsid=0x40d0,sid=0x8d)=>({state:'confirmed',method:'full-clock-overlap',title:'Synthetic broadcast',serviceId:sid,eventId:1,startTime:'2026-01-01T00:00:00Z',durationSeconds:60,transportStreamId:tsid,originalNetworkId:onid,channelInfo:{version:1,state:'identified',objectType:type}});
test('empirical REGZA identifiers are variable-width lowercase hex from network/service, never TSID',()=>{
 assert.deepEqual(regzaRecordingIdentity(identityMetadata()),{network:'4',service:'8d'});
 assert.deepEqual(regzaRecordingIdentity(identityMetadata('ARIB_TB',0x7fe5,0x7fe5,0x428)),{network:'7fe5',service:'428'});
 for(const m of [undefined,{...identityMetadata(),state:'uncertain'},{...identityMetadata(),textSuspect:true},{...identityMetadata(),transportStreamId:undefined},{...identityMetadata(),serviceId:65536},{...identityMetadata(),serviceId:0},{...identityMetadata(),channelInfo:{version:1,state:'unavailable'}},identityMetadata('ARIB_CS',6),identityMetadata('ARIB_BS',7),identityMetadata('ARIB_TB',4)])assert.equal(regzaRecordingIdentity(m),undefined);
});
test('B plus IDs changes only two fields and the required namespace; aliases bind through the actual recording resource',()=>{
 const t=recordingDidlTrial(true,id=>id==='aa11'?identityMetadata():undefined),raw=item().replace('http://server/media/opaque','http://server/media/aa11/title.ts?seek=pcr').replace('item:opaque','library/folder-item/alias'),base=soap(raw);
 t.select('B');const baseline=t.soap(base,'Browse'),oldRevision=t.revision;t.select('B',true);assert.equal(t.revision,oldRevision+1);assert.equal(t.status().regzaIds,true);
 // Namespace attribute position is immaterial, but every other original byte is preserved.
 const actual=t.soap(base,'Browse');assert.ok(actual.includes('&lt;regza:network_id&gt;4&lt;/regza:network_id&gt;'));assert.ok(actual.includes('&lt;regza:service_id&gt;8d&lt;/regza:service_id&gt;'));
 const stripped=actual.replace(' xmlns:regza=&quot;urn:schemas-toshiba-co-jp:regzadata-1-0&quot;','').replace('&lt;regza:network_id&gt;4&lt;/regza:network_id&gt;&lt;regza:service_id&gt;8d&lt;/regza:service_id&gt;','').replace(`<UpdateID>${100+t.revision}</UpdateID>`,`<UpdateID>${100+oldRevision}</UpdateID>`);assert.equal(stripped,baseline);
 assert.equal((actual.match(/xmlns:regza=/g)??[]).length,1);
 t.select('B',false);assert.equal(t.status().regzaIds,false);assert.equal(t.soap(base,'Browse').replace(/<UpdateID>\d+<\/UpdateID>/,'<UpdateID/>'),baseline.replace(/<UpdateID>\d+<\/UpdateID>/,'<UpdateID/>'));
});
test('REGZA IDs cannot enter unrelated media or ambiguous metadata and reset after restart',()=>{
 const t=recordingDidlTrial(true,()=>identityMetadata('ARIB_CS',6));t.select('B',true);assert.doesNotMatch(t.soap(soap(item().replace('/media/opaque','/media/aa11/title')),'Browse'),/regza:network_id/);
 const valid=recordingDidlTrial(true,()=>identityMetadata());valid.select('B',true);for(const raw of [item('object.item.videoItem'),item().replace('http://server/media/opaque','http://server/library/jit/aa11')])assert.doesNotMatch(valid.soap(soap(raw),'Browse'),/regza:network_id/);
 const before=valid.status();for(const ids of ['true',1,{},null])assert.throws(()=>valid.select('B',ids));assert.throws(()=>valid.select('A',true));assert.deepEqual(valid.status(),before);assert.equal(recordingDidlTrial(true).status().regzaIds,false);
});
test('scene comparison D retains B IDs/class/resources and changes only date precision with explicit JST',()=>{
 const t=recordingDidlTrial(true,()=>identityMetadata()),source=soap(item().replace('/media/opaque','/media/aa11/recording'));
 t.select('B',true);const b=t.soap(source,'Browse'),revision=t.revision;t.select('D',true);const d=t.soap(source,'Browse');
 assert.equal(d,b.replace('.692+09:00','+09:00').replaceAll('.000+09:00','+09:00').replace(`<UpdateID>${100+revision}</UpdateID>`,`<UpdateID>${100+t.revision}</UpdateID>`));
 assert.ok(d.includes('object.item.videoItem&lt;/upnp:class&gt;'));assert.ok(d.includes('&lt;regza:network_id&gt;4&lt;/regza:network_id&gt;'));assert.ok(d.includes('&lt;regza:service_id&gt;8d&lt;/regza:service_id&gt;'));assert.ok(d.includes('duration=&quot;00:54:20.332&quot;'));
 assert.throws(()=>t.select('C',true));t.select('B',true);assert.equal(t.soap(source,'Browse').replace(/<UpdateID>\d+<\/UpdateID>/,''),b.replace(/<UpdateID>\d+<\/UpdateID>/,''));
});

test('recorded-start is one extra metadata element; scene date, IDs, resources, original clocks stay intact',()=>{
 const metadata={...identityMetadata(),startTime:'2026-10-25T12:45:00Z',recordingOrigin:{version:1,basis:'tot-pcr-prefix',state:'estimated',anchors:4,startTime:'2026-10-25T12:44:49.692Z',firstSeconds:.3,lastSeconds:15,spreadMs:120,uncertaintySeconds:1}},copy=structuredClone(metadata),t=recordingDidlTrial(true,()=>metadata),raw=soap(item().replace('/media/opaque','/media/aa11/recording'));
 t.select('B',true,true);const baseline=t.soap(raw,'Browse'),revision=t.revision;t.select('B',true,true,true);const field='&lt;upnp:recordedStartDateTime&gt;2026-10-25T21:44:49.692+09:00&lt;/upnp:recordedStartDateTime&gt;';
 assert.equal(t.soap(raw,'Browse'),baseline.replace('&lt;/item&gt;',field+'&lt;/item&gt;').replace(`<UpdateID>${100+revision}</UpdateID>`,`<UpdateID>${100+t.revision}</UpdateID>`));assert.deepEqual(metadata,copy);assert.equal(t.status().sceneProgramDate,true);assert.equal(t.status().recordedStartDate,true);
 const stable=t.revision;t.select('B',true,true,true);assert.equal(t.revision,stable);t.select('B',true,true,false);assert.equal(t.status().sceneProgramDate,true);assert.equal(t.soap(raw,'Browse').replace(/<UpdateID>\d+<\/UpdateID>/,''),baseline.replace(/<UpdateID>\d+<\/UpdateID>/,''));
});
test('recorded-start cannot infer dates from schedule, file dates, malformed or discontinuous recording clocks',()=>{
 const raw=soap(item().replace('/media/opaque','/media/aa11/recording')),origin={version:1,basis:'tot-pcr-prefix',state:'estimated',anchors:4,startTime:'2026-10-25T12:44:49.692Z',firstSeconds:.3,lastSeconds:15,spreadMs:120,uncertaintySeconds:1};
 for(const metadata of [identityMetadata(),{...identityMetadata(),state:'uncertain',recordingOrigin:origin},{...identityMetadata(),recordingOrigin:{...origin,startTime:'2026-02-30T12:44:49Z'}},{...identityMetadata(),recordingOrigin:{...origin,spreadMs:251}},{...identityMetadata(),recordingOrigin:origin,recordingRange:{basis:'tot-pcr-transport',state:'discontinuous',segments:2,anchorCount:4}}]){
  const t=recordingDidlTrial(true,()=>metadata);t.select('B',true,true,true);assert.doesNotMatch(t.soap(raw,'Browse'),/upnp:recordedStartDateTime/);
 }
 const t=recordingDidlTrial(true,()=>({...identityMetadata(),recordingOrigin:origin}));assert.equal(t.status().recordedStartDate,false);const before=t.status();for(const args of [['B',true,true,'true'],['B',true,false,true],['D',true,true,true],['B',true,true,null]])assert.throws(()=>t.select(...args as [unknown,unknown,unknown,unknown]));assert.deepEqual(t.status(),before);assert.equal(recordingDidlTrial(true).status().recordedStartDate,false);
});
