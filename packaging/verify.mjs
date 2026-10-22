import {prepareTestInstallation} from './test-installation.mjs';
// Run with the builder's Node. Every application operation below uses the
// packaged runtime, executable paths and compiled JS in a repository-external copy.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {request} from 'node:http';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),[input,auditFile,sourcePolicy,sourceList]=process.argv.slice(2);
assert.ok(input,'Usage: node packaging/verify.mjs PACKAGE [FIVE-CLIENT-AUDIT SOURCE-POLICY SOURCE-LIST]');
assert.ok(process.env.PT3_TEST_FFMPEG_DIR,'Public tests require a separately installed FFmpeg/ffprobe directory');
const installation=await prepareTestInstallation(input,'public'),{home,app}=installation,data=path.join(home,'state'),media=path.join(home,'録画','階層','番組');
await fs.mkdir(media,{recursive:true});
const node=path.join(app,'runtime','node.exe'),external=path.resolve(process.env.PT3_TEST_FFMPEG_DIR??path.join(app,'runtime')),ffmpeg=path.join(external,'ffmpeg.exe');
const env={...process.env,NODE_PATH:'',PT3_DATA_DIR:data,PT3_LOG_DIR:path.join(data,'logs'),PT3_FFMPEG_DIR:external,PT3_FFMPEG:ffmpeg,PT3_FFPROBE:path.join(external,'ffprobe.exe'),PATH:[external,path.join(app,'runtime'),path.join(process.env.SystemRoot,'System32'),path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0')].join(path.delimiter)};
const run=(file,args,options={})=>exec(file,args,{cwd:app,env,windowsHide:true,maxBuffer:10485760,timeout:300000,...options});
const ctl=async(...args)=>{const config=await fs.readFile(path.join(app,'launcher.json'),'utf8').then(JSON.parse).catch(()=>({}));const selected=args.includes('--data')?args[args.indexOf('--data')+1]:config.data??data;assert.ok(path.resolve(selected).startsWith(home+path.sep),'Test control refuses external data');return run(node,[path.join(app,'control.mjs'),...args,...(args.includes('--data')?[]:['--data',selected])]);};
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const results={home,package:path.resolve(input),checks:[],jit:undefined,concurrency:undefined};
try{
 await ctl('ffmpeg','--data',data,'--directory',external);await ctl('doctor');results.checks.push('Manifest, bundled pinned runtime or explicit external override, SQLite and software encoders');
 // Small synthetic library tests the *distribution* and discovery, not receiver quality.
 await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=25','-f','lavfi','-i','sine=sample_rate=48000','-t','4','-c:v','mpeg2video','-c:a','aac','-f','mpegts',path.join(media,'試験.ts')]);
 for(const [name,v,a] of [['試験.mp4','libx264','aac'],['試験.mkv','libx265','aac'],['試験.avi','mpeg4','mp3'],['試験.wmv','wmv2','wmav2']])await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=25','-f','lavfi','-i','sine=sample_rate=48000','-t','4','-c:v',v,'-c:a',a,path.join(media,name)]);
 await assert.rejects(ctl('setup','--data',path.join(app,'unsafe'),'--folders',media));
 await assert.rejects(ctl('setup','--data',path.join(media,'unsafe'),'--folders',media));
 await assert.rejects(ctl('setup','--data',data,'--port','80','--folders',media));
 await ctl('setup','--data',data,'--port','19204','--address','127.0.0.1','--folders',media,'--name','PT3 居間 & 録画','--no-ssdp');
 const automaticFile=path.join(data,'experimental-catalog','automatic.json');await fs.writeFile(automaticFile,JSON.stringify({...await read(automaticFile),scanIntervalMs:1000})); // accelerated timer fixture only
 const settings=await read(path.join(data,'settings.json'));assert.match(settings.udn,/^uuid:/);
 await ctl('start');
 const base='http://127.0.0.1:19204';
 assert.equal((await fetch(base+'/api/scan',{method:'POST'})).status,403,'missing management write header');
 assert.equal(await new Promise((resolve,reject)=>{const r=request(base+'/api/status',{headers:{Host:'attacker.example:19204'}},s=>{s.resume();s.on('end',()=>resolve(s.statusCode));});r.on('error',reject);r.end();}),403,'foreign Host');
 assert.equal((await fetch(base+'/api/status',{headers:{Origin:'https://attacker.example'}})).status,403,'foreign Origin');
 const lan=Object.values(os.networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&!i.internal);if(lan)assert.equal((await fetch('http://'+lan.address+':19204/api/status')).status,403,'LAN management');
 results.checks.push('Actual HTTP: absent write header, foreign Host/Origin and LAN administration rejected');
 const status=await fetch(base+'/api/status').then(r=>r.json());assert.equal(status.running,true);assert.equal(status.productVersion,'0.4.1');assert.ok(status.buildId?.startsWith('0.4.1'));assert.equal(status.logStorage.error,null);
 assert.match(await fetch(base+'/').then(r=>r.text()),/<html/i);
 assert.match(await fetch(base+'/upnp/device.xml').then(r=>r.text()),new RegExp(settings.udn));
 assert.ok((await fetch(base+'/upnp/device.xml').then(r=>r.text())).includes('<friendlyName>PT3 居間 &amp; 録画</friendlyName>'));
 const renamed=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-PT3-Management':'1'},body:JSON.stringify({friendlyName:'PT3 書斎'})}).then(r=>r.json());assert.equal(renamed.udn,settings.udn);assert.equal(renamed.friendlyName,'PT3 書斎');results.checks.push('Setup name / management rename / XML escaping, stable server UDN');
 const soap=object=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>${object}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>125</RequestedCount><SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`;
 const browse=object=>fetch(base+'/upnp/control/content-directory',{method:'POST',headers:{SOAPAction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"','Content-Type':'text/xml'},body:soap(object)}).then(r=>r.text());
 assert.match(await browse('0'),/録画番組/);
 const programs=await read(path.join(data,'programs.json'));assert.equal(programs.length,1);
 let rows;
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,200));const r=await run(node,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT id,probe_status FROM media ORDER BY id').all()));db.close();`,path.join(data,'experimental-catalog','media-index.sqlite')]).catch(()=>undefined);if(r){rows=JSON.parse(r.stdout);if(rows.length===4&&rows.every(v=>v.probe_status==='ready'))break;}}
 assert.equal(rows.length,4);assert.ok(rows.every(v=>v.probe_status==='ready'));results.checks.push('Japanese deep-root scan, SQLite 4 metadata entries, normal HTTP/UI/UPnP Browse');
 const all=await browse('all');assert.match(all,/試験/);
 assert.equal((await fetch(base+'/api/status').then(r=>r.json())).pcrCache.builds,0,'Initial indexing and Browse must not build PCR indexes');
 const resource=all.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&').replaceAll('&quot;','"').match(/<res\b[^>]*>([^<]+)<\/res>/);assert.ok(resource);
 const response=await fetch(resource[1],{headers:{'TimeSeekRange.dlna.org':'npt=1-2'}});assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>0);results.checks.push('Ordinary TS TimeSeek body, no JIT admission required');
 const pcr=await fetch(base+'/api/pcr-cache').then(r=>r.json());assert.equal(pcr.policy.maxDiskBytes,null);assert.equal(pcr.policy.readBytesPerSecond,32*1024**2);assert.ok(pcr.usage.bytes>0);
 assert.equal((await fetch(base+'/api/pcr-cache',{method:'POST',headers:{'content-type':'application/json','X-PT3-Management':'1'},body:JSON.stringify({paused:true})})).status,200);
 assert.match(await fetch(base+'/').then(r=>r.text()),/id="pcrForm"/);results.checks.push('PCR unlimited retention, 32MiB/s idle budget, management progress and pause API');
 const cacheAudit=JSON.parse((await run(node,[path.join(app,'audit-pcr-cache.mjs'),'--data',data])).stdout);
 assert.equal(cacheAudit.files,1);assert.equal(cacheAudit.temporary,0);assert.equal(cacheAudit.entries[0].sourceState,'matching');
 results.checks.push('Browse builds zero PCR indexes; first playback creates one; packaged read-only audit maps its original TS');
 // Original-file candidates must work without UDN/Sink or a REGZA JIT lease.
 const vlcBrowse=await fetch(base+'/upnp/control/content-directory',{method:'POST',headers:{SOAPAction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"','Content-Type':'text/xml','User-Agent':'Darwin UPnP/1.0 Portable SDK for UPnP devices/1.14.20'},body:soap('all')}).then(r=>r.text());
 const vlcDidl=vlcBrowse.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&').replaceAll('&quot;','"');
 const originals=[...vlcDidl.matchAll(/<item\b[^>]*>[\s\S]*?<dc:title>([^<]+)<\/dc:title>[\s\S]*?<res\b[^>]*>([^<]+)<\/res>[\s\S]*?<\/item>/g)].filter(m=>m[2].includes('/library/direct/'));
 assert.equal(originals.length,4);
 for(const [,name,url] of originals){
  const original=await fs.readFile(path.join(media,name));
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),original.length);
  const body=Buffer.from(await fetch(url).then(r=>r.arrayBuffer()));assert.deepEqual(body,original);
  const partial=await fetch(url,{headers:{Range:'bytes=100-999'}});assert.equal(partial.status,206);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),original.subarray(100,1000));
  const received=path.join(home,'direct-'+name);await fs.writeFile(received,body);
  await run(ffmpeg,['-hide_banner','-v','error','-xerror','-i',received,'-map','0:v:0','-map','0:a:0','-f','null','-']);
  // Real demuxer seeking over HTTP byte ranges; different media UA is allowed
  // only with the Browse-issued, same-address, source-scoped lease.
  await run(ffmpeg,['-hide_banner','-v','error','-xerror','-ss','2','-i',url,'-t','1','-map','0:v:0','-map','0:a:0','-f','null','-']);
 }
 assert.ok((await fetch(base+'/api/experimental/jit/status').then(r=>r.json())).every(s=>!s.active&&s.executors===0));
 results.checks.push('VLC/libupnp SOAP exposes four original resources; exact bytes, HEAD/206, AV decode, HTTP demuxer Seek, zero JIT executors');
 const addedTs=path.join(media,'自動追加.ts'),addedMp4=path.join(media,'自動追加.mp4');await fs.copyFile(path.join(media,'試験.ts'),addedTs);await fs.copyFile(path.join(media,'試験.mp4'),addedMp4);
 const activeCount=async()=>{const q=await run(node,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("SELECT count(*) n FROM media WHERE availability='available'").get().n);d.close();`,path.join(data,'experimental-catalog','media-index.sqlite')]);return Number(q.stdout);};
 const waitLibrary=async(ts,encoded)=>{for(let i=0;i<100;i++){const p=await read(path.join(data,'programs.json'));if(p.length===ts&&await activeCount()===encoded)return;await new Promise(r=>setTimeout(r,100));}throw Error('Automatic inventory update timed out');};
 await waitLibrary(2,5);await fs.unlink(addedTs);await fs.unlink(addedMp4);await waitLibrary(1,4);results.checks.push('Periodic TS and MP4 addition/removal without manual API scan');
 assert.equal((await fetch(base+'/api/status').then(r=>r.json())).pcrCache.builds,1,'Automatic scans must not index the newly added TS');
 await assert.rejects(ctl('start'));await assert.rejects(ctl('backup'));results.checks.push('Duplicate start and live snapshot rejected');
 await ctl('stop');
 const before=rows.map(v=>v.id);await ctl('backup','--to',path.join(home,'snapshot'));
 await ctl('start');await ctl('stop');
 const imported=path.join(home,'imported');await ctl('import','--data',imported,'--from',path.join(home,'snapshot'),'--source-stopped');
 assert.equal((await read(path.join(imported,'settings.json'))).udn,settings.udn);assert.equal((await read(path.join(imported,'pcr-cache-policy.json'))).paused,true);
 await ctl('setup','--data',imported,'--port','19204','--address','127.0.0.1','--no-ssdp');await ctl('start');await ctl('stop');
 const after=await run(node,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify(d.prepare("SELECT id FROM media WHERE availability='available' ORDER BY id").all().map(v=>v.id)));d.close();`,path.join(imported,'experimental-catalog','media-index.sqlite')]);assert.deepEqual(JSON.parse(after.stdout),before);
 results.checks.push('Restart, offline backup/import, UDN and catalog IDs retained');
 // Separate installed version, same state; rollback is an offline snapshot into a new directory.
 const v2=installation.alternate;
 await run(path.join(v2,'runtime','node.exe'),[path.join(v2,'control.mjs'),'setup','--data',imported,'--port','19204','--no-ssdp']);
 await run(path.join(v2,'runtime','node.exe'),[path.join(v2,'control.mjs'),'start']);await run(path.join(v2,'runtime','node.exe'),[path.join(v2,'control.mjs'),'stop']);
 assert.equal((await read(path.join(imported,'settings.json'))).udn,settings.udn);
 const independent=path.join(home,'independent');await ctl('import','--data',independent,'--from',path.join(home,'snapshot'),'--source-stopped','--new-identity');assert.notEqual((await read(path.join(independent,'settings.json'))).udn,settings.udn);
 results.checks.push('Version-directory switch without state loss; independent import regenerates UDN');
 const sf=path.join(imported,'settings.json'),goodSettings=await fs.readFile(sf);await fs.writeFile(sf,'{broken');await assert.rejects(ctl('setup','--data',imported));assert.equal(await fs.readFile(sf,'utf8'),'{broken');await fs.writeFile(sf,goodSettings);results.checks.push('Corrupt existing settings are refused without replacing UDN/configuration');
 const original=await fs.readFile(path.join(app,'README-ja.md'));await fs.appendFile(path.join(app,'README-ja.md'),'tamper');await assert.rejects(ctl('doctor'));await fs.writeFile(path.join(app,'README-ja.md'),original);results.checks.push('Corrupt package fails closed');
 results.passed=true;
}catch(e){results.error=String(e);process.exitCode=1;}
finally{await ctl('stop').catch(()=>{});await run(path.join(installation.alternate,'runtime/node.exe'),[path.join(installation.alternate,'control.mjs'),'stop','--data',path.join(home,'imported')],{cwd:installation.alternate}).catch(()=>{});await fs.writeFile(path.join(home,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({home,app,alternate:installation.alternate,passed:results.passed,checks:results.checks,error:results.error}));await installation.release();}
