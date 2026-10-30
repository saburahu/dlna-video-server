import {createProgrammeProjection,programmeEnabled,parseProgrammeId,programmeLegacyId,programmeSlice,programmePlan} from './recording-programme.js';
import {PRODUCT_VERSION} from './product-version.js';
import { createReadStream, promises as fs } from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { contentFeatures, inspectTs, isPrivateAddress, mediaSize, parseRange, profiles, protocolInfo, safeStat, escapeXml } from "./core.js";
import { DiagnosticLog } from "./diagnostic-log.js";
import { inspectStartup } from "./startup-diagnostic.js";
import { ffprobeDiagnostic, refreshMetadata, loadStore, programs, scanFolders, settings, updateSettings, systemUpdateId,observeRecordingInventory } from "./store.js";
import {createPcrBackground} from './pcr-background.js';
import {pcrWork,PcrDeferred} from './pcr-work.js';
import {RecordingMetadataCache} from './recording-metadata.js';
import {applyRecordingMetadata} from './store.js';
import { Tts192Transform } from "./tts.js";
import { contentPacketLayout, ContentPacketTransform } from "./content-packet.js";
import { formatNpt, packetTime, timeSeekProfile, timeSeekSlice } from "./time-seek.js";
import { buildPcrIndex, pcrIndexCacheStatus,cachedPcrSummary,cachedPcrIndex } from "./pcr-index.js";
import { BitratePacingTransform, PcrPacingTransform } from "./pacing.js";
import { REGZA_BUFFERED_PROFILE, REGZA_PCR_LEAD_MS } from './playback-policy.js';
import { deviceXml, scpd, soapResponse, SsdpServer, MediaResource, browseRequest, browsePrograms, browseDIDL } from "./upnp.js";
import { createExperimentalCatalog, experimentalCatalogDirectory, experimentalBrowseSoap } from './experimental-catalog.js';
import { attachShadow } from './playback-shadow.js';
import { createShadowStore, shadowDirectory } from './playback-shadow-store.js';
import {contentDirectoryEvents} from './content-directory-events.js';
import {createClientContractDiagnostics} from './client-contract-diagnostics.js';
import {observeHttpTransfer} from './http-transfer-observer.js';
import {createAvcHttpControl} from './avc-http-control.js';
import {createMpegTsTrial} from './mpeg-ts-trial.js';
import {PUBLIC_MENU_REVISION,menuRevisionSoap} from './public-directory.js';
import {createAvcPictureTrial,appendPictureRoot} from './avc-picture-trial.js';
import {createFamilyShadow,FAMILY_VERSION} from './client-family.js';
import {recordingDidlTrial,recordingDidlTrialAccess} from './recording-didl-trial.js';

import {managementAccess,redactHeaders}from './management-access.js';
import{sourceContained}from'./source-containment.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logs: any[] = [];
let boundPort = 0;
const sessionId = randomUUID();
const diskLog = new DiagnosticLog(process.env.PT3_LOG_DIR || path.join(root, "diagnostic-logs"));
let logError: string | null = null;
type Trial = { id: string; profile: string; startedAt: string; programId?: string; note?: string };
let trial: Trial;
const trials = new Map<string, Trial>();
const requests = new WeakMap<IncomingMessage, Record<string, unknown>>();
const sockets = new WeakMap<object, string>();
let familyShadow=createFamilyShadow();
let activeMediaReads=0;
const playbackShadow = createShadowStore(shadowDirectory(), () => settings.folders);
const experimentalCatalog = createExperimentalCatalog(experimentalCatalogDirectory(), (message, detail) => log('EXPERIMENTAL_CATALOG', message, detail), () => settings.folders,{},inventory=>scanFolders(log,inventory),{busy:()=>activeMediaReads>0,recordingState:()=>programs.map(p=>({file:p.filePath,size:p.size,mtimeMs:Date.parse(p.modified)}))});
const recordingMetadataCache=new RecordingMetadataCache();
const programmeProjection:ReturnType<typeof createProgrammeProjection>=createProgrammeProjection(programmeEnabled(),{programs:()=>programs,metadata:source=>recordingMetadataCache.lookup(source),index:cachedPcrIndex,requestWarm:async(source:string):Promise<void>=>{await pcrBackground.recheckMetadata([source]);}});
const pcrBackground=createPcrBackground(path.resolve(process.env.PT3_DATA_DIR||'data'),()=>settings.folders,(event,detail)=>{log('PCR_BACKGROUND',event,detail);if(event==='PCR_BACKGROUND_COMPLETE'||event==='PCR_CACHE_CLEANED')programmeProjection.invalidate((detail as {source?:string}).source);},{
 busy:()=>experimentalCatalog.jitStatus().some(s=>s.active||s.executors),
 async metadata(source,options){const before=await fs.stat(source),previous=await recordingMetadataCache.lookup(source),result=await recordingMetadataCache.analyze(source,previous.state==='error',options);
  const after=await fs.stat(source);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new PcrDeferred('source-changed');
  const changed=applyRecordingMetadata(source,result.metadata,before.size,before.mtime);
  if(programmeProjection.enabled)for(const p of programs.filter(p=>p.published&&path.resolve(p.filePath).toLowerCase()===path.resolve(source).toLowerCase()))await programmeProjection.warm(p,profiles[settings.profile]);
  if(!result.cached||changed)log('RECORDING_METADATA','録画メタデータを更新',{state:result.metadata.state,changed,cached:result.cached});
  if(result.metadata.state==='pending')throw new PcrDeferred('metadata-pending');
  if(result.metadata.state==='error')throw Error('Recording metadata analysis failed');
 }
});
observeRecordingInventory(snapshot=>pcrBackground.accept(snapshot));
const clientDiagnostics=createClientContractDiagnostics(path.resolve(process.env.PT3_DATA_DIR||'data','client-diagnostics'),(message,detail)=>log('CLIENT_CONTRACT',message,detail));
const avcControl=createAvcHttpControl(path.resolve(process.env.PT3_DATA_DIR||'data','avc-http-control'),path.resolve(experimentalCatalogDirectory(),'jit.json'),(message,detail)=>log('AVC_HTTP_CONTROL',message,detail));
const mpegTsTrial=createMpegTsTrial(path.resolve(process.env.PT3_DATA_DIR||'data','mpeg-ts-trial'),(message,detail)=>log('MPEG_TS_TRIAL',message,detail));
const pictureTrial=createAvcPictureTrial(path.resolve(process.env.PT3_DATA_DIR||'data','avc-picture-trial'),(message,detail)=>log('AVC_PICTURE_TRIAL',message,detail));
const recordingDisplayTrial=recordingDidlTrial(process.env.PT3_RECORDING_DIDL_TRIAL==='1',id=>programs.find(p=>p.id===id)?.metadata);
const cdEvents=contentDirectoryEvents(async()=>(systemUpdateId+await experimentalCatalog.updateId()+PUBLIC_MENU_REVISION+recordingDisplayTrial.revision+programmeProjection.revision)>>>0,(message,detail)=>log('UPNP_EVENT',message,detail));
function beginTrial(programId?: string, note?: string) {
  trial = { id: randomUUID(), profile: settings.profile, startedAt: new Date().toISOString(), programId, note };
  trials.set(trial.id, trial);
  if (trials.size > 3000) trials.delete(trials.keys().next().value!);
  const program = programs.find(p => p.id === programId);
  log("TRIAL_START", "実機試行開始", { ...trial, savedProfile: profiles[settings.profile],
    program: program && { id: program.id, title: program.title } });
  return trial;
}
function log(category: string, message: string, detail?: unknown, req?: IncomingMessage) {
  // Feature extraction is memory-only; changes use the existing diagnostic log.
  if(req&&category!=='CLIENT_FAMILY_SHADOW')try{
    const observed=familyShadow.observe(req.socket.remoteAddress||'',req.headers,(detail as {requestXml?:string}|undefined)?.requestXml||'');
    if(observed)log('CLIENT_FAMILY_SHADOW','Implementation family observation',{...observed,request:requests.get(req)});
  }catch{ /* Shadow failure must never affect HTTP/playback. */ }
  const entry = { at: new Date().toISOString(), sessionId, trialId: trial?.id,
    savedProfile: trial?.profile, ...req && requests.get(req),
    level: category === "ERROR" ? "error" : "info", category, message, detail:redactHeaders(detail),
    clientIp: req?.socket.remoteAddress, userAgent: req?.headers["user-agent"] };
  logs.push(entry); if (logs.length > 3000) logs.shift();
  try { diskLog.append(entry); } catch (e) { logError = String(e); console.error("診断ログ保存失敗:", logError); }
  console.log(`[${entry.at}] [${category}] ${message}`);
}
function sendJson(res: ServerResponse, status: number, value: unknown) {
  const data = JSON.stringify(value); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) }); res.end(data);
}
async function body(req: IncomingMessage, limit = 1024 * 1024) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("Request too large"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString();
}
function localAddress() {
  if (settings.interfaceAddress) return settings.interfaceAddress;
  try {
    for (const entries of Object.values(networkInterfaces())) for (const x of entries || []) if (x.family === "IPv4" && !x.internal && isPrivateAddress(x.address)) return x.address;
  } catch {}
  return "127.0.0.1";
}
function availableInterfaces() {
  try { return networkInterfaces(); } catch { return {}; }
}
function baseUrl() { return `http://${localAddress()}:${boundPort || settings.port}`; }

