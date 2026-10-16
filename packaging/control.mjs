import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {externalFFmpeg}from'./external-ffmpeg.mjs';
import {DatabaseSync} from 'node:sqlite';
const root=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2),cmd=args.shift()??'status';
const option=(name,fallback)=>{const n=args.indexOf(name);return n<0?fallback:args[n+1];};
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2));await fs.rename(tmp,file);};
const exists=async p=>!!await fs.stat(p).catch(()=>false);
// Keep the legacy data directory so upgrades retain settings, UDN and catalog.
const defaultData=path.join(process.env.LOCALAPPDATA??os.homedir(),'PT3 Recording Server');
let config=await exists(path.join(root,'launcher.json'))?await json(path.join(root,'launcher.json')):{data:defaultData};
const data=path.resolve(option('--data',config.data)),lock=path.join(data,'portable-running.json');
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
async function state(){const l=await json(lock).catch(()=>undefined);return {lock:l,running:!!l&&alive(l.pid),data};}
async function offline(){const s=await state();if(s.running)throw Error('Stop this data directory before setup/import/backup.');await sourceOffline(data);if(s.lock)await fs.unlink(lock);}
async function sourceOffline(directory){
 const l=await json(path.join(directory,'portable-running.json')).catch(()=>undefined);if(l&&(!l.machine||l.machine===os.hostname())&&alive(l.pid))throw Error('Source DMS is running');
 const s=await json(path.join(directory,'settings.json')).catch(()=>undefined);if(!s)return;
 let reachable=false;try{await fetch('http://127.0.0.1:'+s.port+'/api/status',{signal:AbortSignal.timeout(700)});reachable=true;}catch{}
 if(reachable)throw Error('A DMS/HTTP listener is still reachable on the source port; snapshot refused. Stop the old DMS.');
}
async function integrity(directory){
 for(const dbFile of [path.join(directory,'experimental-catalog','media-index.sqlite'),path.join(directory,'pcr-cache.sqlite')])if(await exists(dbFile)){const db=new DatabaseSync(dbFile,{readOnly:true});try{const rows=db.prepare('PRAGMA quick_check').all();if(rows.some(r=>Object.values(r)[0]!=='ok'))throw Error('SQLite quick_check failed');}finally{db.close();}}
}
async function doctor(){
 const manifest=await json(path.join(root,'manifest.json'));
 for(const f of manifest.files){const b=await fs.readFile(path.join(root,f.path));if(createHash('sha256').update(b).digest('hex')!==f.sha256)throw Error('Package checksum mismatch: '+f.path);}
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Node 24+ required for node:sqlite');
 const external=await externalFFmpeg(root,config);
 const ff=execFileSync(external.ffmpeg,['-hide_banner','-encoders'],{encoding:'utf8',windowsHide:true});
 for(const e of ['libx264','mpeg2video','aac'])if(!new RegExp('\\b'+e+'\\b').test(ff))throw Error('Required encoder missing: '+e);
 execFileSync(external.ffprobe,['-version'],{stdio:'pipe',windowsHide:true});
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE probe(id INTEGER)');db.close();
 console.log(JSON.stringify({ok:true,node:process.version,release:manifest.release,data,ffmpeg:'user-managed-external',sqlite:true},null,2));
}
// Copy only application state, never recordings, symlinks, diagnostics or artifacts.
const stateFiles=['pcr-cache-policy.json','pcr-cache.sqlite','pcr-cache.sqlite-wal','pcr-cache.sqlite-shm','settings.json','programs.json','client-family-cache.json','playback-shadow/devices.json','playback-shadow/policy.json','experimental-catalog/jit.json','experimental-catalog/library.json','experimental-catalog/automatic.json','experimental-catalog/media-index.sqlite','experimental-catalog/media-index.sqlite-wal','experimental-catalog/media-index.sqlite-shm','experimental-catalog/client-family-bindings.json'];
async function copyState(from,to){
 await sourceOffline(from);
 await integrity(from);
 for(const relative of stateFiles){const source=path.join(from,relative);if(!await exists(source))continue;const st=await fs.lstat(source);if(!st.isFile()||st.isSymbolicLink())throw Error('Not a regular state file: '+relative);await fs.mkdir(path.dirname(path.join(to,relative)),{recursive:true});await fs.copyFile(source,path.join(to,relative),fs.constants.COPYFILE_EXCL);}
 const eit=path.join(from,'eit-cache');
 if(await exists(eit)){
  const st=await fs.lstat(eit);if(!st.isDirectory()||st.isSymbolicLink())throw Error('EIT metadata directory must be a regular directory');
  for(const entry of await fs.readdir(eit,{withFileTypes:true})){
   if(!/^[a-f0-9]{64}\.json$/i.test(entry.name))continue;
   const file=path.join(eit,entry.name),s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('EIT metadata must be a regular file');if(s.size>65536)continue;
   await fs.mkdir(path.join(to,'eit-cache'),{recursive:true});await fs.copyFile(file,path.join(to,'eit-cache',entry.name),fs.constants.COPYFILE_EXCL);
  }
 }
 await integrity(to);
}
try{
 if(cmd==='ffmpeg'){await offline();const external=await externalFFmpeg(root,{ffmpegDirectory:option('--directory')});config={...config,ffmpegDirectory:external.directory};await write(path.join(root,'launcher.json'),config);console.log('FFmpeg configured: '+external.version);}
 else if(cmd==='doctor')await doctor();
 else if(cmd==='status'){const s=await state();console.log(JSON.stringify(s,null,2));}
 else if(cmd==='setup'){
  await offline();await doctor();
  if(data.startsWith('\\\\'))throw Error('SQLite/application data must be local, not a UNC share; recording roots may use UNC');
  const appRelative=path.relative(root,data);if(appRelative===''||(!appRelative.startsWith('..')&&!path.isAbsolute(appRelative)))throw Error('Keep application data outside the package directory');
  const sf=path.join(data,'settings.json'),old=await exists(sf)?await json(sf):undefined;
  const name=option('--name',old?.friendlyName??'DLNA Video Server').trim();if(!name||name.length>128||/[\x00-\x1f\x7f]/.test(name))throw Error('Server name must be 1..128 characters without control characters');
  const scanSeconds=option('--scan-seconds');if(scanSeconds!==undefined&&(!Number.isInteger(Number(scanSeconds))||Number(scanSeconds)<30||Number(scanSeconds)>86400))throw Error('Refresh interval must be 30..86400 seconds');
  const port=Number(option('--port',old?.port??19090));if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Port must be 1024..65535');
  const selectedAddress=option('--address',old?.interfaceAddress??''),address=selectedAddress==='auto'?'':selectedAddress;if(address&&!Object.values(os.networkInterfaces()).flat().some(i=>i?.address===address&&i.family==='IPv4'))throw Error('Selected address is not a local IPv4 address');
  const folders=option('--folders')?.split('|').filter(Boolean)??old?.folders??[];
  if(!folders.length)throw Error('Specify at least one recording root with --folders (separate multiple roots using |)');
  for(const folder of folders){if(!path.isAbsolute(folder)||(await fs.stat(folder)).isDirectory()!==true)throw Error('Recording root is not an accessible absolute directory: '+folder);const relative=path.relative(folder,data);if(relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative)))throw Error('Application data must be outside recording roots');}
  if(old&&JSON.stringify(old.folders)!==JSON.stringify(folders))throw Error('Change migrated recording roots in the management UI after backup; path changes may create new catalog IDs.');
  await write(sf,{profile:'regza-zp2-buffered',udn:'uuid:'+randomUUID(),...old,friendlyName:name,port,interfaceAddress:address,folders});
  for(const name of ['jit.json','library.json','automatic.json']){const target=path.join(data,'experimental-catalog',name);if(!await exists(target))await write(target,await json(path.join(root,'defaults',name)));}
  if(scanSeconds!==undefined){const file=path.join(data,'experimental-catalog','automatic.json');await write(file,{...await json(file),scanIntervalMs:Number(scanSeconds)*1000});}
  await write(path.join(root,'launcher.json'),{...config,data,disableSsdp:args.includes('--no-ssdp')});
  console.log('Setup complete. Start, then open http://localhost:'+port);
 }
 else if(cmd==='start'){
  if(data!==path.resolve(config.data))throw Error('Run setup to select a different data directory before start');
  await offline();await doctor();
  if(!await exists(path.join(root,'launcher.json')))throw Error('Run setup first');
  await fs.mkdir(path.join(data,'logs'),{recursive:true});
  const out=await fs.open(path.join(data,'logs','launcher-'+Date.now()+'.log'),'a');
  const child=spawn(process.execPath,[path.join(root,'launch.mjs')],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out.fd,out.fd]});child.unref();await out.close();
  const settings=await json(path.join(data,'settings.json'));
  for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,200));const s=await state();if(s.running&&s.lock.pid===child.pid){try{const status=await fetch('http://127.0.0.1:'+settings.port+'/api/status',{signal:AbortSignal.timeout(500)}).then(r=>r.json());if(status.running&&status.logStorage?.error==null){console.log('Started: http://localhost:'+settings.port);process.exit(0);}}catch{}}if(!alive(child.pid))throw Error('Startup failed; see data/logs/launcher-*.log');}
  throw Error('Startup timed out; inspect status/logs. No automatic process termination.');
 }
 else if(cmd==='stop'){
  const s=await state();if(s.running){await write(path.join(data,'portable-stop.json'),{token:s.lock.token});for(let n=0;n<300&&alive(s.lock.pid);n++)await new Promise(r=>setTimeout(r,200));if(alive(s.lock.pid))throw Error('Graceful stop timed out; not force-killed.');}await offline();console.log('Stopped');
 }
 else if(cmd==='backup'){
  await offline();const to=path.resolve(option('--to',path.join(path.dirname(data),'PT3-backup-'+Date.now())));await fs.mkdir(to,{recursive:false});await copyState(data,to);console.log(to);
 }
 else if(cmd==='import'){
  await offline();if(await exists(path.join(data,'settings.json')))throw Error('Import destination must be new/empty');
  const from=path.resolve(option('--from',''));if(from===data)throw Error('Source equals destination');
  const sourceSettings=await json(path.join(from,'settings.json'));
  // A developer server may have no portable lock. Require explicit offline acknowledgement,
  // and refuse a locally running HTTP instance on its configured port as well.
  if(!args.includes('--source-stopped'))throw Error('Stop old DMS first and supply --source-stopped');
  await sourceOffline(from);
  await fs.mkdir(data,{recursive:true});await copyState(from,data);
  const s=await json(path.join(data,'settings.json'));if(args.includes('--new-identity'))s.udn='uuid:'+randomUUID();s.interfaceAddress='';await write(path.join(data,'settings.json'),s);
  // Cached URLs/identity observations must be renewed on the destination network.
  for(const file of ['client-family-cache.json','experimental-catalog/client-family-bindings.json'])await fs.unlink(path.join(data,file)).catch(()=>{});
  console.log('Imported. Old DMS must remain stopped when preserving UDN. Run setup for new port/address. Recording paths are unchanged.');
 }
 else throw Error('Commands: setup, doctor, start, stop, status, backup --to DIR, import --from DIR --source-stopped [--new-identity]');
}catch(e){console.error(String(e));process.exitCode=1;}
