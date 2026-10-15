import {sourceProtection} from './source-protection.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { DiagnosticLog } from './diagnostic-log.js';
import { xmlValue } from './experimental-renderer.js';
import { isPrivateAddress } from './core.js';
import {endpointFamilyFeatures,classifyClientFamily} from './client-family.js';
import { runShadow, snapshotHash, SHADOW_VERSION, type SourceSnapshot, type CapabilitySnapshot, type ShadowPolicy, type ShadowRequest, type ShadowRecord } from './playback-shadow.js';

export const shadowDirectory = () => path.resolve(process.env.PT3_SHADOW_DIR || path.join(process.env.PT3_DATA_DIR || 'data', 'playback-shadow'));
export const sourceCacheFile = (directory: string, file: string) => path.join(directory, 'sources', `${snapshotHash(path.resolve(file))}.json`);
export interface RegisteredDmp { remoteIp: string; deviceId?: string; descriptionUrl: string; controlUrl: string; allowEmptySink?:boolean }
const normalizedIp = (ip: string) => ip.replace(/^::ffff:/, '');
export async function readShadowJson<T>(file: string, signal?: AbortSignal): Promise<T | undefined> {
  try {
    const st = await fs.stat(file); if (st.size > 8 * 1024 * 1024) throw new Error('Shadow cache too large');
    return JSON.parse((await fs.readFile(file, { encoding: 'utf8', signal })).replace(/^\uFEFF/, ''));
  } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
}
const cacheWrites=new Map<string,Promise<void>>();
export async function saveShadowJson(file: string, value: unknown) {
  const key=path.resolve(file),json=JSON.stringify(value);
  const task=(async()=>{
  await cacheWrites.get(key)?.catch(()=>{});
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try{await fs.writeFile(temporary, json,{flag:'wx'});await fs.rename(temporary, file);}
  finally{await fs.rm(temporary,{force:true});}
  })();cacheWrites.set(key,task);
  try{await task;}finally{if(cacheWrites.get(key)===task)cacheWrites.delete(key);}
}
async function boundedResponse(response: Response) {
  if (!response.ok) throw new Error(`Capability HTTP ${response.status}`);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of response.body!) { bytes += chunk.length; if (bytes > 256 * 1024) throw new Error('Capability XML too large'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString('utf8');
}
function safeDeviceUrl(urlText: string, remoteIp: string) {
  const url = new URL(urlText);
  if (url.protocol !== 'http:' || url.hostname !== normalizedIp(remoteIp) || !isPrivateAddress(url.hostname) || url.username || url.password) throw new Error('Registered DMP URL must match private request IP');
  return url;
}
/** Only read-only device description and ConnectionManager:GetProtocolInfo. */
export async function acquireCapability(device: RegisteredDmp, signal: AbortSignal): Promise<CapabilitySnapshot> {
  const description = safeDeviceUrl(device.descriptionUrl, device.remoteIp), control = safeDeviceUrl(device.controlUrl, device.remoteIp);
  const descriptionResponse = await fetch(description, { redirect: 'error', signal });
  const xml = await boundedResponse(descriptionResponse);
  const actualId = xmlValue(xml, 'UDN');
  if (!actualId || (device.deviceId && actualId !== device.deviceId)) throw new Error('DMP identity changed at registered IP; re-register required');
  const service = 'urn:schemas-upnp-org:service:ConnectionManager:1';
  const response = await boundedResponse(await fetch(control, { method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${service}#GetProtocolInfo"` },
    body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetProtocolInfo xmlns:u="${service}"/></s:Body></s:Envelope>` }));
  if (/<(?:\w+:)?Fault\b/.test(response)) throw new Error('GetProtocolInfo SOAP fault');
  const sink = xmlValue(response, 'Sink').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  if (!sink&&(!device.allowEmptySink||!device.deviceId)) throw new Error('Empty Sink advertisement');
  const implementation=classifyClientFamily(endpointFamilyFeatures(xml,[descriptionResponse.headers.get('server')??'']).signals);
  return { deviceId: actualId, remoteIp: normalizedIp(device.remoteIp), controlUrl: control.href, sink, sinkHash: snapshotHash(sink), acquiredAt: new Date().toISOString(), origin: 'current-read',
    implementation:{version:implementation.version,fingerprint:implementation.fingerprint,family:implementation.family} };
}

/** Serial bounded, cache-only work, after actual response. Never spawns a probe/encoder. */
export function createShadowStore(directory: string, recordingFolders: () => string[]) {
  let tail: Promise<unknown> = Promise.resolve(), queued = 0;
  let log: DiagnosticLog | undefined;
  const records = (r: ShadowRecord) => {
    try {
      new DiagnosticLog(directory).assertSeparate([...recordingFolders(), path.dirname(r.request.fingerprint.path)]);
      if (!log) { log = new DiagnosticLog(path.join(directory, 'logs')); log.open(recordingFolders()); }
      log.assertSeparate([...recordingFolders(), path.dirname(r.request.fingerprint.path)]); log.append(r);
    } catch (e) { console.error('Shadow log storage failure (actual playback unaffected):', String(e)); }
  };
  const deps = {
    async source(request: ShadowRequest, signal: AbortSignal) {
      const now = await fs.stat(request.fingerprint.path);
      if (now.size !== request.fingerprint.size || now.mtimeMs !== request.fingerprint.mtimeMs) return undefined;
      const cached = await readShadowJson<SourceSnapshot>(sourceCacheFile(directory, request.fingerprint.path), signal);
      if ((cached?.characteristics.video.displayTicks?.length ?? 0) > 12000 || (cached?.characteristics.video.removalTicks?.length ?? 0) > 12000) return undefined;
      return cached;
    },
    async capability(request: ShadowRequest, signal: AbortSignal) {
      new DiagnosticLog(directory).assertSeparate([...recordingFolders(), path.dirname(request.fingerprint.path)]);
      const devices = await readShadowJson<RegisteredDmp[]>(path.join(directory, 'devices.json'), signal) ?? [];
      const matching = devices.filter(d => normalizedIp(d.remoteIp) === normalizedIp(request.remoteIp));
      if (matching.length !== 1) return undefined; // NAT/ambiguous clients are not inferred from model/User-Agent.
      const device = matching[0], file = path.join(directory, 'capabilities', `${snapshotHash(device.deviceId ?? device.descriptionUrl)}.json`);
      const cached = await readShadowJson<CapabilitySnapshot>(file, signal);
      if (cached && (!device.deviceId || cached.deviceId === device.deviceId) && cached.remoteIp === normalizedIp(request.remoteIp) && cached.controlUrl === device.controlUrl &&
        cached.sinkHash === snapshotHash(cached.sink) && Date.now() - Date.parse(cached.acquiredAt) >= 0 && Date.now() - Date.parse(cached.acquiredAt) < 300_000) return { ...cached, origin: 'cached-read' as const };
      const current = await acquireCapability(device, signal);
      if (!signal.aborted) await saveShadowJson(file, current);
      return current;
    },
    async policy(signal: AbortSignal) {
      return await readShadowJson<ShadowPolicy>(path.join(directory, 'policy.json'), signal) ?? { version: 'unconfigured', profiles: [], observations: [], capabilities: { encoders: [], decoders: [] } };
    }, record: records
  };
  return (request: ShadowRequest): Promise<ShadowRecord> => {
    if (queued >= 32) return runShadow(request, { ...deps, source: async () => undefined, capability: async () => undefined, policy: async () => ({ version: 'queue-limit', profiles: [], observations: [], capabilities: { encoders: [], decoders: [] } }) });
    queued++;
    const work = tail.then(() => runShadow(request, deps));
    tail = work.catch(() => {}).finally(() => { queued--; });
    return work;
  };
}

/** Offline probe adapter: display timestamps only; no source HRD/CPB claims. */
export function sourceFromProbe(file: string, fingerprint: { size: number; mtimeMs: number }, probe: any): SourceSnapshot {
  const video = probe.streams?.find((s: any) => s.codec_type === 'video'), audio = probe.streams?.find((s: any) => s.codec_type === 'audio');
  if (!video) throw new Error('No video stream');
  const format = probe.format?.format_name ?? '', container = format.includes('mpegts') ? 'mpegts' : format.includes('matroska') ? 'matroska' : format.includes('mp4') || format.includes('mov') ? 'mp4' : format;
  const times: number[] = (probe.frames ?? []).filter((f: any) => f.media_type === 'video').map((f: any) => Math.round(Number(f.best_effort_timestamp_time ?? f.pts_time) * 90000));
  const ordered = times.length > 0 && times.every((t, i) => Number.isSafeInteger(t) && (!i || t > times[i - 1]));
  return { version: SHADOW_VERSION, fingerprint: { path: path.resolve(file), ...fingerprint }, analyzedAt: new Date().toISOString(), scanScope: 'bounded first ~150s; ffprobe display timeline, not full source HRD audit',
    characteristics: { ...(sourceProtection(probe)?{protection:sourceProtection(probe)}:{}),transport: { container, framing: container === 'mpegts' ? 'ts188' : 'file', mime: container === 'mp4' ? 'video/mp4' : container === 'mpegts' ? 'video/mpeg' : ({avi:'video/x-msvideo',asf:'video/x-ms-asf',ogg:'video/ogg',mpeg:'video/mpeg'} as Record<string,string>)[container]??'video/x-matroska', seek: 'byte' },
      video: { codec: video.codec_name, profile: video.profile, level: video.level, codedWidth: video.coded_width || video.width, codedHeight: video.coded_height || video.height,...(video.display_aspect_ratio?{displayAspectRatio:video.display_aspect_ratio}:{}),
        bitDepth: video.pix_fmt?.includes('10') ? 10 : ['yuv420p','yuvj420p'].includes(video.pix_fmt) ? 8 : undefined, chroma: /^yuvj?420/.test(video.pix_fmt??'') ? '420' : undefined,...(video.pix_fmt==='yuvj420p'?{fullRange:true}:{}),
        scan: video.field_order === 'progressive' ? 'progressive' : ['tt', 'bb', 'tb', 'bt'].includes(video.field_order) ? 'interlaced' : undefined,
        ...(ordered ? { displayTicks: times, timebase: 90000 } : {}) },
      ...(audio ? { audio: { codec: audio.codec_name, format: audio.codec_name === 'aac' ? 'aac-unspecified-mpeg-id' : audio.codec_name, channels: audio.channels, sampleRate: Number(audio.sample_rate) } } : {}),
      validation: { value: false, evidence: { status: 'inferred', reference: 'ffprobe bounded scan', scope: 'metadata and display PTS only; syntax/HRD/CPB unverified' } } } };
}
