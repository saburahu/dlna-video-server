import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'dlna-defaults-'));t.after(async()=>{assert.equal(path.dirname(home),os.tmpdir());assert.ok(path.basename(home).startsWith('dlna-defaults-'));await fs.rm(home,{recursive:true,force:true});});const app=path.join(home,'日本語 空白'),local=path.join(home,'Local AppData');await fs.mkdir(app);await fs.mkdir(local);return {home,app,local,env:{...process.env,LOCALAPPDATA:local}};}
test('portable default uses new data directory; explicit and saved directories take precedence without legacy migration',async t=>{
 const f=await fixture(t);await fs.copyFile('packaging/control.mjs',path.join(f.app,'control.mjs'));if(await fs.stat('packaging/external-ffmpeg.mjs').catch(()=>false))await fs.copyFile('packaging/external-ffmpeg.mjs',path.join(f.app,'external-ffmpeg.mjs'));
 const legacy=path.join(f.local,'PT3 Recording Server');await fs.mkdir(legacy);await fs.writeFile(path.join(legacy,'settings.json'),'synthetic legacy sentinel');
 const status=async(...args)=>JSON.parse((await exec(process.execPath,[path.join(f.app,'control.mjs'),'status',...args],{env:f.env,windowsHide:true})).stdout);
 assert.equal((await status()).data,path.join(f.local,'DLNA Video Server'));
 const custom=path.join(f.home,'Custom data');await fs.writeFile(path.join(f.app,'launcher.json'),JSON.stringify({data:custom}));assert.equal((await status()).data,custom);assert.equal((await status('--data',legacy)).data,legacy);
 assert.deepEqual(await fs.readdir(f.local),['PT3 Recording Server']);assert.equal(await fs.readFile(path.join(legacy,'settings.json'),'utf8'),'synthetic legacy sentinel');
});
test('real CMD blank Setup selects new default or saved custom directory, and autostart plan uses new product name',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.app,'runtime'));await fs.copyFile(process.execPath,path.join(f.app,'runtime/node.exe'));await fs.copyFile('packaging/Setup.cmd',path.join(f.app,'Setup.cmd'));await fs.copyFile('packaging/autostart.ps1',path.join(f.app,'autostart.ps1'));
 await fs.writeFile(path.join(f.app,'control.mjs'),"import fs from 'node:fs';fs.appendFileSync('calls.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');");
 const source=await fs.readFile('packaging/setup.ps1','utf8');await fs.writeFile(path.join(f.app,'setup.ps1'),'\ufeff'+source.replace(/(param\([^\n]+\)\r?\n)/,"$1function Read-Host { param($Prompt) return '' }\nfunction Get-NetIPAddress { return @() }\n"));
 await fs.writeFile(path.join(f.app,'answers.txt'),'\r\n');await fs.writeFile(path.join(f.app,'run.cmd'),'@echo off\r\ncall Setup.cmd -NoStart < answers.txt\r\nexit /b %ERRORLEVEL%\r\n');
 for(const saved of [undefined,path.join(f.home,'Custom data')]){
  if(saved)await fs.writeFile(path.join(f.app,'launcher.json'),JSON.stringify({data:saved,ffmpegDirectory:f.home}));await fs.writeFile(path.join(f.app,'calls.jsonl'),'');
  await exec('cmd.exe',['/d','/c','run.cmd'],{cwd:f.app,env:f.env,windowsHide:true,timeout:30000});const calls=(await fs.readFile(path.join(f.app,'calls.jsonl'),'utf8')).trim().split(/\r?\n/).map(JSON.parse),setup=calls.find(c=>c[0]==='setup');assert.equal(setup[setup.indexOf('--data')+1],saved??path.join(f.local,'DLNA Video Server'));assert.ok(!setup.includes('--name'),'blank name delegates to saved/default name in control');
 }
 const plan=JSON.parse((await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(f.app,'autostart.ps1'),'-DataDirectory',path.join(f.home,'Custom data'),'-PlanOnly'],{env:f.env,windowsHide:true})).stdout);assert.match(plan.Name,/^DLNA Video Server [a-f\d]{12}$/i);assert.equal(path.basename(plan.StartupFallback),plan.Name+'.lnk');
});
