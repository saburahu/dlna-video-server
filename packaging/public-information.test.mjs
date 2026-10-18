import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('Public information audit preserves REGZA branding and rejects personal-style records',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dlna-public-information-'));
 try{
  await fs.mkdir(path.join(directory,'tools'));
  await fs.copyFile(fileURLToPath(new URL('../tools/audit-public.mjs',import.meta.url)),path.join(directory,'tools/audit-public.mjs'));
  await fs.writeFile(path.join(directory,'publication-manifest.json'),JSON.stringify({files:['README.md','publication-manifest.json','tools/audit-public.mjs']}));
  const audit=()=>{const result=spawnSync(process.execPath,[path.join(directory,'tools/audit-public.mjs')],{cwd:directory,encoding:'utf8',windowsHide:true});return {status:result.status,...JSON.parse(result.stdout)};};
  await fs.writeFile(path.join(directory,'README.md'),'REGZA向け互換性を重視。メーカー公式ではありません。全機種保証はありません。');
  assert.equal(audit().passed,true);
  await fs.writeFile(path.join(directory,'README.md'),'試験端末: DBR-'+ 'TEST123');
  assert.ok(audit().findings.some(f=>f.rule==='receiver-model-in-public-document-needs-review'));
  await fs.writeFile(path.join(directory,'README.md'),'操作記録: 2020-01-01T12:34:56Z');
  assert.ok(audit().findings.some(f=>f.rule==='operation-timestamp-in-public-document'));
  await fs.writeFile(path.join(directory,'README.md'),'ローカル: C:'+ '\\Users\\synthetic-person\\recordings');
  assert.ok(audit().findings.some(f=>f.rule==='user-home-path'));
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
