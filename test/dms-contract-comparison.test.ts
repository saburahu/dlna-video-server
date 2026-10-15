import test from 'node:test';
import assert from 'node:assert/strict';
import {escapeXml} from '../src/core.js';
import {declaredObjects} from '../src/dms-contract-snapshot.js';
import {compareDmsContracts,type ContractSnapshot} from '../src/dms-contract-comparison.js';
const didl=`<DIDL-Lite><container id="folder" parentID="0"><dc:title>録画</dc:title></container><item id="a" parentID="folder"><dc:title>A &amp; B</dc:title><upnp:class>object.item.videoItem</upnp:class><res duration="0:30:00" protocolInfo="http-get:*:application/x-dtcp1:DLNA.ORG_PN=DTCP_MPEG_TS_JP_T">http://192.168.1.2/a</res><res protocolInfo="http-get:*:application/x-dtcp1:*">http://192.168.1.2/a</res></item></DIDL-Lite>`;
const snapshot:ContractSnapshot={acquiredAt:'2026-10-10',inspection:{device:{deviceId:'uuid:test'}},browse:{responseXml:`<Result>${escapeXml(didl)}</Result>`,sha256:'fixture'}};
test('Offline comparison preserves parent, class, PN/fallback resources and unknown HTTP',()=>{
 const objects=declaredObjects(didl);assert.equal(objects.length,2);assert.equal(objects[1].title,'A & B');assert.equal(objects[1].attributes.parentID,'folder');
 const c=compareDmsContracts(snapshot,'a',snapshot,'a');assert.equal(c.left.object.resources.length,2);assert.equal(c.left.declaration[0].durationHourDigits,1);assert.equal(c.left.declaration[1].parameters['DLNA.ORG_PN'],undefined);assert.equal(c.left.http,null);assert.equal(c.left.framing,'unknown');assert(c.limitations.some(x=>x.includes('Different source')));
});
test('HTTP comparison requires explicit matching provenance, never manufactures transport evidence',()=>{
 const http={reference:'trace.pcap stream 1',observedAt:'2026-10-10',resourceUrl:'http://192.168.1.2/a',method:'GET' as const,status:200,requestHeaders:{},responseHeaders:{'content-length':'10'}};
 const c=compareDmsContracts(snapshot,'a',snapshot,'a',{left:http});assert.equal(c.left.http?.responseHeaders['content-length'],'10');assert.equal(c.right.httpStatus,'unobserved');assert.equal(c.left.framing,'unknown');
 assert.throws(()=>compareDmsContracts(snapshot,'a',snapshot,'a',{left:{...http,resourceUrl:'http://192.168.1.2/other'}}),/match/);
 assert.throws(()=>compareDmsContracts(snapshot,'a',snapshot,'a',{left:{...http,reference:''}}),/cite/);
 assert.throws(()=>compareDmsContracts(snapshot,'absent',snapshot,'a'),/absent/);
});
