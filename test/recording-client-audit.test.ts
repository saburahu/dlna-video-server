import test from 'node:test';import assert from 'node:assert/strict';
import {auditRecordingClient} from '../src/recording-client-audit.js';import {escapeXml} from '../src/core.js';
test('Recording audit joins actual DIDL/duration and TimeSeek without calling user stops or reboots failures',()=>{
 const common={clientIp:'::ffff:192.168.1.2'},rows=[
  {...common,at:'2026-10-10T00:00:00Z',category:'SOAP',message:'Browse',detail:{requestXml:'<Filter>res@duration</Filter>',responseXml:`<Result>${escapeXml('<item id="item:a"><res size="100" duration="00:30:20.000" protocolInfo="http-get:*:video/vnd.dlna.mpeg-tts:PN">http://host/media/a?x=1&amp;y=2</res></item>')}</Result>`}},
  {...common,at:'2026-10-10T00:00:01Z',connectionId:'c',programId:'a',category:'HTTP_MEDIA',method:'GET',detail:{expectedBytes:100,actualPacketSize:192,requestHeaders:{'timeseekrange.dlna.org':'npt=35.24-'},timeSeek:{slice:{actualStart:34.9}}}},
  {...common,at:'2026-10-10T00:00:03Z',connectionId:'c',category:'HTTP_MEDIA_END',detail:{outcome:'client-disconnected',sentBytes:70}},
  {...common,at:'2026-10-10T00:00:04Z',connectionId:'d',programId:'a',category:'HTTP_MEDIA',method:'HEAD',detail:{}},
  {...common,at:'2026-10-10T00:00:05Z',connectionId:'d',category:'HTTP_MEDIA_END',detail:{outcome:'completed',sentBytes:0}},
 ];
 const r=auditRecordingClient(rows.reverse(),'192.168.1.2');assert.equal(r.recordingRequests,2);assert.equal(r.headRequests,1);assert.equal(r.timeSeekRequests,1);assert.equal(r.entries[0].resource.attributes.duration,'00:30:20.000');assert.equal(r.entries[0].resource.url,'http://host/media/a?x=1&y=2');assert.equal(r.entries[0].resource.browseRequestedDuration,true);assert.equal(r.entries[0].classification,'interrupted-stop-seek-or-device-failure-unresolved');assert.equal(r.entries[0].untransmittedCounterBytes,30);assert.equal(r.entries[1].verification,'receiver-result-unknown');assert.equal(auditRecordingClient(rows,'192.168.1.3').recordingRequests,0);
});
test('Recording audit joins a folder display item to its source URL instead of stale all-list metadata',()=>{
 const common={clientIp:'192.168.1.2',category:'SOAP',message:'Browse'};
 const browse=(at:string,id:string,duration:string,url:string)=>({...common,at,detail:{requestXml:'<Filter>*</Filter>',responseXml:`<Result>${escapeXml(`<item id="${id}" parentID="library/folder/x"><res duration="${duration}">${url}</res></item>`)}</Result>`}});
 const rows=[browse('2026-10-10T00:00:00Z','item:a','00:01:00.000','http://host/media/a/old.ts'),
  browse('2026-10-10T00:01:00Z','library/folder-item/alias','00:02:00.000','http://host/media/a/current.ts?encapsulation=arib-content-packet&amp;seek=pcr'),
  browse('2026-10-10T00:01:01Z','library/folder-item/other','00:03:00.000','http://host/library/jit/other'),
  {clientIp:common.clientIp,at:'2026-10-10T00:01:02Z',category:'HTTP_MEDIA',connectionId:'c',programId:'a',method:'GET',detail:{}}];
 const entry=auditRecordingClient(rows,common.clientIp).entries[0];
 assert.equal(entry.resource.objectId,'library/folder-item/alias');assert.equal(entry.resource.at,'2026-10-10T00:01:00Z');assert.equal(entry.resource.attributes.duration,'00:02:00.000');assert.equal(entry.resource.browseRequestedDuration,true);
 assert.equal(entry.resource.url,'http://host/media/a/current.ts?encapsulation=arib-content-packet&seek=pcr');
});
