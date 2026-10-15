import type {IncomingMessage,ServerResponse} from 'node:http';
import {TransferStallSampler} from './transfer-stall-sampler.js';
/** Passive observation only. Does not wrap write(), consume data, alter timeout, headers or flow control. */
export function observeHttpTransfer(req:IncomingMessage,res:ServerResponse,trace:(event:string,detail:unknown)=>void,intervalMs=5000){
 const start=performance.now(),socket=req.socket,base=socket.bytesWritten;let drains=0,finished=false,closed=false;
 const sampler=new TransferStallSampler();
 const sample=()=>sampler.sample(performance.now()-start,socket.bytesWritten-base,res.writableLength);
 sample();const sampleTimer=setInterval(sample,100);sampleTimer.unref();
 const metrics=()=>({elapsedMs:performance.now()-start,socketBytesWrittenIncludingHeaders:socket.bytesWritten-base,writableLength:res.writableLength,needDrain:res.writableNeedDrain,drains,completed:res.writableFinished,requestAborted:req.aborted,status:res.statusCode,meaning:'Local socket counter includes headers; not TCP ACK/receiver read/decode. Concurrent pipelined responses may share socket counts.'});
 const emit=(event:string)=>{sample();try{trace(event,{...metrics(),shortStallSampling:{...sampler.result,intervalMs:100,meaning:'Sampled local queued/no-progress interval; pauses shorter than sampling interval can be missed; event-loop delay remains possible'}});}catch{/* Logging must not fail playback. */}};
 const drain=()=>{drains++;};res.on('drain',drain);
 const timer=setInterval(()=>emit('HTTP_TRANSFER_PROGRESS'),intervalMs);timer.unref();
 const cleanup=()=>{clearInterval(timer);clearInterval(sampleTimer);res.off('drain',drain);};
 res.once('finish',()=>{finished=true;cleanup();emit('HTTP_TRANSFER_FINISH');});
 res.once('close',()=>{closed=true;cleanup();emit('HTTP_TRANSFER_CLOSE');});
 return ()=>({finished,closed,...metrics()});
}
