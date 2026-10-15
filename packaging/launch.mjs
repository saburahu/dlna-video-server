// Distribution host only. Playback remains the unchanged compiled server.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import{externalFFmpeg}from'./external-ffmpeg.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await fs.readFile(path.join(root,'launcher.json'),'utf8'));
const data=path.resolve(config.data),logs=path.join(data,'logs');
await fs.mkdir(logs,{recursive:true});
process.env.PT3_DATA_DIR=data;process.env.PT3_LOG_DIR=logs;
process.env.PT3_EXPERIMENTAL_CATALOG_DIR=path.join(data,'experimental-catalog');
process.env.PT3_SHADOW_DIR=path.join(data,'playback-shadow');
const external=await externalFFmpeg(root,config);
process.env.PT3_FFMPEG=external.ffmpeg;
process.env.PT3_FFPROBE=external.ffprobe;
process.env.PATH=external.directory+path.delimiter+path.join(root,'runtime')+path.delimiter+process.env.PATH;
if(config.disableSsdp)process.env.PT3_DISABLE_SSDP='1';else delete process.env.PT3_DISABLE_SSDP;
process.chdir(root);
const settings=JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8'));
await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(settings.port,'0.0.0.0',()=>s.close(resolve));});
if(!config.disableSsdp)await new Promise((resolve,reject)=>{const s=dgram.createSocket({type:'udp4',reuseAddr:true});s.once('error',e=>{s.close();reject(e);});s.bind(1900,()=>s.close(resolve));});
const lock=path.join(data,'portable-running.json'),token=randomUUID();
try{const h=await fs.open(lock,'wx');await h.writeFile(JSON.stringify({pid:process.pid,token,root,machine:os.hostname(),at:new Date().toISOString()}));await h.close();}
catch{throw Error('Data directory is locked. Use status/stop; do not delete a live lock.');}
const request=path.join(data,'portable-stop.json');
process.on('exit',()=>{});
let stopping=false;
const timer=setInterval(async()=>{try{const r=JSON.parse(await fs.readFile(request,'utf8'));if(r.token===token&&!stopping){stopping=true;clearInterval(timer);process.emit('SIGTERM');}}catch{}},300);
timer.unref();
process.on('exit',()=>{ /* PID/token is checked by control before stale-lock cleanup. */ });
try{await import('./app/src/server.js');}
catch(e){clearInterval(timer);await fs.unlink(lock).catch(()=>{});throw e;}
