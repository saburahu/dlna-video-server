import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DiagnosticLog } from './diagnostic-log.js';
import type { scanRecordingEit } from './eit-scanner.js';
import type {EitScanOptions} from './eit-scanner.js';
import {PcrDeferred} from './pcr-work.js';
import {broadcastChannel,type BroadcastChannel,type RecordingRange,type RecordingOrigin} from './recording-si.js';

export type MetadataState = 'pending' | 'confirmed' | 'uncertain' | 'no-eit' | 'error';
export interface RecordingMetadata {
  state: MetadataState; scannedAt?: string; reason?: string; retryAfter?: number;
  title?: string; description?: string; serviceId?: number; eventId?: number;
  startTime?: string; durationSeconds?: number; genre?: number[];
  textSuspect?: boolean; selectionProvisional?: boolean; candidateCount?: number;
  method?: 'reservation' | 'full-clock-overlap';
  station?:string;transportStreamId?:number;originalNetworkId?:number;
  recordingRange?:RecordingRange;
  recordingOrigin?:RecordingOrigin;
  channelInfo?:BroadcastChannel;
}
export type EitScan = Awaited<ReturnType<typeof scanRecordingEit>>;
export type ScanStrategy = (file: string,options?:EitScanOptions) => Promise<EitScan>;
const fullScan: ScanStrategy = async (file,options) => (await import('./eit-scanner.js')).scanRecordingEit(file,options);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const text = (s: unknown): s is string => typeof s === 'string' && s.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(s);
/** Require an explicit zone and a real calendar date, not Date.parse's rollover. */
function isoTime(value:unknown):value is string{
 if(typeof value!=='string')return false;
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);if(!m)return false;
 const [y,mo,d,h,mi,s]=m.slice(1,7).map(Number),date=new Date(0);date.setUTCFullYear(y,mo-1,d);date.setUTCHours(h,mi,s,Number((m[7]??'').padEnd(3,'0')));
 if([date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),date.getUTCHours(),date.getUTCMinutes(),date.getUTCSeconds()].some((v,i)=>v!==[y,mo,d,h,mi,s][i]))return false;
 if(m[8]!=='Z'&&(Number(m[8].slice(1,3))>23||Number(m[8].slice(4))>59))return false;
 return Number.isFinite(Date.parse(value));
}
export function validMetadata(m: unknown): m is RecordingMetadata {
  if (!m || typeof m !== 'object') return false;
  const v = m as RecordingMetadata;
  if (!['pending','confirmed','uncertain','no-eit','error'].includes(v.state)) return false;
  if (['title','description','reason','station'].some(k => (v as any)[k] !== undefined && !text((v as any)[k]))) return false;
  if (v.startTime !== undefined && !isoTime(v.startTime)) return false;
  if (v.scannedAt !== undefined && !isoTime(v.scannedAt)) return false;
  if(v.channelInfo!==undefined){const c=v.channelInfo;if(!c||c.version!==1||!['identified','unavailable'].includes(c.state)||c.reason!==undefined&&!text(c.reason))return false;
   if(c.state==='unavailable'&&(c.objectType!==undefined||c.channelNr!==undefined))return false;
   if(c.state==='identified'&&(!['ARIB_TB','ARIB_BS','ARIB_CS'].includes(c.objectType!)||c.channelNr!==undefined&&(!Number.isSafeInteger(c.channelNr)||c.channelNr<10||c.channelNr>129999)))return false;
  }
  if(v.recordingOrigin!==undefined){const o=v.recordingOrigin;
    if(!o||o.version!==1||o.basis!=='tot-pcr-prefix'||!['estimated','unavailable'].includes(o.state)||!Number.isSafeInteger(o.anchors)||o.anchors<0)return false;
    if(o.reason!==undefined&&!text(o.reason))return false;
    if(o.state==='estimated'&&(!isoTime(o.startTime)||o.anchors<3||o.uncertaintySeconds!==1||!Number.isFinite(o.firstSeconds)||o.firstSeconds!<0||o.firstSeconds!>10||!Number.isFinite(o.lastSeconds)||o.lastSeconds!>20||o.lastSeconds!-o.firstSeconds!<5||!Number.isFinite(o.spreadMs)||o.spreadMs!<0||o.spreadMs!>250))return false;
  }
  if (['serviceId','eventId','transportStreamId','originalNetworkId'].some(k => (v as any)[k] !== undefined && (!Number.isInteger((v as any)[k]) || (v as any)[k] < 0 || (v as any)[k] > 65535))) return false;
  if(v.recordingRange!==undefined){const r=v.recordingRange;
    if(!r||r.basis!=='tot-pcr-transport'||!['consistent','missing','insufficient','discontinuous','inconsistent'].includes(r.state)||!Number.isSafeInteger(r.anchorCount)||r.anchorCount<0||!Number.isSafeInteger(r.segments)||r.segments<0)return false;
    if(r.spreadMs!==undefined&&(!Number.isFinite(r.spreadMs)||r.spreadMs<0))return false;
    if(r.state==='consistent'&&(!isoTime(r.startTime)||!isoTime(r.endTime)||r.durationSeconds===undefined||!Number.isFinite(r.durationSeconds)||r.durationSeconds<=0||Math.abs(Date.parse(r.endTime)-Date.parse(r.startTime)-r.durationSeconds*1000)>1||r.uncertaintySeconds!==1||r.segments!==1||r.anchorCount<3||r.spreadMs===undefined||r.spreadMs>250))return false;
  }
  if (v.durationSeconds !== undefined && (!Number.isFinite(v.durationSeconds) || v.durationSeconds < 0)) return false;
  if (v.retryAfter !== undefined && !Number.isFinite(v.retryAfter)) return false;
  if (v.genre !== undefined && (!Array.isArray(v.genre) || !v.genre.every(n => Number.isInteger(n) && n >= 0 && n <= 255))) return false;
  return v.state !== 'confirmed' || (v.serviceId !== undefined && v.eventId !== undefined && v.startTime !== undefined && v.durationSeconds !== undefined && ['reservation','full-clock-overlap'].includes(v.method!));
}
const genreNames = ['ニュース／報道','スポーツ','情報／ワイドショー','ドラマ','音楽','バラエティ','映画','アニメ／特撮','ドキュメンタリー／教養','劇場／公演','趣味／教育','福祉'];
/** Preserve the instant, but expose the Japanese broadcast wall clock explicitly.
 * Observed receiver UIs display the date/time fields without converting a Z
 * suffix. An explicit offset also remains correct for timezone-aware clients.
 * Stored SI/cache times remain UTC; this is a presentation-only conversion. */
