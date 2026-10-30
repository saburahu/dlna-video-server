import test from 'node:test';import assert from 'node:assert/strict';
import {recordingDidlTrial,recordingDidlTrialAccess} from '../src/recording-didl-trial.js';
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
