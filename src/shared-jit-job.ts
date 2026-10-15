/** A cache fill belongs to its subscribers, never to the first HTTP request.
 * One disconnect cannot abort another client's scan. The final subscriber waits
 * for cancellation cleanup before returning, so a replacement cannot leak workers.
 */
export class SharedJitJobs<T> {
  private jobs=new Map<string,{controller:AbortController;promise:Promise<T>;users:number}>();
  async run(key:string,work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted();
    let job=this.jobs.get(key);
    if(!job){
      const controller=new AbortController();
      job={controller,promise:Promise.resolve().then(()=>work(controller.signal)),users:0};
      const owned=job;this.jobs.set(key,job);
      void job.promise.finally(()=>{if(this.jobs.get(key)===owned)this.jobs.delete(key);}).catch(()=>{});
    }
    const owned=job;owned.users++;
    let abort!:()=>void;
    const interrupted=new Promise<never>((_,reject)=>{abort=()=>reject(signal?.reason??new Error('JIT scan cancelled'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
    try{return await Promise.race([owned.promise,interrupted]);}
    finally{
      signal?.removeEventListener('abort',abort);
      if(--owned.users===0&&signal?.aborted){
        if(this.jobs.get(key)===owned)this.jobs.delete(key);
        owned.controller.abort();await owned.promise.catch(()=>{});
      }
    }
  }
}
