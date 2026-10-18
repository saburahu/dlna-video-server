import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {request,Agent} from 'node:http';
import {connect} from 'node:net';
import {once} from 'node:events';
import {clientDeviceDescription,inspectClientCapability} from '../src/client-capability-inspection.js';
import {appendDiagnosticRoot,createClientContractDiagnostics,diagnosticRange,type DiagnosticContract} from '../src/client-contract-diagnostics.js';
import {saveShadowJson} from '../src/playback-shadow-store.js';
import {ClientPlaybackAudit} from '../src/client-playback-audit.js';

test('Audit distinguishes missing resource, no GET, server bytes and normal cancellation',()=>{
 const missing=new ClientPlaybackAudit('192.168.1.2');const row={at:'2026-10-10T00:00:00Z',clientIp:'192.168.1.2',category:'SOAP',message:'Browse',detail:{responseXml:'<Result>&lt;DIDL-Lite&gt;&lt;item id=&quot;a&quot;/&gt;&lt;/DIDL-Lite&gt;</Result>'}};missing.observe(row);assert.equal(missing.result().stage,'resource-not-published');
 const offered=new ClientPlaybackAudit('192.168.1.2');offered.observe({...row,detail:{responseXml:row.detail.responseXml.replace('&lt;item id=&quot;a&quot;/&gt;','&lt;item&gt;&lt;res&gt;url&lt;/res&gt;&lt;/item&gt;')}});assert.equal(offered.result().stage,'no-media-request');offered.observe({at:row.at,clientIp:row.clientIp,category:'HTTP_MEDIA',method:'GET',detail:{responseStatus:200}});offered.observe({at:row.at,clientIp:row.clientIp,category:'HTTP_MEDIA_END',detail:{sentBytes:4096,outcome:'client-disconnected'}});assert.equal(offered.result().stage,'server-sent-receiver-decode-unconfirmed');assert.equal(offered.result().httpErrors,0);
 offered.observe({at:row.at,category:'EXPERIMENTAL_CATALOG',message:'JIT_END',detail:{client:row.clientIp,detail:{detail:{cancelled:true,error:'Client disconnected or session replaced'}}}});assert.equal(offered.result().cancellations,1);assert.equal(offered.result().setupErrors,0);
 missing.observe({...row,clientIp:'192.168.1.3'});assert.equal(missing.result().browseRequests,1);
 const rejected=new ClientPlaybackAudit(row.clientIp);rejected.observe({at:row.at,category:'CLIENT_CONTRACT',message:'CLIENT_CONTRACT_END',detail:{remote:row.clientIp,status:406,sentBytes:0}});assert.equal(rejected.result().httpErrors,1);
 rejected.observe({at:row.at,category:'CLIENT_CONTRACT',message:'CLIENT_CONTRACT_END',detail:{remote:row.clientIp,status:206,completed:false,sentBytes:10}});rejected.observe({at:row.at,category:'CLIENT_CONTRACT',message:'CLIENT_CONTRACT_TIMEOUT',detail:{remote:row.clientIp}});assert.equal(rejected.result().incompleteTransfers,1);assert.equal(rejected.result().completedTransfers,0);assert.equal(rejected.result().serverIdleTimeouts,1);
});

test('Diagnostic Range follows GET-only, inclusive boundaries, unsupported multipart and If-Range fallback',()=>{
 assert.deepEqual(diagnosticRange('GET','bytes=0-9',undefined,10),{start:0,end:9});
 assert.deepEqual(diagnosticRange('GET','bytes=9-',undefined,10),{start:9,end:9});
 assert.deepEqual(diagnosticRange('GET','bytes=-1',undefined,10),{start:9,end:9});
 assert.deepEqual(diagnosticRange('GET','bytes=0-99',undefined,10),{start:0,end:9});
 for(const [method,h,condition] of [['HEAD','bytes=2-5',undefined],['GET','bytes=0-1,4-5',undefined],['GET','items=0-1',undefined],['GET','bytes=1-2','"unknown"']])assert.equal(diagnosticRange(method!,h,condition,10),null);
 for(const h of ['bytes=10-','bytes=7-3','bytes=-0','bytes=-','bytes=x-3'])assert.throws(()=>diagnosticRange('GET',h,undefined,10),RangeError);
});

