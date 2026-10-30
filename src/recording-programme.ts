import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Program } from './store.js';
import type { PcrIndex, Profile } from './core.js';
import { escapeXml } from './core.js';
import { validMetadata, metadataDisplay, type RecordingMetadata } from './recording-metadata.js';
import { regzaRecordingIdentity } from './recording-didl-trial.js';
import { packetTime, parseTimeSeek } from './time-seek.js';
import { contentPacketLayout } from './content-packet.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export const programmeEnabled = () => process.env.PT3_PROGRAMME_TIMELINE === '1';
export function parseProgrammeId(id: string) { const m = /^programme:([a-f0-9]+):([a-f0-9]{24})(?::([A-Za-z0-9_-]{1,256}))?$/.exec(id); if (!m)
    return null; if (m[3]) {
    const alias = Buffer.from(m[3], 'base64url').toString();
    if (!/^library\/folder-item\/[a-f0-9]{32}$/.test(alias) || Buffer.from(alias).toString('base64url') !== m[3])
        return null;
} return m; }
export const programmeLegacyId = (m: RegExpExecArray) => m[3] ? Buffer.from(m[3], 'base64url').toString() : 'item:' + m[1];
const displayId = (p: Programme, legacy: string) => legacy === 'item:' + p.sourceId ? p.id : p.id + ':' + Buffer.from(legacy).toString('base64url');
export type Programme = {
    metadata: RecordingMetadata;
    id: string;
    revision: string;
    sourceId: string;
    origin: number;
    first: number;
    last: number;
    duration: number;
    size: number;
    blockBytes: number;
    date: string;
    network: string;
    service: string;
};
function at(index: PcrIndex, seconds: number, ceil = false) { let a = 0, b = index.packetCount; while (a < b) {
    const mid = Math.floor((a + b + 1) / 2);
    if (packetTime(index, mid) <= seconds)
        a = mid;
    else
        b = mid - 1;
} if (ceil && packetTime(index, a) < seconds)
    a++; return Math.min(a, index.packetCount); }
