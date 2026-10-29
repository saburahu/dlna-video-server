import test from 'node:test';import assert from 'node:assert/strict';
import {metadataDisplay,validMetadata,type RecordingMetadata} from '../src/recording-metadata.js';
import {browseDIDL} from '../src/upnp.js';import {profiles} from '../src/core.js';
const m=(startTime:string,durationSeconds=1800):RecordingMetadata=>({state:'confirmed',method:'full-clock-overlap',serviceId:101,eventId:11,startTime,durationSeconds,title:'Synthetic broadcast',station:'Synthetic station'});
const p={id:'synthetic',filePath:'synthetic.ts',title:'filename',size:188000,modified:'2020-01-01T00:00:00.000Z',published:true,analysis:'ok' as const,duration:1820};
test('broadcast wall clock has explicit JST without moving its instant or changing stored metadata',()=>{
 const metadata=m('2026-10-25T12:45:00.000Z',3240),original=JSON.stringify(metadata),display=metadataDisplay({...p,metadata});
 assert.equal(display.date,'2026-10-25T21:45:00.000+09:00');assert.equal(display.scheduledStartTime,display.date);assert.equal(display.scheduledEndTime,'2026-10-25T22:39:00.000+09:00');
 assert.equal(Date.parse(display.date),Date.parse(metadata.startTime!));assert.equal(Date.parse(display.scheduledEndTime!),Date.parse(metadata.startTime!)+3240000);assert.equal(JSON.stringify(metadata),original);
 // Wall-clock-only parsers reproduce the photographed nine-hour error with Z.
 assert.equal(display.date.slice(11,16),'21:45');assert.equal(metadata.startTime!.slice(11,16),'12:45');
});
test('broadcast JST conversion handles day/year/leap rollover and an already offset source once',()=>{
 for(const [input,expected] of [
  ['2026-12-31T15:00:00.000Z','2027-01-01T00:00:00.000+09:00'],
  ['2024-02-28T15:00:00.000Z','2024-02-29T00:00:00.000+09:00'],
  ['2026-08-04T15:00:00Z','2026-08-05T00:00:00.000+09:00'],
  ['2026-10-25T21:45:00+09:00','2026-10-25T21:45:00.000+09:00'],
  ['2026-10-25T14:45:00+02:00','2026-10-25T21:45:00.000+09:00']
 ]){const metadata=m(input);assert(validMetadata(metadata));const display=metadataDisplay({...p,metadata});assert.equal(display.date,expected);assert.equal(Date.parse(display.date),Date.parse(input));}
 const cross=metadataDisplay({...p,metadata:m('2026-12-31T14:45:00Z')});assert.equal(cross.scheduledStartTime,'2026-12-31T23:45:00.000+09:00');assert.equal(cross.scheduledEndTime,'2027-01-01T00:15:00.000+09:00');
});
test('ordinary file dates and uncertain/invalid broadcast metadata keep existing fallback',()=>{
 for(const metadata of [undefined,{...m('2026-10-25T12:45:00Z'),state:'uncertain' as const},m('invalid')]){const display=metadataDisplay({...p,metadata});assert.equal(display.date,p.modified);assert.equal(display.scheduledStartTime,undefined);assert.equal(display.scheduledEndTime,undefined);}
});
test('normal Browse and Metadata carry equivalent JST dates, same IDs/resources and no model-specific branch',()=>{
 const metadata=m('2026-12-31T14:45:00Z'),program={...p,metadata,station:metadata.station},a=browseDIDL('all',0,200,[program],'http://localhost:19200',profiles.standard).didl,b=browseDIDL('item:synthetic',0,1,[program],'http://localhost:19200',profiles.standard,true).didl;
 assert.equal(a,b);assert.match(a,/<dc:date>2026-12-31T23:45:00\.000\+09:00<\/dc:date>/);assert.match(a,/<upnp:scheduledEndTime>2027-01-01T00:15:00\.000\+09:00/);assert.match(a,/id="item:synthetic"/);assert.match(a,/\/media\/synthetic\/filename\.ts/);assert.match(a,/duration="00:30:20\.000"/);
});
