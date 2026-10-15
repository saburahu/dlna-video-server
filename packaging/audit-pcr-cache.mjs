// Read-only cache/source audit. Only an explicitly requested report is written.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const option=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const app=path.dirname(fileURLToPath(import.meta.url));
const launcher=JSON.parse(await fs.readFile(path.join(app,'launcher.json'),'utf8').catch(()=>'{}'));
const data=path.resolve(option('--data')??launcher.data??path.join(process.env.LOCALAPPDATA??os.homedir(),'PT3 Recording Server'));
const directory=path.join(data,'pcr-cache');
const programs=JSON.parse(await fs.readFile(path.join(data,'programs.json'),'utf8').catch(()=>'[]'));
const sources=new Map();for(const p of programs){if(typeof p.filePath!=='string')continue;const source=path.resolve(p.filePath);for(const name of [source,...(process.platform==='win32'?[source.toLowerCase()]:[])])sources.set(createHash('sha256').update(name).digest('hex'),source);}
const files=[],bySource=new Map(),days={};
for(const name of await fs.readdir(directory)){
 const full=path.join(directory,name),st=await fs.lstat(full).catch(()=>undefined);if(!st?.isFile()||st.isSymbolicLink())continue;
 const row={name,bytes:st.size,created:st.birthtime.toISOString(),modified:st.mtime.toISOString(),temporary:name.endsWith('.tmp')};
 if(/^[a-f0-9]{64}\.json$/.test(name)){
  let f;try{f=await fs.open(full,'r');const b=Buffer.alloc(4096),r=await f.read(b,0,b.length,0),header=b.subarray(0,r.bytesRead).toString('utf8');row.key=/"key":"([^"]+)"/.exec(header)?.[1];row.version=Number(/"version":(\d+)/.exec(header)?.[1]);}catch(e){row.readError=String(e);}finally{await f?.close();}
  const source=sources.get(name.slice(0,-5));
  if(source){row.source=source;const key=process.platform==='win32'?source.toLowerCase():source;bySource.set(key,[...(bySource.get(key)??[]),name]);
   try{const s=await fs.stat(source);row.sourceState=row.key===`${s.size}:${s.mtimeMs}`?'matching':'changed';}catch(e){row.sourceState=e.code==='ENOENT'?'missing':'inaccessible';}
  }else row.sourceState='not-in-current-TS-catalog; not proof of deletion';
 }
 files.push(row);const day=row.created.slice(0,10);days[day]??={files:0,bytes:0};days[day].files++;days[day].bytes+=row.bytes;
}
const report={at:new Date().toISOString(),machine:os.hostname(),directory,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),temporary:files.filter(f=>f.temporary).length,
 minBytes:files.length?Math.min(...files.map(f=>f.bytes)):0,maxBytes:files.length?Math.max(...files.map(f=>f.bytes)):0,
 creationDays:days,duplicates:[...bySource].filter(([,v])=>v.length>1).map(([source,names])=>({source,names})),entries:files,
 note:'Read-only: no TS payload reads, PCR builds, deletes, LRU touches, HTTP or settings changes. Cache mtime is also touched by full-index disk hits, not necessarily rebuilt. Reports contain private source paths.'};
const output=option('--out');if(output){await fs.writeFile(path.resolve(output),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({report:path.resolve(output),files:report.files,bytes:report.bytes,temporary:report.temporary,duplicateSources:report.duplicates.length},null,2));}else console.log(JSON.stringify(report,null,2));
