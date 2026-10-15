import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
const exec=promisify(execFile);
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-distribution-test-')),data=path.join(root,'state'),app=path.join(root,'application');await fs.mkdir(app);await fs.mkdir(path.join(data,'experimental-catalog'),{recursive:true});
 await fs.copyFile('packaging/control.mjs',path.join(app,'control.mjs'));await fs.copyFile('packaging/external-ffmpeg.mjs',path.join(app,'external-ffmpeg.mjs'));
 const settings={udn:'uuid:test-old-server',folders:[],port:65520,interfaceAddress:'192.0.2.10'};await fs.writeFile(path.join(data,'settings.json'),JSON.stringify(settings));
 const db=new DatabaseSync(path.join(data,'experimental-catalog','media-index.sqlite'));db.exec("CREATE TABLE media(id TEXT PRIMARY KEY); INSERT INTO media VALUES('stable-media-id')");db.close();
 const run=(...args:string[])=>exec(process.execPath,[path.join(app,'control.mjs'),...args],{cwd:app,windowsHide:true});
 return {root,data,app,run,settings};
}
test('portable snapshot/import retains closed SQLite and UDN; independent clone replaces UDN, excludes media and stale bindings',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.data,'private-recording.mkv'),'must not copy');
  await fs.mkdir(path.join(f.data,'eit-cache'));const eit='a'.repeat(64)+'.json';await fs.writeFile(path.join(f.data,'eit-cache',eit),'small confirmed event metadata');
  await fs.writeFile(path.join(f.data,'client-family-cache.json'),'{}');
  await fs.writeFile(path.join(f.data,'experimental-catalog','client-family-bindings.json'),'{}');
  const backup=path.join(f.root,'backup');await f.run('backup','--data',f.data,'--to',backup);
  assert.equal(await fs.stat(path.join(backup,'private-recording.mkv')).catch(()=>undefined),undefined);
  const dest=path.join(f.root,'import');await f.run('import','--data',dest,'--from',backup,'--source-stopped');
  const s=JSON.parse(await fs.readFile(path.join(dest,'settings.json'),'utf8'));assert.equal(s.udn,f.settings.udn);assert.equal(s.interfaceAddress,'');
  assert.equal(await fs.readFile(path.join(dest,'eit-cache',eit),'utf8'),'small confirmed event metadata');
  const db=new DatabaseSync(path.join(dest,'experimental-catalog','media-index.sqlite'));assert.equal(db.prepare('SELECT id FROM media').get()!.id,'stable-media-id');db.close();
  assert.equal(await fs.stat(path.join(dest,'client-family-cache.json')).catch(()=>undefined),undefined);
  await assert.rejects(f.run('import','--data',dest,'--from',backup,'--source-stopped'),/destination must be new/);
  const independent=path.join(f.root,'independent');await f.run('import','--data',independent,'--from',backup,'--source-stopped','--new-identity');assert.notEqual(JSON.parse(await fs.readFile(path.join(independent,'settings.json'),'utf8')).udn,s.udn);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('portable snapshot rejects live lock and reachable legacy HTTP DMS; import requires offline acknowledgement',async()=>{
 const f=await fixture(),server=createServer((_req,res)=>res.end('{}'));
 try{
  await fs.writeFile(path.join(f.data,'portable-running.json'),JSON.stringify({pid:process.pid,token:'test'}));
  await assert.rejects(f.run('backup','--data',f.data,'--to',path.join(f.root,'bad')),/Stop this data directory/);
  await fs.unlink(path.join(f.data,'portable-running.json'));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));await fs.writeFile(path.join(f.data,'settings.json'),JSON.stringify({...f.settings,port:(server.address() as {port:number}).port}));
  await assert.rejects(f.run('backup','--data',f.data,'--to',path.join(f.root,'live')),/snapshot refused/);
  const originalSettings=await fs.readFile(path.join(f.data,'settings.json'),'utf8');
  await assert.rejects(f.run('setup','--data',f.data),/snapshot refused/);
  assert.equal(await fs.readFile(path.join(f.data,'settings.json'),'utf8'),originalSettings);
  await assert.rejects(f.run('import','--data',path.join(f.root,'dest'),'--from',f.data),/source-stopped/);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(f.root,{recursive:true,force:true});}
});
test('portable snapshot refuses a corrupt SQLite source before copying configuration',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.data,'experimental-catalog','media-index.sqlite'),'broken database');
  await assert.rejects(f.run('backup','--data',f.data,'--to',path.join(f.root,'bad')));
  assert.equal(await fs.stat(path.join(f.root,'bad','settings.json')).catch(()=>undefined),undefined);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('portable control refuses a corrupt launcher instead of silently selecting another data directory',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.app,'launcher.json'),'{broken');
  await assert.rejects(f.run('status'));
  assert.equal(await fs.readFile(path.join(f.app,'launcher.json'),'utf8'),'{broken');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.data,'settings.json'),'utf8')).udn,f.settings.udn);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