function broadcastDidlTime(value:string){
 const local=new Date(Date.parse(value)+9*3600000);
 if(!Number.isFinite(local.getTime())||local.getUTCFullYear()<0||local.getUTCFullYear()>9999)return value;
 return local.toISOString().replace(/Z$/,'+09:00');
}
export function metadataDisplay(p: {title: string; modified: string; genre?: string; metadata?: unknown}) {
  const valid=validMetadata(p.metadata)?p.metadata:undefined;
  const m = valid?.state === 'confirmed' ? valid : undefined;
  const end=m?.startTime&&m.durationSeconds!==undefined?Date.parse(m.startTime)+m.durationSeconds*1000:NaN;
  const scheduledEnd=Number.isFinite(end)&&end>Date.parse(m!.startTime!)&&end<=253402300799999?new Date(end).toISOString():undefined;
  const range=valid?.recordingRange;
  // The player anchors NPT to dc:date. EIT is a schedule, not the file origin.
  const origin=m?.recordingOrigin?.state==='estimated'?m.recordingOrigin.startTime:m?.recordingRange?.state==='consistent'?m.recordingRange.startTime:undefined;
  const jst=(s:string)=>{const d=new Date(Date.parse(s)+9*3600000);return Number.isFinite(d.getTime())?d.toISOString().slice(0,19).replace('T',' ')+' JST':s;};
  const recording=range?.state==='consistent'?`録画範囲（TOT/PCR推定・TS輸送時刻、絶対精度未校正）: ${jst(range.startTime!)} ～ ${jst(range.endTime!)}。時刻分解能の目安1秒。`:'';
  return { title: m?.title?.trim() || p.title, description: [m?.description,recording].filter(Boolean).join('\n'), date: origin ? broadcastDidlTime(origin) : m ? '' : p.modified,
    channelInfo:m?.channelInfo?.state==='identified'?m.channelInfo:undefined,
    scheduledStartTime:scheduledEnd?broadcastDidlTime(m!.startTime!):undefined,scheduledEndTime:scheduledEnd?broadcastDidlTime(scheduledEnd):undefined,
    genre: m?.genre?.map(n => genreNames[n >> 4] ?? 'その他').filter((v,i,a) => a.indexOf(v) === i).join('、') || p.genre || '' };
}
export function summarizeEit(scan: EitScan): RecordingMetadata {
  const primary = scan.selection?.primary;
  const record = primary && scan.records.find(r => r.serviceId === primary.serviceId && r.eventId === primary.eventId && r.startTimeMs === primary.startTimeMs && (primary.transportStreamId === undefined || r.transportStreamId === primary.transportStreamId) && (primary.originalNetworkId === undefined || r.originalNetworkId === primary.originalNetworkId));
  const event = record?.updates.filter(u => u.current && u.tableId === 0x4e).at(-1)?.event;
  // Selection is still an inference: only publish a full, clock-anchored, majority-overlap winner.
  // Partial scans and present-count guesses never become normal display metadata.
  const reservation = scan.selection?.reason === 'reservation';
  const dominant = scan.selection?.reason === 'recording-overlap' && scan.clockValid && scan.recordingStartTimeMs !== null && scan.durationSeconds !== null && (primary?.overlapSeconds ?? 0) > scan.durationSeconds / 2;
  const confirmed = scan.complete && scan.scopeConsistent!==false && !!event && !!primary && primary.startTimeMs !== null && primary.durationSeconds !== null && (reservation || dominant);
  const serviceId=primary?.serviceId??scan.serviceId;
  const stations=(scan.services??[]).filter(s=>scan.complete&&scan.scopeConsistent!==false&&scan.patServices?.includes(s.serviceId)&&s.serviceId===serviceId&&s.transportStreamId===scan.transportStreamId&&(primary?.transportStreamId===undefined||primary.transportStreamId===s.transportStreamId)&&(primary?.originalNetworkId===undefined||s.originalNetworkId===primary.originalNetworkId));
  const station=stations.length===1&&!stations[0].textSuspect&&text(stations[0].name)?stations[0]:undefined;
  return { state: !scan.counters.eitSections ? (scan.counters.eitPackets && scan.counters.invalidSections ? 'error' : 'no-eit') : confirmed ? 'confirmed' : 'uncertain',
    scannedAt: new Date().toISOString(), reason: scan.selection?.reason ?? 'no-recording-clock',
    selectionProvisional: scan.selection?.provisional, candidateCount: scan.selection?.candidates.length ?? 0,
    ...(station&&{station:station.name,serviceId:station.serviceId,transportStreamId:station.transportStreamId,originalNetworkId:station.originalNetworkId}),
    ...(scan.complete&&{channelInfo:broadcastChannel(station,scan.networks??[])}),
    ...(scan.recordingRange&&{recordingRange:scan.recordingRange}),
    ...(scan.complete&&scan.recordingOrigin&&{recordingOrigin:scan.recordingOrigin}),
    ...(primary && {serviceId: primary.serviceId, eventId: primary.eventId,
      ...(primary.startTimeMs !== null && {startTime: new Date(primary.startTimeMs).toISOString()}),
      ...(primary.durationSeconds !== null && {durationSeconds: primary.durationSeconds})}),
    ...(confirmed && {method: reservation ? 'reservation' as const : 'full-clock-overlap' as const}),
    ...(event && {title: !event.textSuspect && text(event.title) ? event.title : undefined,
      description: !event.textSuspect && text(event.description) ? event.description : undefined, genre: event.genres, textSuspect: event.textSuspect}) };
}

