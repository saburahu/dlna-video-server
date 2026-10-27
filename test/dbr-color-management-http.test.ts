import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('Production management/UPnP handlers keep trial private, enforce CSRF and preserve existing MPEG2 route', {timeout:30000},async t=>{
 const project=process.cwd(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'dbr-management-http-')),runner=path.join(dir,'server-loopback.ts');
 // Test-only binding substitution: all production handler code/imports are retained.
 const original=await fs.readFile(path.join(project,'src/server.ts'),'utf8');assert.ok(original.includes('"0.0.0.0"'));
 const source=original.replace('"0.0.0.0"','"127.0.0.1"').replace(/const root = [^;]+;/,'const root = '+JSON.stringify(project)+';').replace(/from\s*(["'])(\.\/[^"']+)\1/g,(_m,_q,s)=>'from '+JSON.stringify(pathToFileURL(path.resolve(project,'src',s)).href));
 await fs.writeFile(runner,source);await fs.writeFile(path.join(dir,'package.json'),'{"type":"module"}');await fs.writeFile(path.join(dir,'settings.json'),JSON.stringify({port:0,interfaceAddress:'127.0.0.1',folders:[],profile:'standard',udn:'uuid:synthetic-trial-server'}));
 const child=spawn(process.execPath,['--import','tsx',runner],{cwd:project,env:{...process.env,PT3_DATA_DIR:dir,PT3_LOG_DIR:path.join(dir,'logs'),PT3_EXPERIMENTAL_CATALOG_DIR:path.join(dir,'experimental-catalog'),PT3_DISABLE_SSDP:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout!.on('data',b=>output+=b);child.stderr!.on('data',b=>output+=b);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
 let base='';for(let i=0;i<300;i++){const m=/管理画面: http:\/\/localhost:(\d+)/.exec(output);if(m){base='http://127.0.0.1:'+m[1];break;}assert.equal(child.exitCode,null,output);await new Promise(r=>setTimeout(r,30));}assert.ok(base,output);
 const get=(p:string)=>fetch(base+p),post=(body:unknown,headers:Record<string,string>={})=>fetch(base+'/api/dbr-color-trial',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 assert.match(await(await get('/')).text(),/id="dbrColor"/);assert.equal((await get('/dbr-color-trial.js')).status,200);const state=await(await get('/api/dbr-color-trial')).json();assert.equal(state.phase,'idle');assert.equal(state.publication,undefined);assert.deepEqual((await(await get('/api/dbr-color-trial?q=empty')).json()).sources,[]);
 assert.equal((await post({action:'cancel',revision:state.revision})).status,403);assert.equal((await post({}, {'x-pt3-management':'1',origin:'http://foreign.invalid'})).status,403);assert.equal((await post({action:'publish',revision:state.revision,riskAcknowledged:true},{'x-pt3-management':'1'})).status,409);assert.equal((await post({action:'cancel',revision:state.revision},{'x-pt3-management':'1'})).status,200);
 assert.equal((await get('/dbr-color-trial/media/'+'a'.repeat(48))).status,404);assert.equal((await get('/mpeg-ts-trial/media/00000000-0000-4000-8000-000000000000')).status,404);
 const soap=await fetch(base+'/upnp/control/content-directory',{method:'POST',headers:{SOAPAction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'},body:'<ObjectID>0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>200</RequestedCount>'});assert.equal(soap.status,200);assert.ok(!(await soap.text()).includes('dbr-color-trial'));assert.equal((await(await get('/api/dbr-color-trial')).json()).phase,'idle');
});
