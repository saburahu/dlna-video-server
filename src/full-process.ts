import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {once} from 'node:events';

/** Bounded output, backpressure and idle watchdog; elapsed duration is not failure. */
export async function streamCommand(binary:string,args:string[],options:{stdout?:(line:string)=>void|Promise<void>;stderr?:(line:string)=>void|Promise<void>;logFile?:string;idleMs?:number;signal?:AbortSignal;progress?:'ffmpeg'}={}){
 const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let last=Date.now(),failure:unknown,tail='',totalLines=0;
 const log=options.logFile?createWriteStream(options.logFile,{flags:'wx'}):undefined;
 const exited=new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 // Attach immediately, including launch failures, so no rejected promise is left unhandled.
 void exited.catch(()=>{});
 const stop=(reason:unknown)=>{if(failure)return;failure=reason;child.kill();const kill=setTimeout(()=>child.kill('SIGKILL'),5000);kill.unref();};
 log?.once('error',stop);
 const abort=()=>stop(new Error('Prepare interrupted'));options.signal?.addEventListener('abort',abort,{once:true});
 process.once('SIGINT',abort);process.once('SIGTERM',abort);if(options.signal?.aborted)abort();
 const watch=setInterval(()=>{if(Date.now()-last>(options.idleMs??180000))stop(new Error('Subprocess made no output/progress before idle deadline'));},1000);watch.unref();
 const progressValues:Record<string,number>={};
 const consume=async(stream:NodeJS.ReadableStream,callback:typeof options.stdout,isError:boolean)=>{let carry='';for await(const b of stream){if(!options.progress)last=Date.now();const text=Buffer.from(b).toString('utf8');if(isError){tail=(tail+text).slice(-65536);if(log&&!log.write(text))await once(log,'drain');}carry+=text;if(carry.length>2*1024*1024)throw new Error('Subprocess line exceeds bounded limit');let i;while((i=carry.indexOf('\n'))>=0){const line=carry.slice(0,i).replace(/\r$/,'');carry=carry.slice(i+1);if(options.progress&&!isError){const m=/^(out_time_us|frame|total_size)=(\d+)$/.exec(line);if(m&&Number(m[2])>(progressValues[m[1]]??-1)){progressValues[m[1]]=Number(m[2]);last=Date.now();}}await callback?.(line);totalLines++;}}if(carry)await callback?.(carry);};
 try{await Promise.all([consume(child.stdout!,options.stdout,false),consume(child.stderr!,options.stderr,true)]).catch(async e=>{stop(e);await exited.catch(()=>{});throw e;});const status=await exited;if(failure)throw failure;if(status.code!==0)throw new Error(`${binary} failed ${status.code}/${status.signal}: ${tail}`);return {tail,totalLines};}
 finally{clearInterval(watch);options.signal?.removeEventListener('abort',abort);process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);if(child.exitCode===null&&child.signalCode===null)stop(new Error('Reader closed'));if(log&&!log.closed)await new Promise<void>((resolve,reject)=>{log.once('error',reject);log.once('close',resolve);log.end();});}
}
export function compactFields(line:string){return Object.fromEntries(line.split('|').flatMap(p=>{const i=p.indexOf('=');return i<0?[]:[[p.slice(0,i),p.slice(i+1)]];}));}
