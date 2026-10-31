import {promises as fs} from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
const [mode,treeArg,outputArg,label,scenario='warm',repeatArg='3']=process.argv.slice(2);
if(!treeArg||!outputArg)throw Error('Usage: node --import tsx tools/benchmark-startup.mjs prepare|prepare-pcr|run SOURCE_TREE ISOLATED_OUTPUT [LABEL] [warm|empty|missing|corrupt|fresh|pcrwarm] [REPEATS]');
const here=path.resolve(outputArg),tools=path.dirname(fileURLToPath(import.meta.url)),tree=path.resolve(treeArg),root=path.join(here,'fixture'),media=path.join(root,'media'),count=5000;
const hash=s=>createHash('sha256').update(s).digest('hex');const {syntheticTs}=await import(pathToFileURL(path.join(tree,'test/ts-fixture.ts')));const {virtualId}=await import(pathToFileURL(path.join(tree,'src/virtual-folders.ts')));
if(mode==='prepare'){
 await fs.mkdir(media,{recursive:true});await fs.mkdir(path.join(root,'cache'),{recursive:true});const bytes=syntheticTs(200,5000),catalog=[];
 for(let i=0;i<count;i++){const filePath=path.join(media,String(i).padStart(4,'0')+'.ts');await fs.writeFile(filePath,bytes);await fs.utimes(filePath,1700000000,1700000000);const s=await fs.stat(filePath),b=await fs.stat(filePath,{bigint:true});const identity=`${b.dev}:${b.ino}:${b.birthtimeNs}`,metadata={state:'no-eit',reason:'synthetic-cache',scannedAt:'2026-01-01T00:00:00.000Z'};
  catalog.push({id:i.toString(16),filePath,title:`Synthetic ${i}`,size:s.size,modified:s.mtime.toISOString(),published:true,analysis:'ok'});
  await fs.writeFile(path.join(root,'cache',hash(identity)+'.json'),JSON.stringify({version:2,source:filePath,identity,size:s.size,mtimeMs:s.mtimeMs,metadata,sha256:hash(JSON.stringify(metadata))}));
 }await fs.writeFile(path.join(root,'catalog.json'),JSON.stringify(catalog));console.log('prepared',count);process.exit(0);
}
if(mode==='prepare-pcr'){
 process.env.PT3_DATA_DIR=path.join(root,'pcr-preparation');
 const {buildPcrIndex}=await import(pathToFileURL(path.join(tree,'src/pcr-index.ts'))),{sourcePathKey}=await import(pathToFileURL(path.join(tree,'src/library-discovery.ts')));
 const catalog=JSON.parse(await fs.readFile(path.join(root,'catalog.json'),'utf8'));assert.ok(await buildPcrIndex(catalog[0].filePath));
 const cache=path.join(process.env.PT3_DATA_DIR,'pcr-cache'),sample=JSON.parse(await fs.readFile(path.join(cache,(await fs.readdir(cache))[0]),'utf8'));await fs.mkdir(path.join(root,'pcr'),{recursive:true});
 for(const p of catalog){const st=await fs.stat(p.filePath);await fs.writeFile(path.join(root,'pcr',hash(sourcePathKey(p.filePath))+'.json'),JSON.stringify({...sample,key:`${st.size}:${st.mtimeMs}`,source:p.filePath}));}
 console.log('prepared 5000 valid PCR cache records for identical synthetic streams');process.exit(0);
}
assert.equal(mode,'run');const results=[];
for(let run=0;run<Number(repeatArg);run++){
 const runDir=path.join(here,`${label}-${scenario}${scenario==='pcrwarm'?'':'-'+run}`),data=path.join(runDir,'data');await fs.mkdir(data,{recursive:true});
 const saved=scenario==='pcrwarm'&&await fs.stat(path.join(data,'pcr-cache')).then(s=>s.isDirectory()).catch(()=>false)&&await fs.stat(path.join(data,'eit-cache')).then(s=>s.isDirectory()).catch(()=>false);
 if(scenario!=='pcrwarm'||!saved)await fs.cp(path.join(root,'cache'),path.join(data,'eit-cache'),{recursive:true});
 if(scenario==='pcrwarm'){
  if(!saved)await fs.cp(path.join(root,'pcr'),path.join(data,'pcr-cache'),{recursive:true});
  // Isolate saved-cache work from background generation; use the same cache
  // directory on all restarts. Other scenarios exercise the default policy.
  await fs.writeFile(path.join(data,'pcr-cache-policy.json'),JSON.stringify({paused:true}));
 }
 const names=(await fs.readdir(path.join(data,'eit-cache'))).sort();if(scenario==='empty'||scenario==='fresh')for(const name of names)await fs.unlink(path.join(data,'eit-cache',name));
 if(scenario==='missing'||scenario==='corrupt')for(const name of names.slice(0,500)){const file=path.join(data,'eit-cache',name);if(scenario==='missing')await fs.unlink(file);else await fs.writeFile(file,'{broken');}
 if(scenario!=='fresh')await fs.copyFile(path.join(root,'catalog.json'),path.join(data,'programs.json'));await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({friendlyName:'Isolated startup benchmark',port:0,folders:[media],interfaceAddress:'127.0.0.1',profile:'regza-zp2-192-paced-ats-minus-500ms',udn:'uuid:synthetic-startup-benchmark',contentPacketProgramIds:['fa0'],timeSeekProgramIds:['fa0']}));
 const start=performance.now(),profiles=[];let output='',errors='',inventoryResolve;const inventory=new Promise(r=>inventoryResolve=r);
 const child=spawn(process.execPath,['--import','tsx','--import',pathToFileURL(path.join(tools,'startup-observer.mjs')).href,'src/server.ts'],{cwd:tree,env:{...process.env,PT3_DATA_DIR:data,PT3_LOG_DIR:path.join(runDir,'logs'),PT3_DISABLE_SSDP:'1',PT3_BIND_LOOPBACK:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup watchdog 180s')),180000);child.stdout.on('data',b=>{output+=b;const m=/http:\/\/localhost:(\d+)/.exec(output);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1])}});child.once('error',reject);child.once('exit',c=>{clearTimeout(timer);if(c!==null&&c!==0)reject(Error('child exit '+c+errors))})});
 let pending='';child.stderr.on('data',b=>{errors+=b;pending+=b;const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line.startsWith('STARTUP_PROFILE ')){const p=JSON.parse(line.slice(16));profiles.push(p);if(p.phase==='inventory-ready')inventoryResolve(p)}});
 try{
  const base=await ready,listenMs=performance.now()-start;const t=performance.now();let status=await (await fetch(base+'/api/status')).json();const initialProgramCount=status.programCount;
  if(scenario==='fresh'){await inventory;status=await (await fetch(base+'/api/status')).json();}
  const apiMs=performance.now()-t;assert.equal(status.programCount,count);assert.equal(status.pcrCache.builds,0);
  const soap=async(id,metadata=false)=>{const r=await fetch(base+'/upnp/control/content-directory',{method:'POST',headers:{soapaction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'},body:`<ObjectID>${id}</ObjectID><BrowseFlag>${metadata?'BrowseMetadata':'BrowseDirectChildren'}</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>25</RequestedCount>`});assert.equal(r.status,200);return r.text()};
  const tb=performance.now(),browse=await soap(virtualId('all','media',4000,1000)),firstBrowseMs=performance.now()-start,browseMs=performance.now()-tb;assert.match(browse,/<NumberReturned>25<\/NumberReturned>/);assert.match(browse,/<TotalMatches>1000<\/TotalMatches>/);
  const freshPrograms=scenario==='fresh'?await (await fetch(base+'/api/programs')).json():undefined,metadataId=freshPrograms?freshPrograms[4000].id:'fa0';
  const metadata=await soap('item:'+metadataId,true);assert.ok(metadata.includes(metadataId));assert.match(metadata,/<NumberReturned>1<\/NumberReturned>/);const inv=await Promise.race([inventory,new Promise((_,reject)=>{const x=setTimeout(()=>reject(Error('inventory watchdog')),90000);x.unref()})]);
  let pcrInventoryMs,pcrInventoryFiles,pcrPlayback;
  if(scenario==='pcrwarm'){
   const manager=await (await fetch(base+'/api/pcr-cache')).json();pcrInventoryMs=performance.now()-start;pcrInventoryFiles=manager.initialInventoryFiles;assert.equal(pcrInventoryFiles,count);
   // SOAP Result and the embedded DIDL resource text are distinct XML layers.
   const decode=s=>s.replace(/&(amp|lt|gt|quot|apos);/g,(_,k)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[k]));
   const didl=decode(/<Result>([\s\S]*?)<\/Result>/.exec(metadata)[1]),resource=decode(/<res\b[^>]*>([^<]+)<\/res>/.exec(didl)?.[1]);assert.ok(resource);
   const r=await fetch(resource,{headers:{'TimeSeekRange.dlna.org':'npt=0-0.01'}});assert.equal(r.status,200);const n=(await r.arrayBuffer()).byteLength;assert.ok(n>0);
   const stats=(await (await fetch(base+'/api/status')).json()).pcrCache;assert.equal(stats.builds,0);assert.ok(stats.diskHits>=1);pcrPlayback={bytes:n,stats};
  }
  const final=await (await fetch(base+'/api/programs')).json();if(scenario==='warm'||scenario==='pcrwarm')assert.equal(final.filter(p=>p.metadata?.state==='no-eit').length,count);await fs.writeFile(path.join(runDir,'programs-result.json'),JSON.stringify(final));
  const canonical=browse.replaceAll(base,'http://BENCHMARK').replace(/<UpdateID>\d+<\/UpdateID>/g,'<UpdateID>EPOCH</UpdateID>');
  results.push({run,label,scenario,listenMs,initialProgramCount,apiMs,firstBrowseMs,browseMs,inventoryElapsedMs:inv.elapsedMs,pcrInventoryMs,pcrInventoryFiles,pcrPlayback,browseHash:hash(canonical),metadata:metadata.replaceAll(base,'http://BENCHMARK'),count:status.programCount,profiles});
 }finally{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r)});await fs.writeFile(path.join(runDir,`stdout-${run}.log`),output);await fs.writeFile(path.join(runDir,`stderr-${run}.log`),errors)}
 await fs.writeFile(path.join(here,`${label}-${scenario}.json`),JSON.stringify(results,null,2));console.log(label,scenario,run,results.at(-1)?.listenMs);
}
