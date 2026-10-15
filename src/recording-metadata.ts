import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DiagnosticLog } from './diagnostic-log.js';
import type { scanRecordingEit } from './eit-scanner.js';

export type MetadataState = 'pending' | 'confirmed' | 'uncertain' | 'no-eit' | 'error';
export interface RecordingMetadata {
  state: MetadataState; scannedAt?: string; reason?: string; retryAfter?: number;
  title?: string; description?: string; serviceId?: number; eventId?: number;
  startTime?: string; durationSeconds?: number; genre?: number[];
  textSuspect?: boolean; selectionProvisional?: boolean; candidateCount?: number;
  method?: 'reservation' | 'full-clock-overlap';
}
export type EitScan = Awaited<ReturnType<typeof scanRecordingEit>>;
export type ScanStrategy = (file: string) => Promise<EitScan>;
const fullScan: ScanStrategy = async file => (await import('./eit-scanner.js')).scanRecordingEit(file);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const text = (s: unknown): s is string => typeof s === 'string' && s.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(s);
export function validMetadata(m: unknown): m is RecordingMetadata {
  if (!m || typeof m !== 'object') return false;
  const v = m as RecordingMetadata;
  if (!['pending','confirmed','uncertain','no-eit','error'].includes(v.state)) return false;
  if (['title','description','reason'].some(k => (v as any)[k] !== undefined && !text((v as any)[k]))) return false;
  if (v.startTime !== undefined && (typeof v.startTime !== 'string' || !Number.isFinite(Date.parse(v.startTime)))) return false;
  if (v.scannedAt !== undefined && !Number.isFinite(Date.parse(v.scannedAt))) return false;
  if (['serviceId','eventId'].some(k => (v as any)[k] !== undefined && (!Number.isInteger((v as any)[k]) || (v as any)[k] < 0 || (v as any)[k] > 65535))) return false;
  if (v.durationSeconds !== undefined && (!Number.isFinite(v.durationSeconds) || v.durationSeconds < 0)) return false;
  if (v.retryAfter !== undefined && !Number.isFinite(v.retryAfter)) return false;
  if (v.genre !== undefined && (!Array.isArray(v.genre) || !v.genre.every(n => Number.isInteger(n) && n >= 0 && n <= 255))) return false;
  return v.state !== 'confirmed' || (v.serviceId !== undefined && v.eventId !== undefined && v.startTime !== undefined && v.durationSeconds !== undefined && ['reservation','full-clock-overlap'].includes(v.method!));
}
const genreNames = ['ニュース／報道','スポーツ','情報／ワイドショー','ドラマ','音楽','バラエティ','映画','アニメ／特撮','ドキュメンタリー／教養','劇場／公演','趣味／教育','福祉'];
export function metadataDisplay(p: {title: string; modified: string; genre?: string; metadata?: unknown}) {
  const m = validMetadata(p.metadata) && p.metadata.state === 'confirmed' ? p.metadata : undefined;
  return { title: m?.title?.trim() || p.title, description: m?.description || '', date: m?.startTime || p.modified,
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
  const confirmed = scan.complete && !!event && !!primary && primary.startTimeMs !== null && primary.durationSeconds !== null && (reservation || dominant);
  return { state: !scan.counters.eitSections ? (scan.counters.eitPackets && scan.counters.invalidSections ? 'error' : 'no-eit') : confirmed ? 'confirmed' : 'uncertain',
    scannedAt: new Date().toISOString(), reason: scan.selection?.reason ?? 'no-recording-clock',
    selectionProvisional: scan.selection?.provisional, candidateCount: scan.selection?.candidates.length ?? 0,
    ...(primary && {serviceId: primary.serviceId, eventId: primary.eventId,
      ...(primary.startTimeMs !== null && {startTime: new Date(primary.startTimeMs).toISOString()}),
      ...(primary.durationSeconds !== null && {durationSeconds: primary.durationSeconds})}),
    ...(confirmed && {method: reservation ? 'reservation' as const : 'full-clock-overlap' as const}),
    ...(event && {title: !event.textSuspect && text(event.title) ? event.title : undefined,
      description: !event.textSuspect && text(event.description) ? event.description : undefined, genre: event.genres, textSuspect: event.textSuspect}) };
}

const MAX_CACHE_BYTES = 64 * 1024;
const QUIET_MS = 120_000, RETRY_MS = 300_000;
interface CacheRecord {version: number; source: string; size: number; mtimeMs: number; metadata: RecordingMetadata; sha256: string}
export class RecordingMetadataCache {
  private jobs = new Map<string, Promise<{metadata: RecordingMetadata; cached: boolean}>>();
  constructor(readonly directory = path.resolve(process.env.PT3_DATA_DIR || 'data', 'eit-cache'), private strategy: ScanStrategy = fullScan, private folders: string[] = []) {}
  private filename(source: string) { return path.join(this.directory, digest(path.resolve(source)) + '.json'); }
  private separate(source: string) { new DiagnosticLog(this.directory).assertSeparate([...this.folders, path.dirname(path.resolve(source))]); }
  private async record(source: string): Promise<CacheRecord | undefined> {
    try { this.separate(source); const file = this.filename(source); if ((await fs.stat(file)).size > MAX_CACHE_BYTES) return;
      const r = JSON.parse(await fs.readFile(file, 'utf8')) as CacheRecord;
      if (r.version === 1 && r.source === path.resolve(source) && Number.isFinite(r.size) && Number.isFinite(r.mtimeMs) && validMetadata(r.metadata) && r.sha256 === digest(JSON.stringify(r.metadata))) return r;
    } catch {} return;
  }
  /** Only stat + small JSON: never invokes the scan strategy. */
  async lookup(source: string): Promise<RecordingMetadata> {
    try { const r = await this.record(source), st = await fs.stat(source);
      if (r && r.size === st.size && r.mtimeMs === st.mtimeMs) return r.metadata;
      return {state:'pending', reason:r ? 'file-changed' : 'not-scanned'};
    } catch { return {state:'error',reason:'file-unavailable'}; }
  }
  async analyze(source: string, retry = false) {
    source = path.resolve(source);
    const existing = this.jobs.get(source); if (existing) return existing;
    const job = this.analyzeOnce(source,retry); this.jobs.set(source,job);
    try {return await job;} finally {this.jobs.delete(source);}
  }
  private async analyzeOnce(source: string, retry: boolean) {
    this.separate(source);
    const before = await fs.stat(source), r = await this.record(source), now = Date.now();
    if (r?.metadata.state === 'pending' && (r.metadata.retryAfter ?? 0) > now) return {metadata:{state:'pending',reason:'waiting-for-stable-file',retryAfter:r.metadata.retryAfter} as RecordingMetadata,cached:true};
    if (r && r.size === before.size && r.mtimeMs === before.mtimeMs && r.metadata.state !== 'pending' && (!retry || r.metadata.state === 'confirmed')) return {metadata:r.metadata,cached:true};
    let metadata: RecordingMetadata;
    if (now - before.mtimeMs < QUIET_MS) metadata = {state:'pending',reason:'recently-modified',retryAfter:now+RETRY_MS};
    else try {metadata = summarizeEit(await this.strategy(source));}
    catch(e) {metadata = {state:'error',scannedAt:new Date().toISOString(),reason:String(e).slice(0,8192).replace(/[\u0000-\u001f\ufffd]/g,' ')};}
    const after = await fs.stat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) metadata = {state:'pending',reason:'changed-during-scan',retryAfter:Date.now()+RETRY_MS};
    const record:CacheRecord = {version:1,source,size:after.size,mtimeMs:after.mtimeMs,metadata,sha256:digest(JSON.stringify(metadata))};
    await fs.mkdir(this.directory,{recursive:true});this.separate(source);
    const temporary = this.filename(source)+'.'+randomUUID()+'.tmp';
    try {await fs.writeFile(temporary,JSON.stringify(record));await fs.rename(temporary,this.filename(source));}
    finally {await fs.unlink(temporary).catch(()=>{});}
    return {metadata,cached:false};
  }
}
