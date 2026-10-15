import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('portable PCR audit reads only: source mapping, missing/unknown/temp entries and unchanged cache bytes/times',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-pcr-audit-')),data=path.join(root,'data'),cache=path.join(data,'pcr-cache'),source=path.join(root,'MixedCase.ts'),missing=path.join(root,'deleted.ts');await fs.mkdir(cache,{recursive:true});await fs.writeFile(source,'original');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const st=await fs.stat(source);await fs.writeFile(path.join(data,'programs.json'),JSON.stringify([{filePath:source},{filePath:missing}]));
 const name=(p:string)=>createHash('sha256').update(path.resolve(p)).digest('hex')+'.json';
 await fs.writeFile(path.join(cache,name(source)),JSON.stringify({version:1,key:`${st.size}:${st.mtimeMs}`,data:'do not parse whole index'}));
 await fs.writeFile(path.join(cache,name(missing)),JSON.stringify({version:1,key:'0:0',data:'null'}));
 await fs.writeFile(path.join(cache,'0'.repeat(64)+'.json'),JSON.stringify({version:1,key:'1:2',data:'null'}));
 await fs.writeFile(path.join(cache,'unfinished.tmp'),'temporary; must remain');
 const before=await Promise.all((await fs.readdir(cache)).map(async n=>({name:n,bytes:await fs.readFile(path.join(cache,n)),mtime:(await fs.stat(path.join(cache,n))).mtimeMs})));
 const out=path.join(root,'report.json');const result=await promisify(execFile)(process.execPath,['packaging/audit-pcr-cache.mjs','--data',data,'--out',out],{windowsHide:true});assert.equal(JSON.parse(result.stdout).files,4);
 const report=JSON.parse(await fs.readFile(out,'utf8'));assert.equal(report.temporary,1);assert.ok(report.entries.some((e:any)=>e.sourceState==='matching'));assert.ok(report.entries.some((e:any)=>e.sourceState==='missing'));assert.ok(report.entries.some((e:any)=>e.sourceState?.startsWith('not-in-current')));
 for(const f of before){assert.deepEqual(await fs.readFile(path.join(cache,f.name)),f.bytes);assert.equal((await fs.stat(path.join(cache,f.name))).mtimeMs,f.mtime);}
 assert.equal((await fs.readdir(cache)).length,4);assert.equal(await fs.readFile(source,'utf8'),'original');
});