async function diagnosticHttpFixture(bytes:Buffer,idle=30000){
 const dir=await fs.mkdtemp(path.join(tmpdir(),'pt3-diagnostic-http-')),file=path.join(dir,'sample.mpg');await fs.writeFile(file,bytes);const st=await fs.stat(file),device=clientDeviceDescription(description,'http://127.0.0.1:1234/dms/');
 const inspection={version:'client-capability-inspection-v1' as const,acquiredAt:new Date().toISOString(),device,connectionManagers:[],sinkStatus:'not-advertised' as const,unknowns:[]};
 const contract:DiagnosticContract={version:'client-contract-diagnostic-v1',enabled:true,inspection,sample:{id:'00000000-0000-4000-8000-000000000001',title:'local PC fixture',path:file,size:st.size,mtimeMs:st.mtimeMs,sha256:createHash('sha256').update(bytes).digest('hex'),duration:30,mime:'video/mpeg',profileName:'MPEG_PS_NTSC',verification:'pc-validated-diagnostic-only',evidence:'local'}};
 await saveShadowJson(path.join(dir,'contract.json'),contract);const events:any[]=[];
 const handler=createClientContractDiagnostics(dir,(event,detail)=>events.push({event,...detail as object}),async()=>inspection,idle);
 const server=createServer((req,res)=>void handler.media(req,res,contract.sample.id));server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;
 return {dir,contract,handler,events,port,url:`http://127.0.0.1:${port}/`,async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(dir,{recursive:true,force:true});}};
}
const until=async(f:()=>boolean)=>{const limit=Date.now()+5000;while(!f()){if(Date.now()>limit)throw Error('Diagnostic lifecycle did not complete');await new Promise(r=>setTimeout(r,10));}};
test('DBR-shaped full Range completes exactly; reconnect/HEAD/boundaries/multipart and disable are consistent',async()=>{
 const bytes=Buffer.alloc(13760512,0x55),f=await diagnosticHttpFixture(bytes),agent=new Agent({keepAlive:true});
 try{
  const reply=()=>new Promise<void>((resolve,reject)=>{const req=request(f.url,{agent,headers:{'Content-Length':'0','transferMode.dlna.org':'Streaming',Range:`bytes=0-${bytes.length-1}`}},res=>{assert.equal(res.statusCode,206);assert.equal(res.headers['content-length'],String(bytes.length));assert.equal(res.headers['content-range'],`bytes 0-${bytes.length-1}/${bytes.length}`);assert.equal(res.headers['transfer-encoding'],undefined);const hash=createHash('sha256');let n=0;res.on('data',b=>{n+=b.length;hash.update(b);});res.on('error',reject);res.on('end',()=>{try{assert.ok(res.complete);assert.equal(n,bytes.length);assert.equal(hash.digest('hex'),f.contract.sample.sha256);resolve();}catch(e){reject(e);}});});req.on('error',reject);req.end();});
  await reply();await reply();
  for(const [range,status,length] of [['bytes=0-0',206,1],['bytes=-1',206,1],['bytes=13760511-',206,1],['bytes=13760512-',416,0],['bytes=0-1,4-5',200,bytes.length]]){const r=await fetch(f.url,{headers:{Range:String(range)}});assert.equal(r.status,status);assert.equal((await r.arrayBuffer()).byteLength,length);}
  const head=await fetch(f.url,{method:'HEAD',headers:{Range:'bytes=2-4'}});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal(head.headers.get('content-range'),null);assert.equal((await head.arrayBuffer()).byteLength,0);
  await until(()=>f.events.some(e=>e.event==='CLIENT_CONTRACT_FILE_CLOSED'));assert.ok(f.events.some(e=>e.completed&&e.sentBytes===bytes.length&&e.sourceEof));assert.ok(f.events.some(e=>e.firstBodyEnqueuedMs!==undefined));
  await saveShadowJson(path.join(f.dir,'contract.json'),{...f.contract,enabled:false});await fs.utimes(path.join(f.dir,'contract.json'),new Date(),new Date(Date.now()+1000));assert.equal(await f.handler.enabled('127.0.0.1'),false);assert.equal((await fetch(f.url)).status,404);
 }finally{agent.destroy();await f.close();}
});
test('Diagnostic abort and stalled reader clean up file/socket; idle timeout is not successful EOF',async()=>{
 const f=await diagnosticHttpFixture(Buffer.alloc(32*1024*1024,0x33),1000);
 try{
  const controller=new AbortController(),r=await fetch(f.url,{signal:controller.signal});await r.body!.getReader().read();controller.abort();await until(()=>f.events.some(e=>e.event==='CLIENT_CONTRACT_FILE_CLOSED'));
  const closed=f.events.filter(e=>e.event==='CLIENT_CONTRACT_FILE_CLOSED').length;
  const socket=connect(f.port,'127.0.0.1');await once(socket,'connect');socket.pause();socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-33554431\r\nContent-Length: 0\r\ntransferMode.dlna.org: Streaming\r\n\r\n');
  try{await until(()=>f.events.some(e=>e.event==='CLIENT_CONTRACT_TIMEOUT'));await until(()=>f.events.filter(e=>e.event==='CLIENT_CONTRACT_FILE_CLOSED').length>closed);assert.ok(f.events.some(e=>e.outcome==='server-idle-timeout'&&!e.completed&&e.bodyBytesEnqueued<33554432));}finally{socket.destroy();}
  const next=await fetch(f.url,{headers:{Range:'bytes=0-3'}});assert.equal(next.status,206);assert.equal((await next.arrayBuffer()).byteLength,4);
 }finally{await f.close();}
});

