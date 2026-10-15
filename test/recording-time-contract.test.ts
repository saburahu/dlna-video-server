import test from 'node:test';
import assert from 'node:assert/strict';
import {durationSeconds,inspectRecordingTimeContract} from '../src/recording-time-contract.js';
test('Recording duration and seek compare different clocks without asserting receiver behaviour',()=>{
 const input={didl:{duration:'00:30:20.000',size:'4343494174',protocolInfo:'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_OP=10'},
  headers:{'Content-Length':2989098,'TimeSeekRange.dlna.org':'npt=1818.757-1819.972/1819.972 bytes=4340505076-4343494173/4343494174','contentFeatures.dlna.org':'DLNA.ORG_OP=10'},
  method:'GET',receivedBytes:2989098,slice:{actualStart:1818.756577,actualEnd:1819.972134,duration:1819.972134,startByte:4340505076,wireBytes:2989098},pcr:{discontinuities:0,invalidIntervals:0}};
 const r=inspectRecordingTimeContract(input);assert.deepEqual(r.issues,[]);assert.equal(r.receiverDurationDisplay,'unknown');assert.ok(Math.abs(r.didlMinusHttpSeconds!-.028)<1e-9);
 assert.ok(inspectRecordingTimeContract({...input,receivedBytes:858062}).issues.includes('incomplete-http-body'));
 assert.ok(inspectRecordingTimeContract({...input,headers:{...input.headers,'Content-Length':2989097}}).issues.includes('time-byte-length-mismatch'));
 assert.ok(inspectRecordingTimeContract({...input,slice:{...input.slice,actualStart:1819}}).issues.includes('pcr-time-response-mismatch'));
 assert.deepEqual(inspectRecordingTimeContract({...input,method:'HEAD',receivedBytes:0}).issues,[]);
});
test('Unknown duration is not guessed; invalid PCR and declaration mismatches remain visible',()=>{
 assert.equal(durationSeconds('00:99:00'),undefined);assert.equal(durationSeconds('100:01:02.5'),360062.5);
 const r=inspectRecordingTimeContract({headers:{'content-length':100,'transfer-encoding':'chunked','contentfeatures.dlna.org':'B'},didl:{protocolInfo:'http-get:*:video/mpeg:A'},pcr:{discontinuities:1,invalidIntervals:0}});
 assert.equal(r.httpDuration,undefined);assert.equal(r.didlDuration,undefined);
 assert.deepEqual(r.issues,['length-and-transfer-encoding','didl-http-features-mismatch','pcr-timeline-not-continuous']);
});