const MAX_CACHE_BYTES = 64 * 1024;
const QUIET_MS = 120_000, RETRY_MS = 300_000;
interface CacheRecord {version: number; source: string; identity?:string; size: number; mtimeMs: number; metadata: RecordingMetadata; sha256: string}
export class RecordingMetadataCache {
  private jobs = new Map<string, Promise<{metadata: RecordingMetadata; cached: boolean}>>();
  constructor(readonly directory = path.resolve(process.env.PT3_DATA_DIR || 'data', 'eit-cache'), private strategy: ScanStrategy = fullScan, private folders: string[] = []) {}
  private async identity(source:string){const s=await fs.stat(source,{bigint:true});return s.ino?`${s.dev}:${s.ino}:${s.birthtimeNs}`:await fs.realpath(source);}
  private async filename(source: string) { return path.join(this.directory, digest(await this.identity(source)) + '.json'); }
  private separate(source: string) { new DiagnosticLog(this.directory).assertSeparate([...this.folders, path.dirname(path.resolve(source))]); }
  private async record(source: string): Promise<CacheRecord | undefined> {
    try { this.separate(source); const identity=await this.identity(source);let file = await this.filename(source);
      try{await fs.stat(file);}catch(e:any){if(e.code!=='ENOENT')throw e;file=path.join(this.directory,digest(path.resolve(source))+'.json');}
      if ((await fs.stat(file)).size > MAX_CACHE_BYTES) return;
      const r = JSON.parse(await fs.readFile(file, 'utf8')) as CacheRecord;
      if ((r.version===2&&r.identity===identity||r.version===1&&r.source===path.resolve(source)) && Number.isFinite(r.size) && Number.isFinite(r.mtimeMs) && validMetadata(r.metadata) && r.sha256 === digest(JSON.stringify(r.metadata))) return r;
    } catch {} return;
  }
  /** Only stat + small JSON: never invokes the scan strategy. */
  async lookup(source: string): Promise<RecordingMetadata> {
    try { const r = await this.record(source), st = await fs.stat(source);
      if (r && r.size === st.size && r.mtimeMs === st.mtimeMs) return r.version===2?r.metadata:{state:'pending',reason:'schema-upgrade'};
      return {state:'pending', reason:r ? 'file-changed' : 'not-scanned'};
    } catch { return {state:'error',reason:'file-unavailable'}; }
  }
  async analyze(source: string, retry = false,options:EitScanOptions={}) {
    source = path.resolve(source);
    const identity=await this.identity(source),existing = this.jobs.get(identity); if (existing) return existing;
    // One complete read/summary/atomic-write transaction per physical file,
    // including concurrent aliases; coalescing the scan alone races Windows rename.
    const job = this.analyzeOnce(source,retry,options); this.jobs.set(identity,job);
    try {return await job;} finally {this.jobs.delete(identity);}
  }
  private async analyzeOnce(source: string, retry: boolean,options:EitScanOptions) {
    this.separate(source);
    const before = await fs.stat(source), identity=await this.identity(source),r = await this.record(source), now = Date.now();
    if (r?.version===2&&r.metadata.state === 'pending' && (r.metadata.retryAfter ?? 0) > now) return {metadata:{state:'pending',reason:'waiting-for-stable-file',retryAfter:r.metadata.retryAfter} as RecordingMetadata,cached:true};
    const reusable=r?.version===2&&r.size===before.size&&r.mtimeMs===before.mtimeMs&&r.metadata.state!=='pending'&&(!retry||r.metadata.state==='confirmed');
    const missingOrigin=reusable&&r.metadata.recordingRange?.state==='inconsistent'&&!r.metadata.recordingOrigin;
    const missingChannel=reusable&&!r.metadata.channelInfo;
    const backfill=reusable&&r.metadata.state==='confirmed'&&(missingOrigin||missingChannel);
    if(reusable&&!backfill)return {metadata:r.metadata,cached:true};
    let metadata: RecordingMetadata;
    if(backfill){
      // Prior full-scan cache already proves the whole PCR clock and source scope.
      // Read at most a bounded prefix for the missing origin; retain full EIT.
      try{const prefix=await this.strategy(source,{...options,maxBytes:64*1024**2});
        const sameScope=prefix.clockValid&&prefix.scopeConsistent!==false&&prefix.patServices?.length===1&&prefix.patServices[0]===r.metadata.serviceId&&prefix.transportStreamId===r.metadata.transportStreamId&&prefix.services.some(s=>s.serviceId===r.metadata.serviceId&&s.transportStreamId===r.metadata.transportStreamId&&s.originalNetworkId===r.metadata.originalNetworkId);
        if(missingOrigin&&sameScope&&prefix.recordingOrigin?.reason==='initial-window-not-observed')metadata=summarizeEit(await this.strategy(source,options));
        else metadata={...r.metadata,
          ...(missingOrigin&&{recordingOrigin:sameScope&&prefix.recordingOrigin?prefix.recordingOrigin:{version:1 as const,basis:'tot-pcr-prefix' as const,state:'unavailable' as const,anchors:0,reason:'prefix-scope-mismatch'}}),
          ...(missingChannel&&{channelInfo:sameScope?broadcastChannel(prefix.services.find(s=>s.serviceId===r.metadata.serviceId&&s.transportStreamId===r.metadata.transportStreamId&&s.originalNetworkId===r.metadata.originalNetworkId),prefix.networks??[]):{version:1 as const,state:'unavailable' as const,reason:'prefix-scope-mismatch'}})};
      }catch(e){if(e instanceof PcrDeferred||(e as Error).name==='AbortError')throw e;metadata={...r.metadata,
        ...(missingOrigin&&{recordingOrigin:{version:1 as const,basis:'tot-pcr-prefix' as const,state:'unavailable' as const,anchors:0,reason:'prefix-read-failed'}}),
        ...(missingChannel&&{channelInfo:{version:1 as const,state:'unavailable' as const,reason:'prefix-read-failed'}})};}
    }
    else if (now - before.mtimeMs < QUIET_MS) metadata = {state:'pending',reason:'recently-modified',retryAfter:now+RETRY_MS};
    else try {metadata=summarizeEit(await this.strategy(source,options));}
    catch(e) {if(e instanceof PcrDeferred||(e as Error).name==='AbortError')throw e;metadata = {state:'error',scannedAt:new Date().toISOString(),reason:String(e).slice(0,8192).replace(/[\u0000-\u001f\ufffd]/g,' ')};}
    const after = await fs.stat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs||identity!==await this.identity(source)) metadata = {state:'pending',reason:'changed-during-scan',retryAfter:Date.now()+RETRY_MS};
    const record:CacheRecord = {version:2,source,identity:await this.identity(source),size:after.size,mtimeMs:after.mtimeMs,metadata,sha256:digest(JSON.stringify(metadata))};
    await fs.mkdir(this.directory,{recursive:true});this.separate(source);
    const filename=await this.filename(source),temporary = filename+'.'+randomUUID()+'.tmp';
    try {await fs.writeFile(temporary,JSON.stringify(record));await fs.rename(temporary,filename);}
    finally {await fs.unlink(temporary).catch(()=>{});}
    return {metadata,cached:false};
  }
}
