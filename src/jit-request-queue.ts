import type {ServerResponse} from 'node:http';

export interface JitRequestLease {
  generation:number;
  requestId:string;
  signal:AbortSignal;
  ready:()=>Promise<void>;
  check:()=>void;
  finish:()=>void;
}
interface Slot {order:number;id:string;res:ServerResponse;controller:AbortController;done:Promise<void>}

/** Latest HTTP request wins; cleanup is a barrier, not a fixed delay.
 * Order must be allocated at arrival, before any asynchronous client lookup.
 * HEAD and invalid requests must not enter this queue.
 */
export class JitRequestQueue {
  private slots=new Map<string,Slot>();
  private orders=new Map<string,number>();
  constructor(private trace:(category:string,detail:unknown)=>void=()=>{}){}
  has(key:string){return this.slots.has(key);}
  status(){return {occupied:this.slots.size,clients:[...this.slots.keys()]};}
  async stop(key:string){
    const slot=this.slots.get(key);if(!slot)return;
    slot.controller.abort(new Error('JIT runtime stopped'));slot.res.destroy();await slot.done;
  }
  begin(key:string,order:number,id:string,res:ServerResponse,limit:1|2=2):JitRequestLease|undefined {
    if(order<=(this.orders.get(key)??-1)){
      this.trace('REQUEST_SUPERSEDED',{key,generation:order,requestId:id,phase:'admission'});
      res.destroy();return;
    }
    // Reserve before asynchronous preparation. Replacement inherits its client's
    // reservation, including the entire old-executor cleanup barrier.
    if(!this.slots.has(key)&&this.slots.size>=limit){
      this.trace('JIT_CAPACITY_BUSY',{key,requestId:id,limit,...this.status()});
      res.writeHead(409,{'Content-Length':0,'Retry-After':'1'});res.end();return;
    }
    this.orders.set(key,order);
    const previous=this.slots.get(key),controller=new AbortController();
    let release!:()=>void,finished=false;
    const slot:Slot={order,id,res,controller,done:new Promise<void>(r=>release=r)};
    const close=()=>controller.abort(new Error('HTTP request disconnected'));
    res.once('close',close);if(res.destroyed)close();
    this.slots.set(key,slot);
    this.trace('REQUEST_ADMITTED',{key,generation:order,requestId:id,previousRequestId:previous?.id,limit,...this.status()});
    const cancelAt=performance.now();
    if(previous){
      this.trace('REQUEST_CANCEL_BEGIN',{key,generation:order,requestId:id,previousRequestId:previous.id});
      previous.controller.abort(new Error('Superseded by newer HTTP request'));
      previous.res.destroy();
    }
    const check=()=>{
      if(this.slots.get(key)!==slot||controller.signal.aborted||res.destroyed)
        throw new Error('JIT request superseded or disconnected');
    };
    return {generation:order,requestId:id,signal:controller.signal,check,
      ready:async()=>{await previous?.done;this.trace('REQUEST_CLEANUP_COMPLETE',{key,generation:order,requestId:id,previousRequestId:previous?.id,seconds:(performance.now()-cancelAt)/1000});check();},
      finish:()=>{if(finished)return;finished=true;res.off('close',close);if(this.slots.get(key)===slot)this.slots.delete(key);release();this.trace('REQUEST_RELEASED',{key,generation:order,requestId:id,...this.status()});}
    };
  }
}
