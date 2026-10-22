// Test harness only. Product installation paths and security policy are untouched.
import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import{randomUUID}from'node:crypto';
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return true;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
export async function prepareTestInstallation(input,edition){
 assert.ok(['private','public'].includes(edition));
 const base=path.resolve(process.env.DLNA_TEST_INSTALL_ROOT??path.join(os.tmpdir(),'DLNA-Video-Server-repeat-tests'),edition);
 await fs.mkdir(base,{recursive:true});assert.equal((await fs.lstat(base)).isSymbolicLink(),false);
 // Both editions use the legacy verification HTTP port, so serialize their
 // smoke tests as well as protecting each fixed executable path.
 const lock=path.join(path.dirname(base),'http-19204-test-session.json'),token=randomUUID();
 let handle;try{handle=await fs.open(lock,'wx');}catch(error){
  if(error.code!=='EEXIST')throw error;const previous=await read(lock);assert.equal(alive(previous.pid),false,'Another test session owns the stable installation');
  await fs.rename(lock,path.join(base,'stale-session-'+randomUUID()+'.json'));handle=await fs.open(lock,'wx');
 }
 await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.close();
 const release=async()=>{const current=await read(lock).catch(()=>undefined);if(current?.token===token&&current.pid===process.pid)await fs.unlink(lock);};
 try{
  const runs=path.join(base,'runs');await fs.mkdir(runs,{recursive:true});
  for(const name of['current','alternate']){
   const app=path.resolve(base,name);assert.equal(path.dirname(app),base);assert.ok(app.startsWith(base+path.sep));
   const stat=await fs.lstat(app).catch(()=>undefined);if(stat){assert.equal(stat.isSymbolicLink(),false);const config=await read(path.join(app,'launcher.json')).catch(()=>undefined);
    if(config?.data){const data=path.resolve(config.data);assert.ok(data.startsWith(runs+path.sep),'Refuse a test installation referring to external/live data');
     const running=await read(path.join(data,'portable-running.json')).catch(()=>undefined);if(running)assert.equal(alive(running.pid),false,'Previous test server is still active');
    }
    // Both absolute targets are checked against the dedicated test root first.
    await fs.rm(app,{recursive:true,force:true});
   }
   await fs.cp(path.resolve(input),app,{recursive:true});
  }
  const home=await fs.mkdtemp(path.join(runs,'run-'));
  return {base,home,app:path.join(base,'current'),alternate:path.join(base,'alternate'),release};
 }catch(error){await release();throw error;}
}
