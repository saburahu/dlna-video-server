import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {Server} from 'node:net';
const start=performance.now(),cpu=process.cpuUsage(),counts={},groups={},times={};let inflight=0,peak=0,jsonCount=0,jsonMs=0;
const group=p=>{const s=String(p).replaceAll('\\','/');return s.includes('/eit-cache/')?'metadata-cache':s.includes('/pcr-cache/')?'pcr-cache':s.includes('/media/')?'source':s.endsWith('programs.json')?'catalog':s.endsWith('settings.json')?'settings':'other'};
function mark(k,args,ms){counts[k]=(counts[k]||0)+1;const g=group(args[0]);groups[g]??={};groups[g][k]=(groups[g][k]||0)+1;times[k]=(times[k]||0)+ms;}
for(const k of ['stat','lstat','readFile','realpath','access','open','readdir','mkdir','writeFile','rename','unlink']){const orig=fs.promises[k];fs.promises[k]=async function(...args){const t=performance.now();peak=Math.max(peak,++inflight);try{return await orig.apply(this,args)}finally{inflight--;mark(k,args,performance.now()-t)}};}
for(const k of ['existsSync','realpathSync','statSync']){const orig=fs[k];fs[k]=function(...args){const t=performance.now();try{return orig.apply(this,args)}finally{mark(k,args,performance.now()-t)}};}
syncBuiltinESMExports();const parse=JSON.parse;JSON.parse=function(...args){const t=performance.now();try{return parse.apply(this,args)}finally{jsonCount++;jsonMs+=performance.now()-t}};
const output=process.stderr.write.bind(process.stderr);function report(phase){output('STARTUP_PROFILE '+JSON.stringify({phase,elapsedMs:performance.now()-start,counts,groups,operationMs:times,peakAsync:peak,jsonCount,jsonMs,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),resource:process.resourceUsage()})+'\n')}
const listen=Server.prototype.listen;Server.prototype.listen=function(...args){this.once('listening',()=>report('listening'));return listen.apply(this,args)};
process.on('SIGUSR2',()=>report('checkpoint'));
const out=process.stdout.write.bind(process.stdout);let scanned=false;process.stdout.write=function(chunk,...args){if(!scanned&&String(chunk).includes('スキャン完了:')){scanned=true;report('inventory-ready')}return out(chunk,...args)};
