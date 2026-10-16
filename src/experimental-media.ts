import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { escapeXml } from "./core.js";
import { CD_SERVICE, CM_SERVICE, scpd } from "./upnp.js";
import { mp4DirectExperiment } from "./playback-strategy.js";
import type { PcrIndex } from "./core.js";
import { PcrPacingTransform } from "./pacing.js";
import { ContentPacketTransform } from "./content-packet.js";
import { experimentalLayout, contentPacketRange, ExperimentalRangeSlice, pcrBoundedBlockBytes } from "./experimental-content-packet.js";
import { timeSeekSlice, packetTime, formatNpt } from "./time-seek.js";

export const mp4Features = "DLNA.ORG_OP=01;DLNA.ORG_CI=0";
export const mp4ProtocolInfo = `http-get:*:video/mp4:${mp4Features}`;
export interface ExperimentalMediaConfig {
  file: string; title: string; durationSeconds: number; address: string; port: number; udn: string;
  mode?: "direct" | "remux";
  ssdp?: boolean;
  contentPacket?: boolean;
  timeSeek?: boolean;
  audioTreatment?: "mpeg2-aac-lc" | "ac3-reference";
  videoTreatment?: "vui-variable" | "cfr-idr" | "vfr-idr" | "interlaced-reference" | "progressive-reference";
  dlnaProfile?: "AVC_TS_HD_60_AC3_T";
  videoEncoder?: "h264_nvenc" | "libx264";
  pcrInsertionIntervalMs?: 50;
  transportTreatment?: "cbr-copyts-off";
  contentPacketMaxSeconds?: number;
  contentPacketBlockBytes?: number;
  videoFrameRate?: "30000/1001" | "60000/1001";
  pcrLeadMs?: number;
}
export const EXPERIMENTAL_REMUX_LEAD_MS = 1100;
export function experimentalFormat(config: ExperimentalMediaConfig) {
  const remux = config.mode === "remux";
  if (config.timeSeek && (!remux || config.dlnaProfile !== undefined)) throw new Error("Time seek experiment requires JP TTS (raw framing is diagnostic only)");
  if (config.dlnaProfile !== undefined && (config.dlnaProfile !== "AVC_TS_HD_60_AC3_T" || !remux || config.audioTreatment !== "ac3-reference" || config.videoTreatment !== "interlaced-reference")) throw new Error("HD60 profile requires the isolated AVC/AC3 reference");
  const mime = remux ? "video/vnd.dlna.mpeg-tts" : "video/mp4";
  const features = remux ? `DLNA.ORG_PN=${config.dlnaProfile ?? "AVC_TS_JP_AAC_T"};DLNA.ORG_OP=${config.timeSeek ? "10" : "01"};DLNA.ORG_CI=1` : mp4Features;
  return { remux, mime, features, protocolInfo: `http-get:*:${mime}:${features}`,
    objectId: remux ? "tts:sampleA" : "mp4:sampleA", uri: `http://${config.address}:${config.port}/media/sampleA.${remux ? "tts" : "mp4"}`,
    strategy: remux ? { mode: "remux", container: "mpegts", copyVideo: !["cfr-idr", "vfr-idr", "interlaced-reference", "progressive-reference"].includes(config.videoTreatment ?? ""), copyAudio: config.audioTreatment !== "ac3-reference", compatibility: "experimental" } : mp4DirectExperiment };
}
export type ExperimentLog = (category: string, message: string, detail?: unknown) => void;
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number, end: number;
  if (!match[1]) { const length = Number(match[2]); if (!Number.isSafeInteger(length) || length <= 0) return null; start = Math.max(0, size - length); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(size - 1, end) };
}
const envelope = (body: string) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;
export function experimentalDidl(config: ExperimentalMediaConfig, size: number, object = "exp", metadata = false) {
  const format = experimentalFormat(config);
  const container = (id: string, parent: string, title: string) => `<container id="${id}" parentID="${parent}" restricted="1" childCount="1"><dc:title>${title}</dc:title><upnp:class>object.container</upnp:class></container>`;
  const duration = `${Math.floor(config.durationSeconds / 3600)}:${String(Math.floor(config.durationSeconds / 60) % 60).padStart(2, "0")}:${(config.durationSeconds % 60).toFixed(3).padStart(6, "0")}`;
  const item = `<item id="${format.objectId}" parentID="exp" restricted="1"><dc:title>${escapeXml(config.title)}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="${format.protocolInfo}" size="${size}" duration="${duration}">${format.uri}</res></item>`;
  let entries: string[] = [];
  if (metadata) entries = object === "0" ? [container("0", "-1", "PT3 Experimental Media")] : object === "exp" ? [container("exp", "0", "Experimental Media")] : object === format.objectId ? [item] : [];
  else entries = object === "0" ? [container("exp", "0", "Experimental Media")] : object === "exp" ? [item] : [];
  return { entries, wrap: (selected: string[]) => `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${selected.join("")}</DIDL-Lite>` };
}
export function experimentalDevice(config: ExperimentalMediaConfig) {
  return `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>DLNA Video Server Experimental Media (MP4 Direct)</friendlyName><manufacturer>Local Recording Server Project</manufacturer><modelName>MP4 Direct Experiment</modelName><UDN>${escapeXml(config.udn)}</UDN><serviceList>${[[CD_SERVICE, "ContentDirectory", "content-directory"], [CM_SERVICE, "ConnectionManager", "connection-manager"]].map(([type, id, name]) => `<service><serviceType>${type}</serviceType><serviceId>urn:upnp-org:serviceId:${id}</serviceId><SCPDURL>/upnp/${name}.xml</SCPDURL><controlURL>/upnp/control/${name}</controlURL><eventSubURL>/upnp/event/${name}</eventSubURL></service>`).join("")}</serviceList></device></root>`;
}
/** One allowlisted pre-generated file; never starts FFmpeg or loads the normal store. */
export function createExperimentalHandler(config: ExperimentalMediaConfig, log: ExperimentLog, index?: PcrIndex) {
  const format = experimentalFormat(config);
  if (!config.file.toLowerCase().endsWith(format.remux ? ".m2ts" : ".mp4") || !Number.isFinite(config.durationSeconds) || config.durationSeconds <= 0 || !/^uuid:[a-f\d-]+$/i.test(config.udn)) throw new Error("Invalid media experiment config");
  if (format.remux && (!index || index.discontinuities || index.invalidIntervals || index.points.length < 2)) throw new Error("Remux requires validated continuous PCR");
  if (config.contentPacket && !format.remux) throw new Error("Content Packet experiment requires remux TTS");
  if (config.contentPacketMaxSeconds !== undefined && (!config.contentPacket || !format.remux)) throw new Error("Block time experiment requires wrapped remux");
  if (config.contentPacketBlockBytes !== undefined && (!config.contentPacket || !format.remux || config.contentPacketMaxSeconds !== undefined)) throw new Error("Fixed block experiment requires wrapped remux without time override");
  if (config.videoFrameRate !== undefined && (config.videoTreatment !== "cfr-idr" || !["30000/1001", "60000/1001"].includes(config.videoFrameRate))) throw new Error("Frame rate experiment requires CFR video");
  if (config.pcrLeadMs !== undefined && (!format.remux || !Number.isFinite(config.pcrLeadMs) || config.pcrLeadMs < 0 || config.pcrLeadMs > 10000)) throw new Error("Invalid experimental PCR lead");
  const leadMs = config.pcrLeadMs ?? EXPERIMENTAL_REMUX_LEAD_MS;
  const blockTime = config.contentPacketMaxSeconds === undefined ? undefined : pcrBoundedBlockBytes(index!, config.contentPacketMaxSeconds);
  const layout = (size: number) => experimentalLayout(size, index?.averageBitrate ?? 0, !!config.contentPacket, config.contentPacketBlockBytes ?? blockTime?.blockBytes);
  let trialId = randomUUID();
  let active = 0;
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url || "").split("?")[0];
    log("HTTP_REQUEST", "Experimental HTTP request", { trialId, method: req.method, url: req.url, remote: req.socket.remoteAddress, headers: req.headers });
    const xml = (body: string) => { res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8", "Content-Length": Buffer.byteLength(body) }); res.end(body); };
    if (url === "/api/status" && req.method === "GET") {
      const handle = await open(config.file, "r");
      let mediaLayout; try { mediaLayout = layout((await handle.stat()).size); } finally { await handle.close(); }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ running: true, trialId, timeSeek: !!config.timeSeek, activeConnections: active, strategy: format.strategy, protocolInfo: format.protocolInfo, contentPacket: !!config.contentPacket, audioTreatment: config.audioTreatment ?? "copy", videoTreatment: config.videoTreatment ?? "copy", videoEncoder: config.videoEncoder ?? null, pcrInsertionIntervalMs: config.pcrInsertionIntervalMs ?? null, transportTreatment: config.transportTreatment ?? null, videoFrameRate: config.videoFrameRate ?? null, contentPacketBlockBytes: config.contentPacketBlockBytes ?? null, contentPacketMaxSeconds: config.contentPacketMaxSeconds ?? null, blockTime, ...mediaLayout, ...(format.remux ? { pacing: "local-pcr", leadMs } : {}) })); return;
    }
    if (url === "/api/trials" && req.method === "POST") {
      if (active) { res.writeHead(409); res.end("Active media connection"); return; }
      trialId = randomUUID(); log("TRIAL", "Experimental media trial created", { trialId, videoTreatment: config.videoTreatment ?? "copy", videoEncoder: config.videoEncoder ?? null, pcrInsertionIntervalMs: config.pcrInsertionIntervalMs ?? null, transportTreatment: config.transportTreatment ?? null, audioTreatment: config.audioTreatment ?? "copy", videoFrameRate: config.videoFrameRate ?? null, contentPacketBlockBytes: config.contentPacketBlockBytes ?? null, contentPacketMaxSeconds: config.contentPacketMaxSeconds ?? null, leadMs, blockTime }); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ trialId })); return;
    }
    if (url === "/upnp/device.xml" && req.method === "GET") { xml(experimentalDevice(config)); return; }
    if (/^\/upnp\/(content-directory|connection-manager)\.xml$/.test(url) && req.method === "GET") { xml(scpd(url.includes("content-directory") ? "cd" : "cm")); return; }
    // Static isolated catalogue uses the same minimal subscription acknowledgement as the normal server.
    if (/^\/upnp\/event\/(content-directory|connection-manager)$/.test(url) && (req.method === "SUBSCRIBE" || req.method === "UNSUBSCRIBE")) {
      log("UPNP_EVENT", req.method, { trialId, headers: req.headers });
      res.writeHead(200, { "Content-Length": 0, ...(req.method === "SUBSCRIBE" ? { SID: String(req.headers.sid || `uuid:${randomUUID()}`), TIMEOUT: "Second-1800" } : {}) }); res.end(); return;
    }
    if (/^\/upnp\/control\/(content-directory|connection-manager)$/.test(url) && req.method === "POST") {
      let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 65536) { res.writeHead(413); res.end(); return; } }
      const action = String(req.headers.soapaction || "").replace(/"/g, "").split("#")[1];
      const field = (name: string) => new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)<`, "i").exec(body)?.[1] || "";
      if (action === "Browse") {
        const handle = await open(config.file, "r"); let size: number; try { size = (await handle.stat()).size; } finally { await handle.close(); }
        const result = experimentalDidl(config, layout(size).servedBytes, field("ObjectID"), field("BrowseFlag") === "BrowseMetadata");
        const start = Number(field("StartingIndex") || 0), count = Number(field("RequestedCount") || 0);
        if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0) { res.writeHead(400); res.end(); return; }
        const selected = result.entries.slice(start, count ? start + count : undefined);
        const didl = result.wrap(selected); log("SOAP", "Experimental Browse", { trialId, request: body, didl });
        xml(envelope(`<u:BrowseResponse xmlns:u="${CD_SERVICE}"><Result>${escapeXml(didl)}</Result><NumberReturned>${selected.length}</NumberReturned><TotalMatches>${result.entries.length}</TotalMatches><UpdateID>1</UpdateID></u:BrowseResponse>`)); return;
      }
      const service = url.includes("content-directory") ? CD_SERVICE : CM_SERVICE;
      const responses: Record<string, string> = { GetProtocolInfo: `<Source>${format.protocolInfo}</Source><Sink/>`, GetSystemUpdateID: "<Id>1</Id>", GetSearchCapabilities: "<SearchCaps/>", GetSortCapabilities: "<SortCaps/>", GetCurrentConnectionIDs: "<ConnectionIDs/>", GetCurrentConnectionInfo: "<RcsID>-1</RcsID><AVTransportID>-1</AVTransportID><ProtocolInfo/><PeerConnectionManager/><PeerConnectionID>-1</PeerConnectionID><Direction>Output</Direction><Status>Unknown</Status>" };
      if (action && Object.hasOwn(responses, action)) xml(envelope(`<u:${action}Response xmlns:u="${service}">${responses[action]}</u:${action}Response>`));
      else { res.writeHead(500, { "Content-Type": "text/xml" }); res.end(envelope('<s:Fault><faultcode>s:Client</faultcode><faultstring>Invalid Action</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault>')); }
      return;
    }
    if (url !== new URL(format.uri).pathname) { res.writeHead(404); res.end(); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return; }
    const connectionId = randomUUID(), currentTrial = trialId, started = performance.now(); let bytes = 0, reason = "completed";
    active++;
    const handle = await open(config.file, "r").catch(error => { active--; throw error; });
    try {
      const sourceBytes = (await handle.stat()).size;
      const mediaLayout = layout(sourceBytes), size = mediaLayout.servedBytes;
      const seekDuration = config.timeSeek ? packetTime(index!, index!.packetCount) : undefined;
      let timeSlice: ReturnType<typeof timeSeekSlice> | undefined;
      if (config.timeSeek && req.headers.range !== undefined) {
        reason = "unsupported-byte-range";
        log("HTTP_MEDIA", "Byte Range rejected by time-seek contract", {trialId:currentTrial,connectionId,method:req.method,headers:req.headers,status:400,reason});
        res.writeHead(400, {"Content-Length":0,"Accept-Ranges":"none","contentFeatures.dlna.org":format.features}); res.end(); return;
      }
      if (config.timeSeek && req.headers["timeseekrange.dlna.org"] !== undefined) {
        try {
          const value = req.headers["timeseekrange.dlna.org"];
          if (typeof value !== "string") throw new RangeError("Invalid TimeSeekRange");
          timeSlice = timeSeekSlice(index!, mediaLayout.blockBytes ?? 192, value);
          // Raw experiment keeps the time-seek declaration, without Content Packet headers.
          if (!config.contentPacket) timeSlice = {...timeSlice, startByte: timeSlice.firstPacket * 192, wireBytes: timeSlice.payloadBytes};
        } catch {
          reason = "invalid-time-seek";
          log("HTTP_MEDIA", "Invalid time seek", {trialId:currentTrial,connectionId,method:req.method,headers:req.headers,status:416,reason});
          res.writeHead(416, {"Content-Length":0,"Accept-Ranges":"none","contentFeatures.dlna.org":format.features}); res.end(); return;
        }
      }
      const requestedRange = req.method === "GET" ? req.headers.range : undefined;
      const range = timeSlice ? {start:timeSlice.startByte,end:timeSlice.startByte+timeSlice.wireBytes-1} : byteRange(requestedRange, size);
      const status = range ? requestedRange ? 206 : 200 : 416;
      log("HTTP_MEDIA", "Experimental media request", { trialId: currentTrial, connectionId, method: req.method, range: req.headers.range, headers: req.headers, remote: req.socket.remoteAddress, status, size, sourceBytes, contentPacket: !!config.contentPacket, audioTreatment: config.audioTreatment ?? "copy", videoTreatment: config.videoTreatment ?? "copy", videoEncoder: config.videoEncoder ?? null, pcrInsertionIntervalMs: config.pcrInsertionIntervalMs ?? null, transportTreatment: config.transportTreatment ?? null, videoFrameRate: config.videoFrameRate ?? null, contentPacketBlockBytes: config.contentPacketBlockBytes ?? null, contentPacketMaxSeconds: config.contentPacketMaxSeconds ?? null, blockBytes: mediaLayout.blockBytes, leadMs, selectedRange: range, mime: format.mime, protocolInfo: format.protocolInfo, strategy: format.strategy });
      const headers: Record<string, string | number> = { "Content-Type": format.mime, "Accept-Ranges": config.timeSeek ? "none" : "bytes", "contentFeatures.dlna.org": format.features, "transferMode.dlna.org": "Streaming" };
      if (seekDuration !== undefined) { headers["availableSeekRange.dlna.org"] = `1 npt=0.000-${formatNpt(seekDuration)}`; headers.Vary = "TimeSeekRange.dlna.org"; }
      if (timeSlice) headers["TimeSeekRange.dlna.org"] = `npt=${formatNpt(timeSlice.actualStart)}-${formatNpt(timeSlice.actualEnd)}/${formatNpt(timeSlice.duration)} bytes=${range!.start}-${range!.end}/${size}`;
      if (!range) { res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 }); res.end(); return; }
      headers["Content-Length"] = range.end - range.start + 1;
      if (requestedRange) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
      log("HTTP_MEDIA_RESPONSE", "Experimental response contract", {trialId:currentTrial,connectionId,status,responseHeaders:headers,timeSeek:!!config.timeSeek,timeSlice:timeSlice ?? null});
      res.writeHead(status, headers);
      if (req.method === "HEAD") { res.end(); return; }
      const enclosing = timeSlice && config.contentPacket ? {sourceStart:timeSlice.firstPacket*192,sourceEnd:timeSlice.endPacket*192-1,skip:0,length:timeSlice.wireBytes} : mediaLayout.blockBytes === undefined ? undefined : contentPacketRange(sourceBytes, mediaLayout.blockBytes, range.start, range.end);
      const sourceStart = enclosing?.sourceStart ?? range.start, sourceEnd = enclosing?.sourceEnd ?? range.end;
      const stream = handle.createReadStream({ start: sourceStart, end: sourceEnd, autoClose: false });
      stream.on("data", chunk => { bytes += chunk.length; });
      const pacer = format.remux ? new PcrPacingTransform(index!, 192, sourceStart / 192, mediaLayout.blockBytes, leadMs) : undefined;
      const wrapper = enclosing ? new ContentPacketTransform(sourceEnd - sourceStart + 1, mediaLayout.blockBytes!) : undefined;
      const slice = enclosing ? new ExperimentalRangeSlice(enclosing.skip, enclosing.length) : undefined;
      if (enclosing) log("HTTP_RANGE_MAPPING", "Content Packet enclosing block mapping", { trialId: currentTrial, connectionId, ...enclosing, firstPacket: sourceStart / 192, pacingOrigin: "enclosing-block-PCR", requestedStart: range.start });
      const progress = pacer ? setInterval(() => log("HTTP_MEDIA_PROGRESS", "Remux PCR pacing", { trialId: currentTrial, connectionId, elapsedMs: performance.now() - started, ...pacer.getStats(), writableLength: res.writableLength, writableNeedDrain: res.writableNeedDrain }), 1000) : undefined;
      progress?.unref();
      try { if (wrapper && pacer && slice) await pipeline(stream, wrapper, pacer, slice, res); else if (pacer) await pipeline(stream, pacer, res); else await pipeline(stream, res); }
      catch (error) { reason = req.aborted || res.destroyed ? "client-disconnected" : "error"; if (reason === "error") log("ERROR", "Media stream error", String(error)); }
      finally { if (progress) clearInterval(progress); if (pacer) log("HTTP_PACING_END", "Remux pacing ended", { trialId: currentTrial, connectionId, elapsedMs: performance.now() - started, ...pacer.getStats() }); }
    } finally {
      await handle.close(); active--;
      log("HTTP_MEDIA_END", "Experimental media ended", { trialId: currentTrial, connectionId, bytes, durationMs: performance.now() - started, reason, counterMeaning: "file bytes read into HTTP pipeline; pacing sentBytes is separate; neither proves receiver decode" });
    }
  };
  return async (req: IncomingMessage, res: ServerResponse) => { try { await handler(req, res); } catch (error) { log("ERROR", "Experimental HTTP error", String(error)); if (!res.headersSent) res.writeHead(500); res.end(); } };
}
export function createExperimentalServer(config: ExperimentalMediaConfig, log: ExperimentLog, index?: PcrIndex) {
  const handler = createExperimentalHandler(config, log, index);
  return createServer((req, res) => { void handler(req, res); });
}
