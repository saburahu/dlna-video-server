import type {IncomingMessage,ServerResponse} from 'node:http';
/** Observes events only: no write interception, buffering, headers or pacing changes. */
export function observeExperimentalDrain(req:IncomingMessage,res:ServerResponse,trialId:string|undefined,log:(category:string,message:string,detail?:unknown)=>void){
  if(req.method!=='GET'||req.url?.split('?')[0]!=='/media/sampleA.tts')return;
  let drainEvents=0,ended=false;const started=performance.now();
  const detail=()=>({trialId,remote:req.socket.remoteAddress,url:req.url,elapsedMs:performance.now()-started,drainEvents,writableLength:res.writableLength,writableNeedDrain:res.writableNeedDrain});
  const drain=()=>{drainEvents++;log('HTTP_DRAIN','Experimental response drain',detail());};
  const end=(event:string)=>{if(ended)return;ended=true;res.off('drain',drain);log('HTTP_TRANSPORT_END','Experimental drain observation ended',{...detail(),event,counterMeaning:'ServerResponse drain events; no TCP retransmission or receiver decode measurement'});};
  res.on('drain',drain);res.once('finish',()=>end('finish'));res.once('close',()=>end('close'));
}