/** Uses validated metadata/source/index evidence, never filename/model/UDN permits. */
export function programmePlan(p: Program, index: PcrIndex, profile: Profile, st: {
    size: number;
    mtimeMs: number;
}, now = Date.now()): Programme | undefined {
    if (!['.ts', '.mts', '.m2ts'].includes(path.extname(p.filePath).toLowerCase()))
        return;
    const m = p.metadata;
    if (!validMetadata(m) || m.state !== 'confirmed' || m.textSuspect || !['reservation', 'full-clock-overlap'].includes(m.method!) || !['reservation', 'recording-overlap'].includes(m.reason!))
        return;
    if (profile.name !== 'regza-zp2-buffered' || profile.packetization !== 'tts-192' || !profile.pacing || index.discontinuities || index.invalidIntervals || index.packetCount * 188 !== st.size || p.size !== st.size || Math.abs(Date.parse(p.modified) - st.mtimeMs) > 1 || now - st.mtimeMs < 120000)
        return;
    const scope = m.timelineScope;
    if (!scope || scope.state !== 'verified' || scope.sourceSize !== st.size || scope.sourceMtimeMs !== st.mtimeMs || scope.pcrPid !== index.pid || scope.serviceId !== m.serviceId || scope.transportStreamId !== m.transportStreamId || scope.originalNetworkId !== m.originalNetworkId)
        return;
    const event=scope.programme;
    if(event?.state!=='unique'||event.eventId!==m.eventId||event.startTime!==m.startTime||event.durationSeconds!==m.durationSeconds)return;
    const r = m.recordingRange, o = m.recordingOrigin, identity = regzaRecordingIdentity(m);
    if (!r || r.segments !== 1 || r.anchorCount < 3 || !identity)
        return;
    // Initial-origin confidence is independent of the stricter whole-range 250ms label.
    // For a bounded inconsistent range require verified initial anchors plus <= one
    // TOT quantisation unit of full-file spread. Never relabel that range consistent.
    // Two individually trusted clocks must also describe the same epoch.
    if (o?.state === 'estimated' && r.state === 'consistent' && Math.abs(Date.parse(o.startTime!) - Date.parse(r.startTime!)) > 250)
        return;
    let originDate: string | undefined;
    if (o?.state === 'estimated' && (r.state === 'consistent' || r.state === 'inconsistent' && Number.isFinite(r.spreadMs) && r.spreadMs! <= o.uncertaintySeconds! * 1000))
        originDate = o.startTime;
    else if (r.state === 'consistent')
        originDate = r.startTime;
    if (!originDate || !m.startTime || !(m.durationSeconds! > 0))
        return;
    const origin = (Date.parse(m.startTime) - Date.parse(originDate)) / 1000, end = origin + m.durationSeconds!;
    if (!Number.isFinite(origin) || origin < 0 || end > packetTime(index, index.packetCount))
        return;
    const first = at(index, origin, true), last = at(index, end);
    if (last <= first)
        return;
    const blockBytes = contentPacketLayout(index.packetCount * 192, index.averageBitrate * 192 / 188).blockBytes, payload = (last - first) * 192, duration = packetTime(index, last) - origin;
    const eventKey = hash([m.originalNetworkId, m.transportStreamId, m.serviceId, m.eventId, m.startTime]), revision = hash([1, eventKey, p.id, st.size, st.mtimeMs, origin, first, last, blockBytes, index.pid, hash(index.points), profile]);
    return { metadata: m, id: `programme:${p.id}:${eventKey}`, revision, sourceId: p.id, origin, first, last, duration, size: payload + Math.ceil(payload / blockBytes) * 14, blockBytes, date: new Date(Date.parse(m.startTime) + 9 * 3600000).toISOString().replace('Z', '+09:00'), ...identity };
}
export function programmeSlice(index: PcrIndex, p: Programme, header?: string) {
    const requested = header ? parseTimeSeek(header, p.duration) : { start: 0, end: p.duration }, per = p.blockBytes / 192, firstPacket = Math.max(p.first, p.first + Math.floor((at(index, requested.start + p.origin) - p.first) / per) * per), endPacket = Math.min(p.last, Math.max(firstPacket + per, p.first + Math.ceil((at(index, requested.end + p.origin) - p.first + (requested.end < p.duration ? 1 : 0)) / per) * per)), payloadBytes = (endPacket - firstPacket) * 192;
    const actualStart = packetTime(index, firstPacket) - p.origin;
    if (actualStart < 0)
        throw new RangeError('Negative programme origin');
    return { requested, duration: p.duration, firstPacket, endPacket, payloadBytes, startByte: (firstPacket - p.first) * 192 + Math.floor((firstPacket - p.first) / per) * 14, wireBytes: payloadBytes + Math.ceil(payloadBytes / p.blockBytes) * 14, actualStart, actualEnd: packetTime(index, endPacket) - p.origin };
}
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const noSuchProgramme=()=>`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>701</errorCode><errorDescription>No Such Object</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
const duration = (s: number) => { const ms = Math.round(s * 1000); return `${Math.floor(ms / 3600000)}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${(ms % 60000 / 1000).toFixed(3).padStart(6, '0')}`; };
export function createProgrammeProjection(enabled: boolean, deps: {
    programs: () => Program[];
    metadata: (file: string) => Promise<Program['metadata']>;
    index: (file: string, key: string) => Promise<PcrIndex | null | undefined>;
    requestWarm?: (file: string) => Promise<void>;
}) {
    // A fresh boot epoch prevents a restarted development projection from reusing
    // a previous cached whole/programme directory revision. No persistent DB.
    let revision = enabled ? (Date.now() >>> 0) : 0;
    const observed = new Map<string, string>(), pending = new Set<string>(), plans = new Map<string, {
        key: string;
        source: string;
        plan?: Omit<Programme, 'metadata'>;
    }>();
    const changed = (id: string, key: string) => { if (observed.get(id) !== key) {
        const prior = observed.get(id);
        observed.delete(id);
        observed.set(id, key);
        if (prior !== undefined)
            revision++;
        if (observed.size > 4096)
            observed.delete(observed.keys().next().value!);
    } };
    async function input(p: Program, profile: Profile) { const st = await fs.stat(p.filePath), metadata = await deps.metadata(p.filePath), m = metadata; const key = hash([p.id, p.filePath, st.size, st.mtimeMs, profile, m?.state, m?.method, m?.reason, m?.textSuspect, m?.serviceId, m?.transportStreamId, m?.originalNetworkId, m?.eventId, m?.startTime, m?.durationSeconds, m?.recordingOrigin, m?.recordingRange, m?.timelineScope, m?.channelInfo]); return { st, metadata, key }; }
    function remember(p: Program, key: string, plan: Programme | undefined) { const compact = plan ? (({ metadata, ...rest }) => rest)(plan) : undefined; plans.delete(p.id); plans.set(p.id, { key, source: p.filePath, plan: compact }); if (plans.size > 4096)
        plans.delete(plans.keys().next().value!); pending.delete(key); changed(p.id, plan?.revision ?? 'whole'); }
    async function resolve(p: Program, profile: Profile) { if (!enabled)
        return; try {
        const x = await input(p, profile);
        if (!validMetadata(x.metadata) || x.metadata.state !== 'confirmed' || x.metadata.timelineScope?.state !== 'verified') {
            remember(p, x.key, undefined);
            return;
        }
        const index = await deps.index(p.filePath, `${x.st.size}:${x.st.mtimeMs}`), plan = index ? programmePlan({ ...p, metadata: x.metadata }, index, profile, x.st) : undefined;
        remember(p, x.key, plan);
        return plan;
    }
    catch {
        changed(p.id, 'whole');
        return;
    } }
    async function plan(p: Program, profile: Profile) { if (!enabled)
        return; if (!deps.requestWarm)
        return resolve(p, profile); try {
        const x = await input(p, profile);
        if (!validMetadata(x.metadata) || x.metadata.state !== 'confirmed' || x.metadata.timelineScope?.state !== 'verified') {
            remember(p, x.key, undefined);
            return;
        }
        const cached = plans.get(p.id);
        if (cached?.key === x.key)
            return cached.plan ? { ...cached.plan, metadata: x.metadata } : undefined;
        changed(p.id, 'whole');
        if (!pending.has(x.key) && pending.size < 4096) {
            pending.add(x.key);
            void deps.requestWarm(p.filePath).catch(() => pending.delete(x.key));
        }
        return;
    }
    catch {
        changed(p.id, 'whole');
        return;
    } }
    return { enabled, get revision() { return revision; }, invalidate(source?: string) { if (enabled) {
            if (source) {
                for (const [id, p] of plans)
                    if (p.source === source)
                        plans.delete(id);
            }
            else
                plans.clear();
            revision++;
        } }, plan, resolve, warm: resolve,
        async soap(xml: string, action: string, requestedId: string | undefined, base: string, profile: Profile) {
            if (!enabled)
                return xml;
            if (action === 'Browse') {
                const outer = /<Result>([\s\S]*?)<\/Result>/.exec(xml);
                if (outer) {
                    let didl = decode(outer[1]);
                    const matches = [...didl.matchAll(/<item\b[^>]*\bid="([^"]+)"[\s\S]*?<\/item>/g)];
                    for (const match of matches) {
                        const oldId = match[1], url = /<res\b[^>]*>([^<]*)<\/res>/.exec(match[0])?.[1], source = /^item:([a-f0-9]+)$/.exec(oldId)?.[1] ?? (/^library\/folder-item\/[a-f0-9]{32}$/.test(oldId) && url?.startsWith(base + '/media/') ? /\/media\/([a-f0-9]+)\//.exec(url)?.[1] : undefined);
                        const p = deps.programs().find(p => p.id === source && p.published);
                        if (!p)
                            continue;
                        let item = match[0].replace(/<upnp:class>[\s\S]*?<\/upnp:class>/, '<upnp:class>object.item.videoItem</upnp:class>');
                        const legacy = requestedId === oldId, plan = legacy ? undefined : await (parseProgrammeId(requestedId ?? '') ? this.resolve(p, profile) : this.plan(p, profile)), nextId = plan ? displayId(plan, oldId) : undefined;
                        if (parseProgrammeId(requestedId ?? '') && nextId !== requestedId)
                            return noSuchProgramme();
                        item = item.replace(/<upnp:recordedStartDateTime>[\s\S]*?<\/upnp:recordedStartDateTime>/g, '');
                        const metadata = plan?.metadata ?? await deps.metadata(p.filePath), display = metadataDisplay({ ...p, metadata }), date = plan?.date ?? display.date;
                        const setTag = (name: string, value: string | undefined) => { item = item.replace(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`, 'g'), ''); if (value)
                            item = item.replace('<res', `<${name}>${escapeXml(value)}</${name}><res`); };
                        if (display.channelInfo && !item.includes('xmlns:arib='))
                            item = item.replace('<item ', '<item xmlns:arib="urn:schemas-arib-or-jp:elements-1-0/" ');
                        setTag('upnp:channelNr', display.channelInfo?.channelNr === undefined ? undefined : String(display.channelInfo.channelNr));
                        setTag('arib:objectType', display.channelInfo?.objectType);
                        setTag('upnp:genre', display.genre);
                        setTag('dc:title', display.title);
                        setTag('dc:description', display.description);
                        setTag('upnp:channelName', validMetadata(metadata) ? metadata.station : undefined);
                        setTag('upnp:scheduledStartTime', display.scheduledStartTime);
                        setTag('upnp:scheduledEndTime', display.scheduledEndTime);
                        const identity = regzaRecordingIdentity(metadata);
                        item = item.replace(/<regza:(network_id|service_id)>[\s\S]*?<\/regza:\1>/g, '');
                        if (identity) {
                            item = item.replace(/<regza:(network_id|service_id)>[\s\S]*?<\/regza:\1>/g, '');
                            if (!item.includes('xmlns:regza='))
                                item = item.replace('<item ', '<item xmlns:regza="urn:schemas-toshiba-co-jp:regzadata-1-0" ');
                            item = item.replace('</item>', `<regza:network_id>${identity.network}</regza:network_id><regza:service_id>${identity.service}</regza:service_id></item>`);
                        }
                        setTag('dc:date', date);
                        if (plan) {
                            item = item.replace(`id="${oldId}"`, `id="${nextId}"`);
                            item = item.replace(/<res\b([^>]*)>[\s\S]*?<\/res>/, (whole, attrs: string) => { const clean = attrs.replace(/\s(?:size|duration)="[^"]*"/g, ''); return `<res${clean} size="${plan.size}" duration="${duration(plan.duration)}">${escapeXml(base)}/programme-v1/${p.id}/${plan.revision}.tts</res>`; });
                        }
                        didl = didl.replace(match[0], item);
                    }
                    if(parseProgrammeId(requestedId??'')&&!didl.includes(`id="${requestedId}"`))return noSuchProgramme();
                    xml = xml.replace(outer[0], `<Result>${escapeXml(didl)}</Result>`);
                }
            }
            const tag = action === 'Browse' ? 'UpdateID' : action === 'GetSystemUpdateID' ? 'Id' : null;
            return tag ? xml.replace(new RegExp(`<${tag}>(\\d+)</${tag}>`), (_, n) => `<${tag}>${(Number(n) + revision) >>> 0}</${tag}>`) : xml;
        } };
}
