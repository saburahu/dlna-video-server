import test from 'node:test';
import assert from 'node:assert/strict';
import {escapeXml} from '../src/core.js';
import {declaredResources,snapshotDmsContract} from '../src/dms-contract-snapshot.js';
import {compareTransferProgress,type TransferProgress} from '../src/transfer-progress-audit.js';
import {ClientPlaybackAudit} from '../src/client-playback-audit.js';
import {observeHttpTransfer} from '../src/http-transfer-observer.js';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
const description=(control='browse')=>`<root><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><UDN>uuid:fixture</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>cm</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><controlURL>${control}</controlURL></service></serviceList></device></root>`;
const didl=`<DIDL-Lite><item><res protocolInfo="http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_PS_NTSC;DLNA.ORG_OP=01" size="10" duration="00:00:30">http://192.168.1.2/media/never-fetch</res><res protocolInfo="http-get:*:application/x-dtcp1:DTCP1FORMAT=video/vnd.dlna.mpeg-tts">http://192.168.1.2/protected</res></item></DIDL-Lite>`;
test('Snapshot is bounded read-only Browse; Source is not promoted to receiver capability',async()=>{
 const calls:{url:string;init?:RequestInit}[]=[];
 const request:typeof fetch=async(input,init)=>{const url=String(input);calls.push({url,init});return new Response(calls.length===1?description():url.endsWith('/cm')?'<Source>http-get:*:video/mpeg:*</Source><Sink></Sink>':`<Result>${escapeXml(didl)}</Result><NumberReturned>1</NumberReturned><TotalMatches>5</TotalMatches><UpdateID>9</UpdateID>`);};
 const result=await snapshotDmsContract('http://192.168.1.2/dms/','a&b',0,20,request);
 assert.equal(calls.length,3);assert.equal(calls[0].init?.method,undefined);assert(calls.slice(1).every(x=>x.init?.method==='POST'));assert(String(calls[2].init?.body).includes('<ObjectID>a&amp;b</ObjectID>'));assert(!calls.some(c=>c.url.includes('/media/')));
 assert.equal(result.inspection.sinkStatus,'not-advertised');assert.equal(result.browse.resources[0].parameters['DLNA.ORG_OP'],'01');assert.equal(result.browse.resources[0].framing,'unknown-from-DIDL-alone');assert.equal(result.browse.resources[1].protection,'dtcp-signalled');assert.equal(result.browse.totalMatches,'5');
 assert.equal(declaredResources('<res protocolInfo=\'http-get:*:video/mpeg:*\'>a&amp;b</res>')[0].url,'a&b');
});
test('Snapshot rejects external control, unbounded pages, SOAP faults and excessive XML',async()=>{
 await assert.rejects(snapshotDmsContract('http://192.168.1.2/', '0',0,0),/1..100/);
 for(const kind of ['external','fault','large']){
  let n=0;const request:typeof fetch=async()=>new Response(++n===1?description(kind==='external'?'http://example.com/browse':'browse'):n===2?'<Source/><Sink/>':kind==='fault'?'<s:Fault/>':'x'.repeat(1048577));
  await assert.rejects(snapshotDmsContract('http://192.168.1.2/','0',0,1,request),kind==='external'?/private host/:kind==='fault'?/Browse failed/:/1 MiB/);
 }
});
const p:TransferProgress={elapsedMs:0,bodyBytesEnqueued:4096,socketBytesWrittenIncludingHeaders:1024,writableLength:3072,needDrain:true,sourceEof:false};
test('Transfer evidence separates local progress, blocked write, EOF, finish and unavailable old measurements',()=>{
 assert.equal(compareTransferProgress(p,{...p,elapsedMs:1000}).state,'local-backpressure-without-socket-progress');
 assert.equal(compareTransferProgress(p,{...p,elapsedMs:1000,socketBytesWrittenIncludingHeaders:2048}).state,'local-socket-progress');
 assert.equal(compareTransferProgress(p,{...p,elapsedMs:1000,needDrain:false,writableLength:0,sourceEof:true}).state,'source-eof-awaiting-response-finish');
 assert.equal(compareTransferProgress(p,{...p,elapsedMs:1000,completed:true}).state,'response-finished');
 assert.equal(compareTransferProgress(p,{...p,elapsedMs:-1}).state,'invalid-or-reset');
 const audit=new ClientPlaybackAudit('192.168.1.2');audit.observe({at:'2026-10-10',category:'CLIENT_CONTRACT',message:'CLIENT_CONTRACT_END',detail:{remote:'192.168.1.2',sentBytes:10682368,completed:false}});assert.deepEqual(audit.result().transferProgressComparisons,{});
 for(const [i,detail] of [p,{...p,elapsedMs:1000}].entries())audit.observe({at:`2026-10-10T00:00:0${i}Z`,category:'CLIENT_CONTRACT',message:'CLIENT_CONTRACT_PROGRESS',detail:{...detail,requestId:'one',remote:'192.168.1.2'}});
 assert.equal(audit.result().transferProgressComparisons['local-backpressure-without-socket-progress'],1);assert.equal(audit.result().timeline.at(-1)?.needDrain,true);
});
test('Passive HTTP observer preserves Range/body and records finish versus aborted response; log failure is isolated',async()=>{
 const events:{event:string;detail:any}[]=[],body=Buffer.alloc(131072,0x62);
 const server=createServer((req,res)=>{observeHttpTransfer(req,res,(event,detail)=>{events.push({event,detail});if(req.url==='/throw')throw Error('logging failure');},10);
  res.writeHead(206,{'Content-Length':body.length,'Content-Range':`bytes 0-${body.length-1}/${body.length}`});
  if(req.url==='/abort'){res.write(body.subarray(0,1024));return;}
  res.end(body);
 });server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;
 try{
  for(const route of ['/','/throw']){const res=await fetch(`http://127.0.0.1:${port}${route}`,{headers:{Range:`bytes=0-${body.length-1}`}});assert.equal(res.status,206);assert.equal(res.headers.get('Content-Range'),`bytes 0-${body.length-1}/${body.length}`);assert.deepEqual(Buffer.from(await res.arrayBuffer()),body);}
  await new Promise<void>((resolve,reject)=>{const r=request(`http://127.0.0.1:${port}/abort`,res=>res.once('data',()=>{res.destroy();resolve();}));r.on('error',reject);r.end();});
  const limit=Date.now()+3000;while(!events.some(e=>e.event==='HTTP_TRANSFER_CLOSE'&&!e.detail.completed)){if(Date.now()>limit)throw Error('No abort observation');await new Promise(r=>setTimeout(r,10));}
  assert.equal(events.filter(e=>e.event==='HTTP_TRANSFER_FINISH').length,2);assert(events.some(e=>e.event==='HTTP_TRANSFER_CLOSE'&&!e.detail.completed));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