const description=`<root><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>Renamed recorder</friendlyName><manufacturer>TOSHIBA</manufacturer><modelName>DBRT10</modelName><UDN>uuid:test-recorder</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>control/ConnectionManager</controlURL></service></serviceList></device></root>`;
test('DMS Source is never converted to DMP Sink; UDN and host are validated',async()=>{
 const requests:string[]=[];const request:typeof fetch=async(input,init)=>{requests.push(String(input));return new Response(init?.method==='POST'?'<Envelope><Source>http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_PS_NTSC</Source><Sink></Sink></Envelope>':description);};
 const result=await inspectClientCapability('http://192.168.1.2:1234/dms/','uuid:test-recorder',undefined,request);assert.equal(result.sinkStatus,'not-advertised');assert.equal(result.connectionManagers[0].sink,'');assert.ok(result.connectionManagers[0].source);assert.deepEqual(requests,['http://192.168.1.2:1234/dms/','http://192.168.1.2:1234/dms/control/ConnectionManager']);
 await assert.rejects(inspectClientCapability('http://192.168.1.2/dms/','uuid:wrong',undefined,request),/UDN changed/);
 const renamed=clientDeviceDescription(description.replace('Renamed recorder','Another name'),'http://192.168.1.2/dms/');assert.equal(renamed.identityHash,result.device.identityHash);
 const hostile:typeof fetch=async()=>new Response(description.replace('control/ConnectionManager','http://192.168.1.3/cm'));await assert.rejects(inspectClientCapability('http://192.168.1.2/dms/',undefined,undefined,hostile),/same private host/);
 await assert.rejects(inspectClientCapability('https://192.168.1.2/dms/',undefined,undefined,request),/same private host/);
});
test('Absent receiver service, SOAP fault, and real Sink remain distinct',async()=>{
 const absent=await inspectClientCapability('http://192.168.1.2/',undefined,undefined,async()=>new Response(description.replace(/<serviceList>[\s\S]*<\/serviceList>/,'')));assert.equal(absent.sinkStatus,'service-unavailable');
 const fault=await inspectClientCapability('http://192.168.1.2/',undefined,undefined,async(_,i)=>new Response(i?.method==='POST'?'<Fault><Sink>fake</Sink></Fault>':description));assert.equal(fault.sinkStatus,'service-unavailable');
 const real=await inspectClientCapability('http://192.168.1.2/',undefined,undefined,async(_,i)=>new Response(i?.method==='POST'?'<Sink>http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_PS_NTSC</Sink>':description));assert.equal(real.sinkStatus,'advertised');
});
const rootPage=(start:number,count:number)=>{const entries=['<container id="rec"/>','<container id="experimental"/>'].slice(start,count?start+count:undefined).map(s=>s.replaceAll('<','&lt;').replaceAll('>','&gt;'));return `<Result>&lt;DIDL-Lite&gt;${entries.join('')}&lt;/DIDL-Lite&gt;</Result><NumberReturned>${entries.length}</NumberReturned><TotalMatches>2</TotalMatches>`;};
test('Diagnostic root pagination adds one sibling only; receiver SOAP bytes unchanged',()=>{
 for(const count of [0,1,2,11])for(const start of [0,1,2,3]){const xml=rootPage(start,count),b={objectId:'0',metadata:false,start,count};assert.equal(appendDiagnosticRoot(xml,b,false),xml);const r=appendDiagnosticRoot(xml,b,true);assert.match(r,/<TotalMatches>3</);const n=Number(/<NumberReturned>(\d+)/.exec(r)![1]);assert.equal(n,Math.max(0,Math.min(count||3,3-start)));assert.equal(r.includes('再生互換診断'),start<=2&&(count===0||start+count>2));}
 const metadata='<Result>&lt;container id=&quot;0&quot; parentID=&quot;-1&quot; childCount=&quot;2&quot;/&gt;</Result>';assert.match(appendDiagnosticRoot(metadata,{objectId:'0',metadata:true,start:0,count:0},true),/childCount=&quot;3/);
});
test('Bound diagnostic HTTP: HEAD, GET, byte Range, stale identity/hash, independent concurrent clients',async()=>{
 const dir=await fs.mkdtemp(path.join(tmpdir(),'pt3-client-contract-')),file=path.join(dir,'sample.mpg'),bytes=Buffer.from('program-stream-fixture'),events:any[]=[];await fs.writeFile(file,bytes);const st=await fs.stat(file);
 const device=clientDeviceDescription(description,'http://127.0.0.1:1234/dms/'),inspection={version:'client-capability-inspection-v1' as const,acquiredAt:new Date().toISOString(),device,connectionManagers:[],sinkStatus:'not-advertised' as const,unknowns:['Sink unknown']};
 const contract:DiagnosticContract={version:'client-contract-diagnostic-v1',enabled:true,inspection,sample:{id:'00000000-0000-4000-8000-000000000002',title:'diagnostic',path:file,size:st.size,mtimeMs:st.mtimeMs,sha256:createHash('sha256').update(bytes).digest('hex'),duration:30,mime:'video/mpeg',profileName:'MPEG_PS_NTSC',verification:'pc-validated-diagnostic-only',evidence:'test'}};await saveShadowJson(path.join(dir,'contract.json'),contract);
 let wrong=false;const handler=createClientContractDiagnostics(dir,(event,detail)=>events.push({event,detail}),async()=>({...inspection,device:{...device,...(wrong?{identityHash:'wrong'}:{})}}));
 const server=createServer((req,res)=>void handler.media(req,res,contract.sample.id));server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 try{const results=await Promise.all([fetch(url),fetch(url,{method:'HEAD'}),fetch(url,{headers:{Range:'bytes=2-6'}})]);assert.equal(results[0].status,200);assert.deepEqual(Buffer.from(await results[0].arrayBuffer()),bytes);assert.equal(results[1].headers.get('content-length'),String(bytes.length));assert.equal((await results[1].arrayBuffer()).byteLength,0);assert.equal(results[2].status,206);assert.deepEqual(Buffer.from(await results[2].arrayBuffer()),bytes.subarray(2,7));assert.match(results[0].headers.get('contentfeatures.dlna.org')!,/MPEG_PS_NTSC/);assert.equal(results[0].headers.get('transfer-encoding'),null);assert.equal(await handler.enabled('192.168.1.9'),false);assert.equal(await handler.protocolInfo('192.168.1.9'),undefined);const page=await handler.browse({objectId:'client-diagnostics',metadata:false,start:0,count:10},'127.0.0.1',url);assert.match(page!.didl,/DLNA.ORG_OP=01/);assert.match(page!.didl,/unconfirmed/);

  const leaf=await handler.browse({objectId:'client-diagnostics/'+contract.sample.id,metadata:false,start:0,count:10},'127.0.0.1',url);assert.equal(leaf!.numberReturned,0);assert.equal(leaf!.total,0);
  assert.equal((await fetch(url,{headers:{Range:'bytes=9999-'}})).status,416);assert.equal((await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=1-2'}})).status,406);
  wrong=true;assert.equal((await fetch(url)).status,503);wrong=false;
  await saveShadowJson(path.join(dir,'contract.json'),{...contract,sample:{...contract.sample,sha256:'wrong'}});await fs.utimes(path.join(dir,'contract.json'),new Date(),new Date(Date.now()+1000));assert.equal((await fetch(url)).status,503);
  await fs.writeFile(path.join(dir,'contract.json'),'malformed JSON');await fs.utimes(path.join(dir,'contract.json'),new Date(),new Date(Date.now()+2000));assert.equal(await handler.enabled('192.168.1.9'),false);assert.equal(await handler.enabled('127.0.0.1'),false);assert.equal((await fetch(url)).status,404);assert.ok(events.some(e=>e.event==='CLIENT_CONTRACT_END'));assert.ok(events.some(e=>e.event==='CLIENT_CONTRACT_MANIFEST_ERROR'));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(dir,{recursive:true,force:true});}
});
