import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('new brand defaults without changing stored DLNA name or UDN',async()=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'dlna-brand-'));
 try{
  const run=()=>exec(process.execPath,['--import','tsx','--input-type=module','-e',`import {loadStore,settings} from './src/store.ts';import {deviceXml} from './src/upnp.ts';await loadStore();console.log(JSON.stringify({settings,xml:deviceXml('http://127.0.0.1:19090')}));`],{env:{...process.env,PT3_DATA_DIR:data},windowsHide:true});
  const fresh=JSON.parse((await run()).stdout);assert.equal(fresh.settings.friendlyName,'DLNA Video Server');assert.match(fresh.xml,/<modelName>DLNA Video Server<\/modelName>/);
  for(const friendlyName of ['PT3 (Synthetic legacy)','Custom & server']){
   const stored={...fresh.settings,friendlyName};await fs.writeFile(path.join(data,'settings.json'),JSON.stringify(stored));
   const updated=JSON.parse((await run()).stdout);assert.deepEqual(updated.settings,stored);assert.ok(updated.xml.includes(stored.udn));assert.ok(updated.xml.includes(friendlyName.replaceAll('&','&amp;')));
  }
 }finally{assert.equal(path.dirname(data),os.tmpdir());assert.ok(path.basename(data).startsWith('dlna-brand-'));await fs.rm(data,{recursive:true,force:true});}
});
