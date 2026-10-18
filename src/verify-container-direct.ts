import {promises as fs} from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {once} from 'node:events';import {createHash} from 'node:crypto';
import {createDirectMedia} from './direct-media.js';import {experimentalBrowseSoap} from './experimental-catalog.js';
import {execute,ffmpeg,ffprobe} from './prepare-executor.js';

/** Explicit isolated component HTTP test. No DMS settings/catalog, SSDP or JIT. */
async function main(){
 const a=process.argv.slice(2),arg=(k:string)=>a[a.indexOf(k)+1];assert.ok(a.includes('--source')&&a.includes('--out'));
 const source=path.resolve(arg('--source')),out=path.resolve(arg('--out')),relative=path.relative(path.dirname(source),out);
 assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative));await fs.mkdir(out,{recursive:false});const before=await fs.stat(source);
 const options={windowsHide:true,timeout:60000,maxBuffer:4*2**20};
 const probe=JSON.parse((await execute(ffprobe(),['-v','error','-show_streams','-show_format','-of','json',source],options)).stdout);
 const tracks=probe.streams.filter((s:any)=>s.codec_type==='audio');assert.ok(tracks.length>0&&tracks.length<=8);
 const entry:any={objectId:'experimental/catalog-item/'+createHash('md5').update(source).digest('hex'),filename:path.basename(source),fingerprint:{path:source,size:before.size,mtimeMs:before.mtimeMs},lightweightProbe:probe};
 const events:any[]=[],direct=createDirectMedia(()=>[path.dirname(source)],(category,detail)=>events.push({category,detail}));let base='';
 const server=createServer((req,res)=>void(async()=>{if(req.url==='/browse'){
  const didl=direct.item(entry,base,direct.client(req,'127.0.0.1'));assert.ok(didl);res.end(experimentalBrowseSoap({didl:`<DIDL-Lite>${didl}</DIDL-Lite>`,numberReturned:1,total:1},0));
 }else await direct.deliver(req,res,entry);})().catch(error=>{if(!res.headersSent){res.writeHead(500);res.end(String(error));}else res.destroy();}));
 server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as any).port;
 try{
  const response=await fetch(base+'/browse',{method:'POST',headers:{'User-Agent':'VLC/3.0'}}),soap=await response.text();assert.equal(response.status,200);await fs.writeFile(path.join(out,'browse.xml'),soap);
  const xml=soap.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&amp;','&'),url=/<res[^>]*>([^<]+)<\/res>/.exec(xml)?.[1];assert.ok(url);assert.ok(url.includes('/library/direct/'));assert.match(xml,/DLNA.ORG_OP=01/);
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(before.size));
  const file=await fs.open(source,'r'),ranges=[];try{for(const start of [...new Set([0,Math.floor(before.size/2),Math.max(0,before.size-65536)])]){
   const end=Math.min(before.size-1,start+65535);const r:Response=await fetch(url,{headers:{Range:`bytes=${start}-${end}`}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),`bytes ${start}-${end}/${before.size}`);
   const bytes=Buffer.from(await r.arrayBuffer()),expected=Buffer.alloc(end-start+1);assert.equal((await file.read(expected,0,expected.length,start)).bytesRead,expected.length);assert.deepEqual(bytes,expected);ranges.push({start,end,sha256:createHash('sha256').update(bytes).digest('hex')});
  }}finally{await file.close();}
  const remote=JSON.parse((await execute(ffprobe(),['-v','error','-show_streams','-of','json',url],options)).stdout);assert.equal(remote.streams.filter((s:any)=>s.codec_type==='audio').length,tracks.length);
  const hashes=[];for(let i=0;i<tracks.length;i++){
   const args=['-v','error','-map',`0:a:${i}`,'-t','3','-vn','-f','hash','-hash','sha256','-'];
   const original=await execute(ffmpeg(),['-i',source,...args],options);const served:{stdout:string;stderr:string}=await execute(ffmpeg(),['-i',url,...args],options);
   assert.equal(original.stderr.trim(),'');assert.equal(served.stderr.trim(),'');assert.equal(served.stdout,original.stdout);hashes.push(served.stdout.trim());
  }
  const after=await fs.stat(source);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);
  const report={scope:'Actual DirectMedia DIDL/HTTP component, original bytes and per-track first 3s decode; no receiver or full-file decode claim',tracks:tracks.length,headStatus:head.status,ranges,hashes,events};
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({tracks:tracks.length,ranges:ranges.length,matchedAudioHashes:hashes.length}));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
