import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PcrIndex } from './core.js';
import { settings } from './store.js';
import { DiagnosticLog } from './diagnostic-log.js';
import {sourcePathKey} from './library-discovery.js';
import {packetTime} from './time-seek.js';
const MAX_FILE_BYTES = 64 * 1024 * 1024;
let limits:{maxDiskBytes:number|null;minFreeBytes:number;usage?:()=>number}={maxDiskBytes:null,minFreeBytes:2*1024**3};
let cacheObserver:(event:{source:string;key:string;file:string;bytes:number})=>void=()=>{};
let skipped:string|null=null;
export function configurePcrCache(value:typeof limits,observer:typeof cacheObserver=()=>{}){limits=value;cacheObserver=observer;}
export async function pcrCacheEntryInfo(source:string){
 const file=await filename(source);let fd:Awaited<ReturnType<typeof fs.open>>|undefined;
 try{separate(source);const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink())return;fd=await fs.open(file,'r');const b=Buffer.alloc(4096),r=await fd.read(b,0,b.length,0);const m=/^\{"version":1,"key":("(?:[^"\\]|\\.)*")/.exec(b.subarray(0,r.bytesRead).toString('utf8'));if(m)return {file,bytes:st.size,key:JSON.parse(m[1]) as string};}catch{return;}finally{await fd?.close();}
}
const stats = { diskHits: 0, builds: 0, error: null as string | null };
const directory = () => path.resolve(process.env.PT3_DATA_DIR || 'data', 'pcr-cache');
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
async function filename(source:string){const canonical=path.join(directory(),digest(sourcePathKey(source))+'.json'),legacy=path.join(directory(),digest(path.resolve(source))+'.json');if(canonical===legacy||await fs.lstat(canonical).catch(()=>undefined))return canonical;return await fs.lstat(legacy).catch(()=>undefined)?legacy:canonical;}
const separate = (source: string) => new DiagnosticLog(directory()).assertSeparate([...settings.folders, path.dirname(source)]);
export function pcrCacheStatus() { return { ...stats, directory: directory(), maxDiskBytes: limits.maxDiskBytes, minFreeBytes:limits.minFreeBytes, skipped }; }
export type PcrCacheSummary=Pick<PcrIndex,'packetCount'|'averageBitrate'|'discontinuities'|'invalidIntervals'> & {seekDuration?:number};
export function pcrSummary(index:PcrIndex):PcrCacheSummary{
 return {packetCount:index.packetCount,averageBitrate:index.averageBitrate,discontinuities:index.discontinuities,invalidIntervals:index.invalidIntervals,
  ...(!index.discontinuities&&!index.invalidIntervals?{seekDuration:packetTime(index,index.packetCount)}:{})};
}
/** Browse reads at most 4KiB of a saved header, never TS or a queued full index.
 * Old cache records remain valid for playback; missing summaries are unknown.
 */
export async function readPcrSummary(source:string,key:string):Promise<PcrCacheSummary|undefined>{
 let file:Awaited<ReturnType<typeof fs.open>>|undefined;
 try{
  separate(source);file=await fs.open(await filename(source),'r');const b=Buffer.alloc(4096),r=await file.read(b,0,b.length,0);
  const header=/^\{"version":1,"key":("(?:[^"\\]|\\.)*"),"summary":(\{[^{}]*\}),"summarySha256":"([a-f0-9]{64})",/.exec(b.subarray(0,r.bytesRead).toString('utf8'));
  if(!header||JSON.parse(header[1])!==key||digest(header[2])!==header[3])return;
  const summary=JSON.parse(header[2]) as PcrCacheSummary;
  if(!Number.isSafeInteger(summary.packetCount)||summary.packetCount<1||!Number.isFinite(summary.averageBitrate)||summary.averageBitrate<=0||
    !Number.isSafeInteger(summary.discontinuities)||summary.discontinuities<0||!Number.isSafeInteger(summary.invalidIntervals)||summary.invalidIntervals<0||
    (summary.seekDuration!==undefined&&(!Number.isFinite(summary.seekDuration)||summary.seekDuration<=0)))return;
  return summary;
 }catch{return;}finally{await file?.close().catch(()=>{});}
}
function valid(index: PcrIndex | null) {
  if (index === null) return true;
  if (!index || !Array.isArray(index.points) || index.points.length < 2) return false;
  for (const k of ['pid', 'packetCount', 'discontinuities', 'invalidIntervals', 'firstPacket', 'lastPacket', 'durationSeconds', 'averageBitrate'] as const)
    if (!Number.isFinite(index[k]) || index[k] < 0) return false;
  let packet = -1, ticks = -1;
  for (const p of index.points) {
    if (!Number.isSafeInteger(p.packet) || p.packet <= packet || p.packet >= index.packetCount || !Number.isFinite(p.pcr) ||
      !Number.isFinite(p.unwrappedPcr) || p.unwrappedPcr <= ticks || typeof p.discontinuityBefore !== 'boolean') return false;
    packet = p.packet; ticks = p.unwrappedPcr;
  }
  return index.firstPacket === index.points[0].packet && index.lastPacket === index.points.at(-1)!.packet;
}
export async function readPcrCache(source: string, key: string,signal?:AbortSignal): Promise<{ index: PcrIndex | null } | undefined> {
  try {
    separate(source); const file = await filename(source), st = await fs.stat(file);
    if (st.size > MAX_FILE_BYTES) return;
    const text=await fs.readFile(file,{encoding:'utf8',signal});signal?.throwIfAborted();const record = JSON.parse(text);
    if (record.version !== 1 || record.key !== key || typeof record.data !== 'string' || digest(record.data) !== record.sha256) return;
    const index = JSON.parse(record.data) as PcrIndex | null; if (!valid(index)) return;
    cacheObserver({source,key,file,bytes:st.size});stats.diskHits++;
    return { index };
  } catch (e: any) { if (e.code !== 'ENOENT'&&e.name!=='AbortError') stats.error = String(e); return; }
}
export async function writePcrCache(source: string, key: string, index: PcrIndex | null) {
  stats.builds++; let temporary: string | undefined;
  try {
    separate(source); await fs.mkdir(directory(), { recursive: true }); separate(source);
    const data = JSON.stringify(index), summary=index?pcrSummary(index):undefined;
    const record = JSON.stringify({ version: 1, key,...(summary?{summary,summarySha256:digest(JSON.stringify(summary))}:{}), source:path.resolve(source), data, sha256: digest(data) });
    if (Buffer.byteLength(record) > MAX_FILE_BYTES) throw new Error('PCR cache entry exceeds 64MiB');
    const file = await filename(source),bytes=Buffer.byteLength(record),old=await fs.lstat(file).catch(()=>undefined);
    if(old&&(!old.isFile()||old.isSymbolicLink()))throw Error('PCR cache target is not a regular file');
    const space=await fs.statfs(directory());
    if(space.bavail*space.bsize<limits.minFreeBytes+bytes){skipped='low-free-space';return;}
    if(limits.maxDiskBytes!==null&&(limits.usage?.()??0)-(old?.size??0)+bytes>limits.maxDiskBytes){skipped='capacity-limit';return;}
    temporary = file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, record, { flag: 'wx' }); await fs.rename(temporary, file); temporary = undefined;
    skipped=null;cacheObserver({source,key,file,bytes});
    stats.error = null;
  } catch (e) { stats.error = String(e); }
  finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
}