async function readMediaPrefix(filePath: string) {
  const file = await fs.open(filePath, "r");
  try {
    const data = Buffer.alloc(8 * 1024 * 1024);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    return data.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
async function inspectMedia(filePath: string) { return inspectTs(await readMediaPrefix(filePath)); }

async function contentPacketResources(ids: string[], profileName = settings.profile, build = true) {
  const resources = new Map<string, MediaResource>();
  const profile = profiles[profileName];
  if (profile.packetization !== "tts-192" || !profile.pacing) throw new Error("Content Packet公開には192/PCR pacingプロファイルが必要です");
  for (const id of ids) {
    const p = programs.find(x => x.id === id && x.published);
    if (!p) throw new Error("Content Packet公開対象が見つかりません");
    const st = safeStat(p.filePath);
    if (!st?.isFile()) throw new Error("Content Packet公開対象が見つかりません");
    // Browse must never wait for a full-file index (including another request's
    // pending build). Unknown wrapped size is omitted, not estimated as exact.
    let size:number|undefined,durationSeconds:number|undefined;
    if(build){
      const ts=await inspectMedia(p.filePath),index=await buildPcrIndex(p.filePath);
      if(ts.packetSize!==188||!index)throw new Error("Content Packet公開対象の188バイトTS/PCRを確認できません");
      size=contentPacketLayout(mediaSize(st.size,profile),index.averageBitrate*192/188).servedBytes;
      if(profileName===REGZA_BUFFERED_PROFILE||(settings.timeSeekProgramIds??[]).includes(id))durationSeconds=packetTime(index,index.packetCount);
    }else{
      const summary=await cachedPcrSummary(p.filePath);
      if(summary){
        if(summary.packetCount!==Math.floor(st.size/188)||((profileName===REGZA_BUFFERED_PROFILE||(settings.timeSeekProgramIds??[]).includes(id))&&(summary.discontinuities||summary.invalidIntervals)))throw new Error('Content Packet公開対象の連続188バイトTS条件外');
        size=contentPacketLayout(mediaSize(st.size,profile),summary.averageBitrate*192/188).servedBytes;
        if(profileName===REGZA_BUFFERED_PROFILE||(settings.timeSeekProgramIds??[]).includes(id))durationSeconds=summary.seekDuration;
      }
    }
    const integrated = profileName === REGZA_BUFFERED_PROFILE;
    const seekable = integrated || (settings.timeSeekProgramIds ?? []).includes(id);
    const pcrPaced = !integrated && (settings.pcrPacingProgramIds ?? []).includes(id);
    resources.set(id, { url: `${baseUrl()}/media/${p.id}/${encodeURIComponent(p.title)}.ts?encapsulation=arib-content-packet${seekable ? '&seek=pcr' : ''}${pcrPaced ? '&pacing=pcr' : ''}`, ...(size!==undefined?{size}:{}),
      ...(seekable ? { profile: timeSeekProfile(profile) } : {}),...(durationSeconds!==undefined?{durationSeconds}:{}) });
  }
  return resources;
}

async function serveMedia(req: IncomingMessage, res: ServerResponse, id: string, programmeRevision?:string) {
  const p = programs.find(x => x.id === id && x.published);
  if (!p) return sendJson(res, 404, { error: "番組が見つかりません" });
  if(!await sourceContained(p.filePath,settings.folders))return sendJson(res,403,{error:'Source outside registered recording roots'});
  const releasePcr=pcrWork.reserve(p.filePath);res.once('close',releasePcr);res.once('finish',releasePcr);
  const st = safeStat(p.filePath);
  if (!st?.isFile()) return sendJson(res, 404, { error: "ファイルがありません" });
  let profile = profiles[settings.profile] || profiles.standard;
  const candidateProgramme=programmeRevision?await programmeProjection.resolve(p,profile):undefined;
  if(programmeRevision&&(!candidateProgramme||candidateProgramme.revision!==programmeRevision))return sendJson(res,410,{error:'Programme resource expired; Browse again'});
  const context = requests.get(req)!;
  const requestStarted = context.requestStartedMs as number;
  Object.assign(context, { programId: p.id, programTitle: p.title, savedProfile: profile.name });
  let ts;
  try {
    ts = await inspectMedia(p.filePath);
  } catch (e) {
    ts = { error: String(e) };
  }
  const convertTo192 = profile.packetization === "tts-192" && "packetSize" in ts && ts.packetSize === 188;
  let pcrIndex = null;
  let pcrIndexElapsedMs = 0;
  if ((convertTo192 || profile.pacing) && "pcrPid" in ts && ts.pcrPid !== null) {
    const indexStarted = Date.now();
    try {
      pcrIndex = await buildPcrIndex(p.filePath);
      pcrIndexElapsedMs = Date.now() - indexStarted;
    } catch (e) {
      log("PCR_INDEX", `索引作成失敗 ${p.title}`, String(e), req);
    }
  }
  // Index preparation is shared. A disconnected waiter must neither cancel it
  // for another Seek nor start an obsolete delivery once preparation finishes.
  if(req.aborted||res.destroyed){
    log('HTTP_MEDIA_END','索引待機中にクライアント切断',{outcome:'client-disconnected-during-index',sentBytes:0,pcrIndexElapsedMs,connectionElapsedMs:Date.now()-requestStarted},req);
    return;
  }
  const integrated = profile.name === REGZA_BUFFERED_PROFILE;
  const encapsulated = integrated || new URL(req.url!, "http://localhost").searchParams.get("encapsulation") === "arib-content-packet";
  const timeSeekEnabled = integrated || (encapsulated && new URL(req.url!, "http://localhost").searchParams.get('seek') === 'pcr' &&
    (settings.timeSeekProgramIds ?? []).includes(id));
  if (integrated && (!convertTo192 || !pcrIndex || pcrIndex.discontinuities || pcrIndex.invalidIntervals)) {
    log('HTTP_MEDIA_END', 'ZP2共通再生条件外', {responseStatus:422,sentBytes:0,outcome:'regza-playback-unavailable'},req);
    return sendJson(res,422,{error:'ZP2共通再生には188バイトTSと連続PCRが必要です'});
  }
  if (timeSeekEnabled) profile = timeSeekProfile(profile);
  if (encapsulated && (!convertTo192 || !profile.pacing || req.headers.range || (req.headers["timeseekrange.dlna.org"] && !timeSeekEnabled))) {
    log("HTTP_MEDIA_END", "Content Packet診断条件外", { responseStatus: 400, sentBytes: 0,
      outcome: "unsupported-content-packet-request", requestHeaders: req.headers }, req);
    return sendJson(res, 400, { error: "Content Packet診断は188→192/PCR pacingの通常GET/HEAD専用です。シーク未対応。" });
  }
  const payloadSize = convertTo192 ? mediaSize(st.size, profile) : st.size;
  const bitrate = p.duration && p.duration > 0
    ? st.size * 8 / p.duration
    : p.bitrate || 24_000_000;
  const sourceBitrate = pcrIndex?.averageBitrate || bitrate;
  const payloadBitrate = convertTo192 ? sourceBitrate * 192 / 188 : sourceBitrate;
  const paced = profile.pacing && req.method === "GET";
  const localPcrPacing = integrated || new URL(req.url!, 'http://localhost').searchParams.get('pacing') === 'pcr';
  // Preserve the diagnostic URI while normal playback selects the same policy.
  const leadParameter = new URL(req.url!, 'http://localhost').searchParams.get('pcrLeadMs');
  if (leadParameter !== null && (leadParameter !== String(REGZA_PCR_LEAD_MS) || !localPcrPacing || !encapsulated))
    return sendJson(res, 400, { error: `pcrLeadMs=${REGZA_PCR_LEAD_MS} is a diagnostic Content Packet/local-PCR condition only` });
  const pacingLeadMs = integrated || leadParameter !== null ? REGZA_PCR_LEAD_MS : 0;
  if (localPcrPacing && (!profile.pacing || !pcrIndex || pcrIndex.discontinuities || pcrIndex.invalidIntervals ||
      !('packetSize' in ts) || ![188, 192].includes(ts.packetSize!))) {
    log('HTTP_MEDIA_END', '局所PCR pacing条件外', { responseStatus: 422, outcome: 'local-pcr-unavailable', sentBytes: 0 }, req);
    return sendJson(res, 422, { error: '局所PCR pacingには188/192形式と連続PCRが必要です' });
  }
  if (profile.pacing && (!pcrIndex || !Number.isFinite(pcrIndex.averageBitrate) || pcrIndex.averageBitrate <= 0)) {
    log("HTTP_MEDIA_END", `PCR速度を算出できません ${p.title}`, {
      method: req.method, responseStatus: 422, outcome: "pcr-unavailable", sentBytes: 0, elapsedMs: 0,
      connectionElapsedMs: Date.now() - requestStarted,
      sourcePacketSize: "packetSize" in ts ? ts.packetSize : null
    }, req);
    return sendJson(res, 422, { error: "PCRから目標速度を算出できません。詳細診断を確認してください。" });
  }
  const programme=candidateProgramme;
  if(programmeRevision&&(!programme||!pcrIndex||programmePlan({...p,metadata:programme.metadata},pcrIndex,profile,st)?.revision!==programmeRevision))return sendJson(res,410,{error:'Programme resource expired; Browse again'});
  const contentPacket = encapsulated ? contentPacketLayout(payloadSize, payloadBitrate) : null;
  const servedSize = programme?.size ?? contentPacket?.servedBytes ?? payloadSize;
  const pacingBitrate = payloadBitrate * servedSize / (programme ? (programme.last-programme.first)*192 : payloadSize);
  let timeSlice: ReturnType<typeof timeSeekSlice> | null = null;
  let seekDuration: number | null = null;
  if (timeSeekEnabled) {
    try {
      seekDuration = programme?.duration ?? packetTime(pcrIndex!, pcrIndex!.packetCount);
      const header = req.headers['timeseekrange.dlna.org'];
      if(header!==undefined&&typeof header!=='string')throw new RangeError('Invalid TimeSeekRange');
      if(programme)timeSlice=programmeSlice(pcrIndex!,programme,typeof header==='string'?header:undefined);
      else if (header !== undefined) {
        if (typeof header !== 'string') throw new RangeError('Invalid TimeSeekRange');
        timeSlice = timeSeekSlice(pcrIndex!, contentPacket!.blockBytes, header);
      }
    } catch (error) {
      log('HTTP_MEDIA_END', '時間シーク範囲エラー', { responseStatus: 416, outcome: 'invalid-time-seek', sentBytes: 0,
        requestHeaders: req.headers, error: String(error) }, req);
      res.writeHead(416, { 'Content-Length': 0 }); res.end(); return;
    }
  }
  const common: Record<string, string | number> = {
    "Content-Type": profile.mime, "Accept-Ranges": timeSeekEnabled ? 'none' : "bytes", "transferMode.dlna.org": profile.transferMode,
    "contentFeatures.dlna.org": contentFeatures(profile), "Connection": "keep-alive"
  };
  if (seekDuration !== null) {
    common['availableSeekRange.dlna.org'] = `1 npt=0.000-${formatNpt(seekDuration)}`;
    common['Vary'] = 'TimeSeekRange.dlna.org';
  }
  let range;
  try {
    range = parseRange(req.headers.range, servedSize);
  } catch {
    res.writeHead(416, { "Content-Range": `bytes */${servedSize}`, "Content-Length": 0 }); res.end();
    log("RANGE", `416 ${p.title}`, req.headers, req);
    return;
  }

  const started = Date.now();
  const status = range ? 206 : 200;
  const start = timeSlice?.startByte ?? range?.start ?? 0;
  const end = timeSlice ? start + timeSlice.wireBytes - 1 : range?.end ?? servedSize - 1;
  const expectedBytes = end - start + 1;
  const outputPacketSize = convertTo192 ? 192 : ('packetSize' in ts ? ts.packetSize! : 188);
  const pacingFirstPacket = contentPacket ? timeSlice?.firstPacket ?? 0 : start / outputPacketSize;
  const pacingDuration = localPcrPacing ? packetTime(pcrIndex!, contentPacket ? timeSlice?.endPacket ?? pcrIndex!.packetCount : (end + 1) / outputPacketSize) - packetTime(pcrIndex!, pacingFirstPacket) : null;
  const targetBitsPerSecond = pacingDuration !== null ? expectedBytes * 8 / pacingDuration : pacingBitrate;
  const responseHeaders: Record<string, string | number> = {
    ...common,
    "Content-Length": expectedBytes,
    ...(seekDuration!==null ? { 'TimeSeekRange.dlna.org': `npt=${formatNpt(timeSlice?.actualStart??0)}-${formatNpt(timeSlice?.actualEnd??seekDuration)}/${formatNpt(seekDuration)} bytes=${start}-${end}/${servedSize}` } : {}),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${servedSize}` } : {})
  };

  if(programme){const current=safeStat(p.filePath);if(!current||current.size!==st.size||current.mtimeMs!==st.mtimeMs)return sendJson(res,410,{error:'Programme source changed'});}
  res.writeHead(status, responseHeaders);
  // Observation only: runs once AFTER finish/close, never awaited or used by delivery.
  if (process.env.PT3_SHADOW_DISABLED !== '1') attachShadow(res, { fingerprint: { path: path.resolve(p.filePath), size: st.size, mtimeMs: st.mtimeMs },
    remoteIp: req.socket.remoteAddress || '', requestId: String(context.connectionId ?? ''), trialId: trial?.id,
    method: req.method || '', headers: { ...req.headers },
    actualPlaybackPath: { handler: 'existing-serveMedia',programme:programme?{origin:programme.origin,revision:programme.revision}:null, profile: profile.name, protocolInfo: protocolInfo(profile),
      packetSize: outputPacketSize, contentPacket: !!contentPacket, timeSeekEnabled, range: range || null,
      timeSlice, pacing: paced, localPcrPacing, pacingLeadMs, responseStatus: status, responseHeaders } }, playbackShadow);
  log("HTTP_MEDIA", `${req.method} ${p.title}`, {
    programme:programme?{objectId:programme.id,revision:programme.revision,sourceOrigin:programme.origin,first:programme.first,last:programme.last}:null,
    method: req.method,
    actualPacketSize: convertTo192 ? 192 : "packetSize" in ts ? ts.packetSize : null,
    protocolInfo: protocolInfo(profile),
    declaredPacketization: profile.packetization,
    encapsulation: contentPacket ? { mode: "arib-content-packet", ...contentPacket, servedBytes:servedSize, blocks:programme?Math.ceil((programme.last-programme.first)*192/contentPacket.blockBytes):contentPacket.blocks,
      payloadBytes: programme?(programme.last-programme.first)*192:payloadSize, payloadBitsPerSecond: payloadBitrate, userDefinedHex: "000000000000000000" } : { mode: "none" },
    targetBitsPerSecond: paced ? targetBitsPerSecond : null,
    pacingMode: localPcrPacing ? 'local-pcr' : 'whole-file-average',
    pacingLeadMs,
    pacingDurationSeconds: pacingDuration,
    wholeFileBitsPerSecond: pacingBitrate,
    bitrateSource: pcrIndex ? "whole-file-pcr" : "metadata-fallback",
    sourceBitsPerSecond: sourceBitrate,
    pacing: paced ? "realtime" : "unlimited",
    pcrIndex: pcrIndex ? { sampleCount: pcrIndex.points.length, durationSeconds: pcrIndex.durationSeconds,
      averageBitrate: pcrIndex.averageBitrate, discontinuities: pcrIndex.discontinuities,
      invalidIntervals: pcrIndex.invalidIntervals } : null,
    requestHeaders: req.headers,
    preparationMs: started - requestStarted,
    responseStatus: status,
    responseHeaders,
    fileSize: st.size,
    servedSize,
    expectedBytes,
    range: range || null,
    timeSeek: { enabled: timeSeekEnabled, durationSeconds: seekDuration, slice: timeSlice },
    ts,
    conversion: convertTo192 ? {
      mode: pcrIndex
        ? `188-to-192-full-pcr-index-interpolated-ats${paced ? "-realtime-paced" : ""}`
        : `188-to-192-average-bitrate-fallback${paced ? "-realtime-paced" : ""}`,
      sourceBitrate: Math.round(sourceBitrate),
      outputBitrate: paced ? Math.round(targetBitsPerSecond) : null,
      pacing: paced ? "realtime" : "unlimited",
      atsClockHz: 27_000_000,
      atsOffsetMs: profile.atsOffsetMs,
      atsByteOrder: profile.atsByteOrder,
      atsClock: profile.atsClock,
      atsOrigin: profile.atsOrigin,
      atsCounterBits: profile.atsTopBits === 0 ? 32 : 30,
      atsTopBits: profile.atsTopBits === 0 ? 'timestamp-counter' : profile.atsTopBits.toString(2).padStart(2, "0"),
      atsRelation: profile.atsOffsetMs < 0
        ? `arrival-${Math.abs(profile.atsOffsetMs)}ms-before-pcr`
        : "arrival-equals-interpolated-pcr",
      pcrPid: ts && "pcrPid" in ts ? ts.pcrPid : null,
      pcrSamples: pcrIndex?.points.length ?? 0,
      pcrIndex: pcrIndex ? {
        coverage: "whole-file",
        firstPacket: pcrIndex.firstPacket,
        lastPacket: pcrIndex.lastPacket,
        packetCount: pcrIndex.packetCount,
        durationSeconds: pcrIndex.durationSeconds,
        discontinuities: pcrIndex.discontinuities,
        invalidIntervals: pcrIndex.invalidIntervals,
        buildOrCacheMs: pcrIndexElapsedMs
      } : null
    } : { mode: "source" }
  }, req);
  if (req.method === "HEAD") {
    res.end();
    log("HTTP_MEDIA_END", `HEAD完了 ${p.title}`, { outcome: "head", sentBytes: 0, expectedBytes,
      elapsedMs: Date.now() - started, connectionElapsedMs: Date.now() - requestStarted }, req);
    return;
  }

  let sentBytes = 0;
  let lastProgressBytes = 0;
  let lastProgressAt = started;
  const pacer = paced ? localPcrPacing
    ? new PcrPacingTransform(pcrIndex!, outputPacketSize, pacingFirstPacket, contentPacket?.blockBytes, pacingLeadMs)
    : new BitratePacingTransform(pacingBitrate) : null;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      sentBytes += chunk.length;
      callback(null, chunk);
    }
  });
  const progressTimer = setInterval(() => {
    const now = Date.now();
    const intervalMs = now - lastProgressAt;
    const intervalBytes = sentBytes - lastProgressBytes;
    log("HTTP_MEDIA_PROGRESS", `送信中 ${p.title}`, {
      sentBytes,
      expectedBytes,
      elapsedMs: now - started,
      averageBitsPerSecond: Math.round(sentBytes * 8 * 1000 / Math.max(1, now - started)),
      intervalBitsPerSecond: Math.round(intervalBytes * 8 * 1000 / Math.max(1, intervalMs)),
      pacing: pacer?.getStats() ?? null,
      writableLength: res.writableLength,
      writableNeedDrain: res.writableNeedDrain
    }, req);
    lastProgressBytes = sentBytes;
    lastProgressAt = now;
  }, 5000);
  progressTimer.unref();
  try {
    if (convertTo192) {
      const firstPacket = contentPacket ? timeSlice?.firstPacket ?? 0 : Math.floor(start / 192);
      const lastPacket = contentPacket ? (timeSlice?.endPacket ?? payloadSize / 192) - 1 : Math.floor(end / 192);
      const sourceStart = firstPacket * 188;
      const sourceEnd = Math.min(st.size - 1, (lastPacket + 1) * 188 - 1);
      const converter = new Tts192Transform(firstPacket, bitrate, contentPacket ? 0 : start - firstPacket * 192, contentPacket ? timeSlice?.payloadBytes ?? payloadSize : expectedBytes,
        pcrIndex, profile);
      if (contentPacket) {
        await pipeline(createReadStream(p.filePath, { start: sourceStart, end: sourceEnd }), converter,
          new ContentPacketTransform(timeSlice?.payloadBytes ?? payloadSize, contentPacket.blockBytes), pacer!, counter, res);
      } else if (pacer) {
        await pipeline(createReadStream(p.filePath, { start: sourceStart, end: sourceEnd }), converter, pacer, counter, res);
      } else {
        await pipeline(createReadStream(p.filePath, { start: sourceStart, end: sourceEnd }), converter, counter, res);
      }
    } else {
      const source = createReadStream(p.filePath, { start, end });
      if (pacer) await pipeline(source, pacer, counter, res);
      else await pipeline(source, counter, res);
    }
    log("HTTP_MEDIA_END", `送信完了 ${p.title}`, {
      outcome: "completed", sentBytes, expectedBytes, elapsedMs: Date.now() - started,
      connectionElapsedMs: Date.now() - requestStarted,
      averageBitsPerSecond: sentBytes * 8 * 1000 / Math.max(1, Date.now() - started),
      targetBitsPerSecond: paced ? targetBitsPerSecond : null,
      pacingMode: localPcrPacing ? 'local-pcr' : 'whole-file-average',
      pacing: pacer?.getStats() ?? null
    }, req);
  } catch (e: any) {
    const disconnected = e?.code === "ERR_STREAM_PREMATURE_CLOSE" || e?.code === "ECONNRESET" || req.aborted;
    log(disconnected ? "HTTP_MEDIA_END" : "ERROR", `${disconnected ? "クライアント切断" : "送信エラー"} ${p.title}`, {
      outcome: disconnected ? "client-disconnected" : "stream-error",
      sentBytes,
      expectedBytes,
      elapsedMs: Date.now() - started,
      connectionElapsedMs: Date.now() - requestStarted,
      averageBitsPerSecond: sentBytes * 8 * 1000 / Math.max(1, Date.now() - started),
      targetBitsPerSecond: paced ? targetBitsPerSecond : null,
      pacingMode: localPcrPacing ? 'local-pcr' : 'whole-file-average',
      pacing: pacer?.getStats() ?? null,
      errorCode: e?.code,
      error: String(e)
    }, req);
  } finally {
    clearInterval(progressTimer);
  }
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  const started = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const ip = req.socket.remoteAddress || "";
  if (!isPrivateAddress(ip)) return sendJson(res, 403, { error: "家庭内LANからのみ利用できます" });
  // Retired endpoints/assets stay unreachable even after an overlay leaves old files.
  if(/^\/(?:api\/dbr-color-trial(?:\/|$)|dbr-color-trial(?:[./]|$))/i.test(url.pathname))return sendJson(res,404,{error:'Not found'});
  const deviceRoute=/^\/(?:upnp\/|media\/|library\/|experimental\/|client-diagnostic\/|avc-http-control\/|avc-picture-trial\/|mpeg-ts-trial\/)/.test(url.pathname);
  if(!deviceRoute){const denied=managementAccess(req,boundPort||settings.port);if(denied)return sendJson(res,403,{error:denied});res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"frame-ancestors 'none'; base-uri 'none'");}
  if(req.method==='GET'&&/^\/(?:media\/|programme-v1\/|library\/(?:jit|direct)\/|experimental\/|client-diagnostic\/media\/|avc-http-control\/media\/|avc-picture-trial\/media\/|mpeg-ts-trial\/media\/)/.test(url.pathname)){
    activeMediaReads++;let released=false;const release=()=>{if(!released){released=true;activeMediaReads--;}};res.once('close',release);res.once('finish',release);
  }
  if (!sockets.has(req.socket)) sockets.set(req.socket, randomUUID());
  requests.set(req, { trialId: trial.id, savedProfile: settings.profile, connectionId: randomUUID(),
    socketId: sockets.get(req.socket), method: req.method, url: url.pathname, requestStartedMs: started });
  if(/^\/(?:library\/(?:jit|direct)\/|experimental\/(?:media|jit|catalog-jit)\/|client-diagnostic\/media\/|avc-http-control\/media\/|avc-picture-trial\/media\/|mpeg-ts-trial\/media\/)/.test(url.pathname)){
    const release=pcrWork.reserve();res.once('close',release);res.once('finish',release);
  }
  try{const observed=familyShadow.observe(ip,req.headers);if(observed)log('CLIENT_FAMILY_SHADOW','Implementation family observation',{...observed,request:requests.get(req)});}catch{}
  if(/^\/(?:media\/|programme-v1\/|library\/(?:jit|direct)\/|experimental\/(?:media|jit|catalog-jit)\/|client-diagnostic\/media\/|avc-http-control\/media\/|avc-picture-trial\/media\/|mpeg-ts-trial\/media\/)/.test(url.pathname))
    observeHttpTransfer(req,res,(event,detail)=>log('HTTP_TRANSFER',event,detail,req));
  try {
    if (url.pathname.startsWith("/api/")) {
      if(url.pathname==='/api/clients/mpeg2-trials'){
        if(req.method==='GET')return sendJson(res,200,await experimentalCatalog.mpeg2TrialStatus());
        if(req.method==='POST'){
          if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return sendJson(res,403,{error:'Same management origin required'});
          try{return sendJson(res,200,await experimentalCatalog.configureMpeg2Trial(JSON.parse(await body(req))));}catch(e){return sendJson(res,409,{error:String(e)});}
        }
        return sendJson(res,405,{error:'GET/POST only'});
      }
      if(url.pathname==='/api/clients/compatibility'){
        if(req.method==='GET')return sendJson(res,200,await experimentalCatalog.compatibilityStatus());
        if(req.method==='POST'){
          if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return sendJson(res,403,{error:'同じ管理画面から設定してください'});
          try{return sendJson(res,200,await experimentalCatalog.configureCompatibility(JSON.parse(await body(req))));}catch(e){return sendJson(res,409,{error:String(e)});}
        }
        return sendJson(res,405,{error:'GET/POST only'});
      }
      if (url.pathname === "/api/experimental/jit/status") return sendJson(res,200,experimentalCatalog.jitStatus());
      if (url.pathname === "/api/experimental/jit/clients") return sendJson(res,200,experimentalCatalog.automaticStatus());
      if (url.pathname === '/api/experimental/catalog/status') return sendJson(res,200,experimentalCatalog.backgroundStatus());
      if(url.pathname==='/api/media-scan'){
        if(req.method==='GET'){const s=experimentalCatalog.backgroundStatus();return sendJson(res,200,{...s,tsCount:programs.length,mediaTotal:programs.length+s.otherVideoCount+s.imageCount});}
        if(req.method==='POST'){try{const input=JSON.parse(await body(req));await experimentalCatalog.configureScanInterval(input.scanIntervalSeconds);return sendJson(res,200,experimentalCatalog.backgroundStatus());}catch(e){return sendJson(res,400,{error:String(e)});}}
        return sendJson(res,405,{error:'GET/POST only'});
      }
      if(url.pathname==='/api/pcr-cache'&&req.method==='GET')return sendJson(res,200,await pcrBackground.inspect());
      if(url.pathname==='/api/pcr-cache'&&req.method==='POST'){try{return sendJson(res,200,await pcrBackground.configure(JSON.parse(await body(req))));}catch(e){return sendJson(res,400,{error:String(e)});}}
      if(url.pathname==='/api/diagnostics/recording-didl'){
        if(!recordingDisplayTrial.status().enabled)return sendJson(res,404,{error:'Development trial disabled'});
        if(!recordingDidlTrialAccess(req.socket.remoteAddress,req.headers.host,String(req.headers.origin??'')||undefined,req.headers['content-type'],boundPort))return sendJson(res,403,{error:'Local JSON request required'});
        if(req.method==='GET')return sendJson(res,200,recordingDisplayTrial.status());
        if(req.method!=='POST')return sendJson(res,405,{error:'GET/POST only'});
        if(pcrWork.busy()||activeMediaReads||experimentalCatalog.jitStatus().some(s=>s.active||s.executors))return sendJson(res,409,{error:'Stop playback before changing the presentation trial'});
        try{const input=JSON.parse(await body(req,1024)),state=recordingDisplayTrial.select(input.condition,input.regzaIds===undefined?false:input.regzaIds,input.sceneProgramDate===undefined?false:input.sceneProgramDate,input.recordedStartDate===undefined?false:input.recordedStartDate);log('RECORDING_DIDL_TRIAL','Presentation condition selected',state);return sendJson(res,200,state);}catch(e){return sendJson(res,400,{error:String(e)});}
      }
      if (url.pathname === "/api/status") return sendJson(res, 200, { running: true, productVersion: PRODUCT_VERSION, buildId: process.env.PT3_BUILD_ID ?? null, baseUrl: baseUrl(), settings, trial,recordingDidlTrial:recordingDisplayTrial.status(),
        logStorage: { directory: diskLog.directory, maxBytes: diskLog.maxBytes, archives: diskLog.archives, error: logError },
        pcrCache: pcrIndexCacheStatus(),
        programCount: programs.length, logs: logs.slice(-20), interfaces: availableInterfaces() });
      if (url.pathname === "/api/trials" && req.method === "POST") {
        const input = JSON.parse(await body(req));
        if (input.programId !== undefined && !programs.some(p => p.id === input.programId)) return sendJson(res, 400, { error: "番組が見つかりません" });
        if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2000)) return sendJson(res, 400, { error: "メモは2000文字以内です" });
        return sendJson(res, 200, beginTrial(input.programId, input.note));
      }
      const observation = /^\/api\/trials\/([a-f0-9-]+)\/observation$/.exec(url.pathname);
      if (observation && req.method === "POST") {
        const target = trials.get(observation[1]);
        if (!target) return sendJson(res, 404, { error: "この起動中の試行IDを指定してください" });
        const input = JSON.parse(await body(req));
        if (![input.video, input.audio].every(v => v === true || v === false || v === null) ||
            (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2000))) {
          return sendJson(res, 400, { error: "映像・音声はtrue/false/null、メモは2000文字以内です" });
        }
        Object.assign(requests.get(req)!, { trialId: target.id, savedProfile: target.profile });
        const result = { video: input.video, audio: input.audio, note: input.note, source: "human" };
        log("TRIAL_OBSERVATION", "人による映像・音声確認", result, req);
        return sendJson(res, 200, result);
      }
      if (url.pathname === "/api/metadata/refresh" && req.method === "POST") {const values=await refreshMetadata();await pcrBackground.recheckMetadata(values.filter(p=>p.metadata?.state==='pending').map(p=>p.filePath));return sendJson(res,200,values);}
      if (url.pathname === "/api/programs") return sendJson(res, 200, programs);
      const diagnostic = /^\/api\/programs\/([a-f0-9]+)\/diagnostic$/.exec(url.pathname);
      if (diagnostic && req.method === "POST") {
        const p = programs.find(x => x.id === diagnostic[1]);
        if (!p) return sendJson(res, 404, { error: "番組が見つかりません" });
        const prefix = await readMediaPrefix(p.filePath);
        const [ffprobe, pcrIndex] = await Promise.all([
          ffprobeDiagnostic(p.filePath), buildPcrIndex(p.filePath)
        ]);
        const result = {
          program: { id: p.id, title: p.title, size: p.size, originalFilename: p.originalFilename, displayTitle: p.displayTitle, metadata: p.metadata }, ts: inspectTs(prefix), startup: inspectStartup(prefix),
          pcrIndex: pcrIndex ? {
            pid: pcrIndex.pid, coverage: "whole-file", sampleCount: pcrIndex.points.length,
            firstPacket: pcrIndex.firstPacket, lastPacket: pcrIndex.lastPacket,
            packetCount: pcrIndex.packetCount, durationSeconds: pcrIndex.durationSeconds,
            averageBitrate: pcrIndex.averageBitrate, discontinuities: pcrIndex.discontinuities,
            invalidIntervals: pcrIndex.invalidIntervals
          } : null,
          ffprobe
        };
        log("MEDIA_DIAGNOSTIC", p.title, result, req);
        return sendJson(res, 200, result);
      }
      if (url.pathname === "/api/logs") return sendJson(res, 200, logs);
      if (url.pathname === "/api/scan" && req.method === "POST") {await experimentalCatalog.rescan();return sendJson(res,200,programs);}
      if (url.pathname === "/api/settings" && req.method === "POST") {
        const patch = JSON.parse(await body(req));
        const allowed=new Set(['friendlyName','port','interfaceAddress','folders','profile','contentPacketProgramIds','timeSeekProgramIds','pcrPacingProgramIds']);
        if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!allowed.has(k)))return sendJson(res,400,{error:'Unknown settings field'});
        if(patch.port!==undefined&&(!Number.isInteger(patch.port)||patch.port<1024||patch.port>65535))return sendJson(res,400,{error:'Port must be 1024..65535'});
        if(patch.friendlyName!==undefined&&(typeof patch.friendlyName!=='string'||!patch.friendlyName.trim()||patch.friendlyName.length>128||/[\x00-\x1f\x7f]/.test(patch.friendlyName)))return sendJson(res,400,{error:'Invalid server name'});
        if(patch.interfaceAddress!==undefined&&patch.interfaceAddress!==''&&!Object.values(networkInterfaces()).flat().some(i=>i?.family==='IPv4'&&i.address===patch.interfaceAddress))return sendJson(res,400,{error:'Choose a local IPv4 address'});
        if(patch.folders!==undefined){if(!Array.isArray(patch.folders)||patch.folders.length>64)return sendJson(res,400,{error:'Invalid recording roots'});for(const f of patch.folders)if(typeof f!=='string'||!path.isAbsolute(f)||!(await fs.stat(f).catch(()=>undefined))?.isDirectory())return sendJson(res,400,{error:'Recording roots must be accessible absolute directories'});}
        if (patch.profile && !(patch.profile in profiles)) return sendJson(res, 400, { error: "不明な互換プロファイルです" });
        if (patch.pcrPacingProgramIds !== undefined || patch.profile !== undefined || patch.contentPacketProgramIds !== undefined) {
          const ids = patch.pcrPacingProgramIds ?? settings.pcrPacingProgramIds ?? [];
          const wrapped = patch.contentPacketProgramIds ?? settings.contentPacketProgramIds ?? [];
          if (!Array.isArray(ids) || ids.length > 32 || !ids.every((id: unknown) => typeof id === 'string' && /^[a-f0-9]+$/.test(id)) || new Set(ids).size !== ids.length)
            return sendJson(res, 400, { error: '局所PCR pacing対象IDの形式が不正です' });
          const candidate = profiles[(patch.profile ?? settings.profile) as typeof settings.profile];
          if (ids.length && (!Array.isArray(wrapped) || !ids.every((id: string) => wrapped.includes(id)) || !candidate.pacing || candidate.packetization !== 'tts-192'))
            return sendJson(res, 400, { error: '局所PCR pacing公開対象は192/PCR pacingのContent Packet対象に限定しています' });
          try { for (const id of ids) { const p = programs.find(p => p.id === id && p.published); if (!p) throw new Error('対象なし');
            const ts = await inspectMedia(p.filePath); if (![188, 192].includes(ts.packetSize!)) throw new Error('188/192形式が必要');
            const index = await buildPcrIndex(p.filePath); if (!index) throw new Error('PCRなし'); packetTime(index, index.packetCount); } }
          catch (error) { return sendJson(res, 400, { error: String(error) }); }
        }
        if (patch.timeSeekProgramIds !== undefined || patch.contentPacketProgramIds !== undefined) {
          const ids = patch.timeSeekProgramIds ?? settings.timeSeekProgramIds ?? [];
          const wrapped = patch.contentPacketProgramIds ?? settings.contentPacketProgramIds ?? [];
          if (!Array.isArray(ids) || ids.length > 32 || !Array.isArray(wrapped) ||
              !ids.every((id: unknown) => typeof id === 'string' && /^[a-f0-9]+$/.test(id) && wrapped.includes(id)) || new Set(ids).size !== ids.length)
            return sendJson(res, 400, { error: '時間シーク対象はContent Packet公開対象に限定しています' });
          const candidate = profiles[(patch.profile ?? settings.profile) as typeof settings.profile];
          if (ids.length && (candidate.packetization !== 'tts-192' || !candidate.pacing))
            return sendJson(res, 400, { error: '時間シークには192/PCR pacingプロファイルが必要です' });
          try { for (const id of ids) { const p = programs.find(p => p.id === id && p.published); if (!p) throw new Error('時間シーク対象がありません');
            const index = await buildPcrIndex(p.filePath); if (!index) throw new Error('PCRなし'); packetTime(index, index.packetCount); } }
          catch (error) { return sendJson(res, 400, { error: String(error) }); }
        }
        if (patch.contentPacketProgramIds !== undefined) {
          if (!Array.isArray(patch.contentPacketProgramIds) || patch.contentPacketProgramIds.length > 32 ||
              !patch.contentPacketProgramIds.every((id: unknown) => typeof id === "string" && /^[a-f0-9]+$/.test(id)) ||
              new Set(patch.contentPacketProgramIds).size !== patch.contentPacketProgramIds.length)
            return sendJson(res, 400, { error: "Content Packet公開対象IDの形式が不正です" });
          if (patch.contentPacketProgramIds.length) {
            try { await contentPacketResources(patch.contentPacketProgramIds, patch.profile ?? settings.profile); }
            catch (error) { return sendJson(res, 400, { error: String(error) }); }
          }
        }
        if (patch.folders !== undefined && (!Array.isArray(patch.folders) || !patch.folders.every((f: unknown) => typeof f === "string"))) return sendJson(res, 400, { error: "録画フォルダーの形式が不正です" });
        try { diskLog.assertSeparate(patch.folders ?? settings.folders); }
        catch (e) { return sendJson(res, 400, { error: String(e) }); }
        const rootsChanged=patch.folders!==undefined&&JSON.stringify(patch.folders)!==JSON.stringify(settings.folders);
        await updateSettings(patch);
        if(rootsChanged)void experimentalCatalog.rescan().catch(error=>log('ERROR','保存先変更後の全メディアスキャン失敗',String(error)));
        beginTrial();
        Object.assign(requests.get(req)!, { trialId: trial.id, savedProfile: settings.profile });
        log("SETTINGS", `互換プロファイルを保存: ${settings.profile}`, {
          profile: settings.profile, label: profiles[settings.profile].label
        }, req);
        if (process.env.PT3_DISABLE_SSDP !== "1") ssdp.start(localAddress());
        return sendJson(res, 200, settings);
      }
      if (url.pathname === "/api/self-test" && req.method === "POST") {
        const checks: any[] = [];
        checks.push({ name: "Device Description", ok: deviceXml(baseUrl()).includes(settings.udn) });
        checks.push({ name: "ContentDirectory", ok: true });
        checks.push({ name: "登録番組", ok: settings.folders.length === 0 || programs.length > 0, detail: settings.folders.length === 0 ? "動画フォルダー未登録（設定から追加できます）" : `${programs.length}件` });
        if (programs[0]) {
          const st = safeStat(programs[0].filePath);
          checks.push({ name: "Range解析", ok: !!st && parseRange("bytes=0-1023", st.size)?.start === 0 });
          const ts = await inspectMedia(programs[0].filePath);
          checks.push({ name: "TS同期", ok: ts.packetSize !== null, detail: `${ts.packetSize ?? "不明"}バイト` });
          checks.push({ name: "PCR時間軸", ok: !!ts.pcr,
            detail: ts.pcr ? `${ts.pcr.sampleCount}標本 / 約${Math.round(ts.pcr.estimatedBitrate / 1000)}kbps` : "PCRを検出できません" });
          const index = await buildPcrIndex(programs[0].filePath);
          checks.push({ name: "ファイル全体PCR索引", ok: !!index,
            detail: index ? `${index.points.length}標本 / ${index.firstPacket}〜${index.lastPacket} packet / 不連続${index.discontinuities}件` : "索引を作成できません" });
        }
        return sendJson(res, 200, checks);
      }
      return sendJson(res, 404, { error: "API not found" });
    }
    const avcMedia=/^\/avc-http-control\/media\/(fixed|chunked)$/.exec(url.pathname);
    const mpegTsMedia=/^\/mpeg-ts-trial\/media\/([a-f0-9-]{36})$/.exec(url.pathname);
    if(mpegTsMedia)return mpegTsTrial.media(req,res,mpegTsMedia[1],await experimentalCatalog.client(req));
    if(avcMedia)return avcControl.media(req,res,avcMedia[1],await experimentalCatalog.client(req));
    const pictureMedia=/^\/avc-picture-trial\/media\/([a-z0-9-]+)$/.exec(url.pathname);
    if(pictureMedia)return pictureTrial.media(req,res,pictureMedia[1],await experimentalCatalog.client(req));
    const diagnosticMedia=/^\/client-diagnostic\/media\/([a-f0-9-]{36})$/.exec(url.pathname);
    if(diagnosticMedia)return clientDiagnostics.media(req,res,diagnosticMedia[1]);
    const libraryImage=/^\/library\/image\/([a-f0-9]{32})$/.exec(url.pathname);
    if(libraryImage)return experimentalCatalog.imageMedia(req,res,libraryImage[1]);
    const libraryDirect=/^\/library\/direct\/([a-f0-9]{32})$/.exec(url.pathname);
    if(libraryDirect)return experimentalCatalog.directMedia(req,res,libraryDirect[1]);
    const libraryJit=/^\/library\/jit\/([a-f0-9]{32})$/.exec(url.pathname);
    if(libraryJit)return experimentalCatalog.libraryMedia(req,res,libraryJit[1]);
    const experimentalJit = /^\/experimental\/jit\/([a-f0-9]{32})$/.exec(url.pathname);
    if(experimentalJit) return experimentalCatalog.jitMedia(req,res,experimentalJit[1]);
    const catalogJit=/^\/experimental\/catalog-jit\/([a-f0-9]{32})$/.exec(url.pathname);
    if(catalogJit)return experimentalCatalog.jitMedia(req,res,catalogJit[1],true);
    const experimentalMedia = /^\/experimental\/media\/([a-f0-9]{32})$/.exec(url.pathname);
    if (experimentalMedia && (req.method === 'GET' || req.method === 'HEAD')) return experimentalCatalog.media(req, res, experimentalMedia[1]);
    const programmeRoute=/^\/programme-v1\/([a-f0-9]+)\/([a-f0-9]{24})\.tts$/.exec(url.pathname);
    if(url.pathname.startsWith('/programme-v1/')){if(!programmeProjection.enabled||!programmeRoute||!['GET','HEAD'].includes(req.method!))return sendJson(res,404,{error:'Not found'});return serveMedia(req,res,programmeRoute[1],programmeRoute[2]);}
    const media = /^\/media\/([a-f0-9]+)/.exec(url.pathname);
    if (media && (req.method === "GET" || req.method === "HEAD")) return serveMedia(req, res, media[1]);
    if (url.pathname === "/upnp/device.xml") { log("UPNP_HTTP", "GET Device Description", undefined, req); return xml(res, deviceXml(baseUrl())); }
    if (url.pathname === "/upnp/content-directory.xml") { log("UPNP_HTTP", "GET ContentDirectory SCPD", undefined, req); return xml(res, scpd("cd")); }
    if (url.pathname === "/upnp/connection-manager.xml") { log("UPNP_HTTP", "GET ConnectionManager SCPD", undefined, req); return xml(res, scpd("cm")); }
    if(url.pathname==='/upnp/event/content-directory'&&(req.method==='SUBSCRIBE'||req.method==='UNSUBSCRIBE'))return cdEvents.handle(req,res);
    if (url.pathname.startsWith("/upnp/event/") && req.method === "SUBSCRIBE") {
      const sid = String(req.headers.sid || `uuid:${crypto.randomUUID()}`);
      log("UPNP_EVENT", `SUBSCRIBE ${url.pathname}`, req.headers, req);
      res.writeHead(200, { SID: sid, TIMEOUT: "Second-1800", "Content-Length": 0 }); return res.end();
    }
    if (url.pathname.startsWith("/upnp/event/") && req.method === "UNSUBSCRIBE") {
      log("UPNP_EVENT", `UNSUBSCRIBE ${url.pathname}`, req.headers, req);
      res.writeHead(200, { "Content-Length": 0 }); return res.end();
    }
    if (url.pathname.startsWith("/upnp/control/") && req.method === "POST") {
      const payload = await body(req, 256 * 1024);
      await experimentalCatalog.observeClient(req,payload);
      const action = String(req.headers.soapaction || "").replaceAll('"', "").split("#").pop() || "";
      const profile = profiles[settings.profile] || profiles.standard;
      let browse = action === 'Browse' ? browseRequest(payload) : undefined;
      const programmeRequestedId=browse?.objectId;
      const programmeMetadata=programmeProjection.enabled&&browse?.metadata?parseProgrammeId(browse.objectId):null;
      if(programmeMetadata)browse={...browse!,objectId:programmeLegacyId(programmeMetadata)};
      const picturePage=browse?await pictureTrial.browse(browse,await experimentalCatalog.client(req),baseUrl()):undefined;
      const experimentalPage = browse && await experimentalCatalog.browse(browse, await experimentalCatalog.client(req), baseUrl(), metadata => browseDIDL('0', 0, 0, programs, baseUrl(), profile, metadata),true);
      if (experimentalPage && browse) {
        const entries = browse.metadata && browse.objectId.startsWith('experimental/item/') ? [await experimentalCatalog.entry(browse.objectId)] : browse.objectId === 'experimental' ? await experimentalCatalog.boundEntries() : [];
        for (const entry of entries) if (entry && !await experimentalCatalog.isJit(entry.objectId,await experimentalCatalog.client(req))) attachShadow(res, { fingerprint: entry.fingerprint, remoteIp: req.socket.remoteAddress || '', method: 'BrowseMetadata', headers: { ...req.headers }, actualPlaybackPath: 'experimental catalogue; prepared artifact only' }, async request => experimentalCatalog.observe(await experimentalCatalog.decide(request) ?? await playbackShadow(request)));
      }
      let resources = new Map<string, MediaResource>();
      if (profile.packetization === 'tts-192' && profile.pacing) {
        if (action === 'Browse') {
          const request = browse??browseRequest(payload);
          const integrated = !request.metadata && request.objectId==='all' && await experimentalCatalog.libraryEnabled();
          const count = integrated ? Math.min(request.count || 200, 200) : request.count;
          const selected = browsePrograms(request.objectId, request.start, count, programs, request.metadata).selected;
          const wrapped = new Set(settings.contentPacketProgramIds ?? []);
          if (settings.profile === REGZA_BUFFERED_PROFILE) {
            for (const p of selected) {
              try { for (const [id,resource] of await contentPacketResources([p.id],settings.profile,false)) resources.set(id,resource); }
              catch(error) { resources.set(p.id,{url:'',size:0,unavailable:true});log('MEDIA_RESOURCE',`再生条件外 ${p.title}`,String(error),req); }
            }
          } else resources = await contentPacketResources(selected.filter(p => wrapped.has(p.id)).map(p => p.id),settings.profile,false);
        } else if (action === 'GetProtocolInfo') {
          // Protocol declarations depend on settings, not a full-file PCR read.
          const wrapped = new Set(settings.contentPacketProgramIds ?? []);
          if (settings.profile === REGZA_BUFFERED_PROFILE || programs.some(p => p.published && wrapped.has(p.id) && (settings.timeSeekProgramIds ?? []).includes(p.id)))
            resources.set('time-seek', { url: '', size: 0, profile: timeSeekProfile(profile) });
        }
      }
      const libraryPage=browse&&!experimentalPage?await experimentalCatalog.libraryBrowse(browse,await experimentalCatalog.client(req),baseUrl(),(start,count,metadata,objectId)=>browseDIDL(objectId??browse.objectId,start,count,programs,baseUrl(),profile,metadata,resources,false)):undefined;
      const folderPage=browse?await experimentalCatalog.folderBrowse(browse,await experimentalCatalog.client(req),baseUrl(),async file=>{
        const p=programs.find(p=>p.published&&path.resolve(p.filePath).toLowerCase()===path.resolve(file).toLowerCase());if(!p)return;
        let r=new Map<string,MediaResource>();
        if(profile.packetization==='tts-192'&&profile.pacing&&(settings.profile===REGZA_BUFFERED_PROFILE||(settings.contentPacketProgramIds??[]).includes(p.id))){
          try{r=await contentPacketResources([p.id],settings.profile,false);}catch{r.set(p.id,{url:'',size:0,unavailable:true});}
        }
        const xml=browseDIDL(`item:${p.id}`,0,1,[p],baseUrl(),profile,true,r).didl;return /<item\b[\s\S]*?<\/item>/.exec(xml)?.[0];
      }):undefined;
      const normalPage=picturePage??folderPage??libraryPage;
      let result = normalPage?experimentalBrowseSoap({...normalPage,updateId:(systemUpdateId+(normalPage.updateId??0))>>>0},systemUpdateId):experimentalPage ? experimentalBrowseSoap({...experimentalPage,updateId:(systemUpdateId+(experimentalPage.updateId??0))>>>0}, systemUpdateId) : soapResponse(action, programmeMetadata?payload.replace(/<ObjectID>[\s\S]*?<\/ObjectID>/,`<ObjectID>${programmeLegacyId(programmeMetadata)}</ObjectID>`):payload, baseUrl(), programs, profile, resources);
      if(action==='GetSystemUpdateID'){const catalogUpdate=await experimentalCatalog.updateId();if(catalogUpdate)result=result.replace(/<Id>\d+<\/Id>/,`<Id>${(systemUpdateId+catalogUpdate)>>>0}</Id>`);}
      if (action === 'GetProtocolInfo') {
        const experimentalProtocols = await experimentalCatalog.protocolInfos(await experimentalCatalog.client(req));
        if (experimentalProtocols.length) result = result.replace(/<Source>([^<]*)<\/Source>/, (_, original) => `<Source>${original}${original ? ',' : ''}${escapeXml(experimentalProtocols.join(','))}</Source>`);
        const diagnosticProtocol=await clientDiagnostics.protocolInfo(req.socket.remoteAddress||'');
        if(diagnosticProtocol)result=result.replace(/<Source>([^<]*)<\/Source>/,(_,original)=>`<Source>${original}${original?',':''}${escapeXml(diagnosticProtocol)}</Source>`);
        const mpegTsProtocol=await mpegTsTrial.protocolInfo(await experimentalCatalog.client(req));
        if(mpegTsProtocol)result=result.replace(/<Source>([^<]*)<\/Source>/,(_,original)=>`<Source>${original}${original?',':''}${escapeXml(mpegTsProtocol)}</Source>`);
      }
      result=menuRevisionSoap(result,action);
      result=recordingDisplayTrial.soap(result,action);
      result=await programmeProjection.soap(result,action,programmeRequestedId,baseUrl(),profile);
      if(browse?.objectId==='0')result=appendPictureRoot(result,browse,await pictureTrial.count(await experimentalCatalog.client(req)));
      // Retain the actual Browse declaration without changing the playback profile.
      // Bound XML copies so a large catalogue does not exhaust JSONL retention.
      const xmlLimit = 64 * 1024;
      log("SOAP", action, {
        requestHeaders: req.headers,
        recordingDidlTrial:recordingDisplayTrial.status(),
        requestXml: payload.slice(0, xmlLimit), requestXmlTruncated: payload.length > xmlLimit,
        responseXml: result.slice(0, xmlLimit), responseXmlTruncated: result.length > xmlLimit,
        xmlLimitUtf16Units: xmlLimit,
        requestBytes: Buffer.byteLength(payload), responseBytes: Buffer.byteLength(result),
        responseSha256: createHash("sha256").update(result).digest("hex"),
        responseStatus: programmeMetadata&&result.includes('<s:Fault>')?500:200, protocolInfo: protocolInfo(profiles[settings.profile]),
        declaredPacketization: profiles[settings.profile].packetization
      }, req);
      return xml(res, result, programmeMetadata&&result.includes('<s:Fault>')?500:200);
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[\w.-]+$/.test(file)) return sendJson(res, 404, { error: "Not found" });
    const full = path.join(root, "public", file);
    const data = await fs.readFile(full);
    const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "Content-Length": data.length }); res.end(data);
  } catch (e) {
    log("ERROR", `${req.method} ${url.pathname}`, String(e), req);
    if (!res.headersSent) sendJson(res, 500, { error: String(e) }); else res.end();
  } finally {
    if (Date.now() - started > 1000) log("APP", `遅い要求 ${req.method} ${url.pathname}: ${Date.now() - started}ms`);
  }
}
function xml(res: ServerResponse, value: string, status=200) {
  res.writeHead(status, { "Content-Type": "text/xml; charset=utf-8", "Content-Length": Buffer.byteLength(value), "EXT": "" }); res.end(value);
}

await loadStore();
try{
 const file=path.resolve(process.env.PT3_DATA_DIR||'data','client-family-cache.json');
 if((await fs.stat(file)).size<=1048576){const cache=JSON.parse(await fs.readFile(file,'utf8'));if(cache.version===FAMILY_VERSION&&Array.isArray(cache.bindings))familyShadow=createFamilyShadow(cache.bindings);}
}catch{ /* Optional bounded diagnostic cache; no discovery at startup. */ }
diskLog.open(settings.folders);
beginTrial(undefined, "サーバー起動");
const server = http.createServer(handler);
const ssdp = new SsdpServer(() => baseUrl(), log);
server.on("error", e => { log("ERROR", "HTTPサーバー起動失敗", String(e)); process.exitCode = 1; });
server.listen(settings.port, process.env.PT3_BIND_LOOPBACK==='1'?'127.0.0.1':"0.0.0.0", async () => {
  boundPort = (server.address() as { port: number }).port;
  log("APP", `管理画面: http://localhost:${boundPort}`);
  if (process.env.PT3_DISABLE_SSDP !== "1") ssdp.start(localAddress());
  try{await experimentalCatalog.rescan();}catch(error){log('ERROR','初回全メディアスキャン失敗',String(error));}
  pcrBackground.start();experimentalCatalog.startBackground();
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cdEvents.close();ssdp.stop(); void Promise.all([experimentalCatalog.stopBackground(),pcrBackground.stop()]).finally(()=>server.close(() => process.exit(0))); });
