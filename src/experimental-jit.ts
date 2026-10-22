import {evaluateH264AviCfrTrial,matchingH264AviCfrTrial,type ReceiverH264AviCfrTrial} from './receiver-h264-avi-cfr-trial.js';
import {selectDualAudio,dualAudioBinding,type DualAudioPermission} from './jit-dual-audio.js';
import {scopedWmaInputPermission,wmaInputBinding,type WmaInputPermission} from './wma-input-permission.js';
import {createReceiverCompatibility} from './receiver-compatibility.js';
import {receiverCfrBinding,type ReceiverCfrTrial} from './receiver-cfr-trial.js';
import {receiverVideoCfrTrial,matchingReceiverWmvCfrTrial,evaluateReceiverWmvCfrTrial,type ReceiverWmvCfrTrial} from './receiver-wmv-cfr-trial.js';
import {isMpeg2JitTarget,MPEG2_JIT_PROTOCOL,MPEG2_JIT_FEATURES,mpeg2Seek} from './mpeg2-jit-target.js';
import {matchingJitTrial,type JitClientTrial} from './jit-client-trial.js';
import {parseSinkProtocolInfo} from './playback-decision.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExperimentalEntry } from './experimental-catalog.js';
import { matchingFingerprint, snapshotHash, type Fingerprint, type ShadowPolicy, type CapabilitySnapshot } from './playback-shadow.js';
import { readShadowJson, saveShadowJson, shadowDirectory, acquireCapability, type RegisteredDmp } from './playback-shadow-store.js';
import { execute, ffprobe,ffmpeg } from './prepare-executor.js';
import { createJitServer, JIT_FEATURES, JIT_PROTOCOL } from './jit-server.js';
import { minimumRemovalTicks } from './cadence-normalization.js';
import { seekCheckpoints, resolveJitSeek, JitSeekUnavailableError, jitSeekFailureStatus } from './jit-seek.js';
import { parseTimeSeek, timeSeekErrorStatus } from './time-seek.js';
import {catalogJitCandidate} from './catalog-jit-candidate.js';
import {chooseJitTiming,rejectJitTiming,type JitTimingMode} from './jit-timing-policy.js';
import {installedJitDecoders} from './jit-source-support.js';
import {randomUUID} from 'node:crypto';
import {JitRequestQueue,type JitRequestLease} from './jit-request-queue.js';
import {resolveJitClient} from './jit-client-policy.js';
import {createAutomaticJitClients,AUTOMATIC_CLIENT_VERSION} from './automatic-jit-client.js';
import {discoverClientEndpoints} from './client-family-discovery.js';
import {selectClientAdmission,type ClientAdmissions,type ClientAdmission} from './jit-client-admission.js';

export interface ExperimentalJitPolicy {
  version: 'experimental-jit-v1'; enabled: boolean; targetProfile: string; policy: ShadowPolicy;
  capabilities: CapabilitySnapshot[];
  items: { objectId: string; sourceFingerprint: Fingerprint; durationSeconds: number }[];
  catalogMetadataResources?:boolean;
  catalogGenericView?:boolean;
  timingPolicy?:JitTimingMode;
  clientTrials?:JitClientTrial[];
  receiverCfrTrials?:ReceiverCfrTrial[];
  receiverWmvCfrTrials?:ReceiverWmvCfrTrial[];
  receiverH264AviCfrTrials?:ReceiverH264AviCfrTrial[];
  dualAudioPermissions?:DualAudioPermission[];
  wmaInputPermissions?:WmaInputPermission[];
  automaticClients?:{version:typeof AUTOMATIC_CLIENT_VERSION;enabled:boolean;priority?:'automatic-first'|'individual-first';automaticOnlyDeviceIds?:string[];legacyInputs?:boolean;wmaInputs?:import('./wma-input-scope.js').WmaInputPolicy};
  clientAdmissions?:ClientAdmissions;
  /** Bounded capacity; preparation, playback and replacement cleanup share a slot. */
  maxConcurrentSessions?:1|2;
  /** Transient selected request view; never persisted by policy writers. */
  _admission?:Omit<ClientAdmission,'policy'>;
}
export interface JitResource { protocolInfo: string; durationSeconds: number; targetProfile: string; clientBinding?:string }
export type JitTrace = (category: string, detail: unknown) => void;
const normalizedIp = (s: string) => s.replace(/^::ffff:/, '');
export const jitMetadataPath = (directory: string, fingerprint: Fingerprint) => path.join(directory, 'jit-metadata', `${snapshotHash(JSON.stringify({ version: 1, path: fingerprint.path, size: fingerprint.size, mtimeMs: fingerprint.mtimeMs }))}.json`);
export function hevcFrameSequence(header:string){
 const values=(name:string)=>[...header.matchAll(new RegExp('\\b'+name+'\\s+[01]+\\s*=\\s*([01])','g'))].map(m=>Number(m[1]));
 const fields=values('field_seq_flag'),info=values('frame_field_info_present_flag');
 return fields.length&&info.length&&fields.every(v=>v===0)&&info.every(v=>v===0)?'frame-sequence':undefined;
}

/** Metadata-only, lazy and persistent. Never collects a full frame JSON. */
export async function inspectJitMetadata(directory: string, fingerprint: Fingerprint, signal?:AbortSignal) {
  const file = jitMetadataPath(directory, fingerprint);
  const cached = await readShadowJson<{ fingerprint: Fingerprint; probe: any }>(file).catch(() => undefined);
  const cacheHit=!!(cached&&matchingFingerprint(cached.fingerprint,fingerprint)&&Number(cached.probe?.format?.duration)>0);
  const probe=cacheHit?cached!.probe:JSON.parse((await execute(ffprobe(), ['-v', 'error', '-probesize','4194304','-analyzeduration','2000000', '-show_streams', '-show_format', '-of', 'json', fingerprint.path], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,signal })).stdout);
  let headerProbe=false;
  if(probe.streams?.some((s:any)=>s.codec_type==='video'&&s.codec_name==='hevc'&&!s.field_order)&&!probe.inputPictureStructureEvidence){
    const result=await execute(ffmpeg(),['-nostdin','-hide_banner','-loglevel','info','-probesize','4194304','-analyzeduration','2000000','-i',fingerprint.path,'-map','0:v:0','-c:v','copy','-bsf:v','trace_headers','-frames:v','1','-f','null','-'],{windowsHide:true,timeout:30000,maxBuffer:1048576,signal});
    probe.inputPictureStructure=hevcFrameSequence(result.stderr);
    probe.inputPictureStructureEvidence={status:'stream-header',reference:'HEVC SPS field_seq_flag / frame_field_info_present_flag; no decode',scope:'coded picture structure; source scan remains unknown'};headerProbe=true;
  }
  assert.ok(Number(probe.format?.duration) > 0);
  const after = await fs.stat(fingerprint.path);
  assert.ok(after.size === fingerprint.size && after.mtimeMs === fingerprint.mtimeMs, 'Source changed during metadata probe');
  const decoders=await installedJitDecoders();if(JSON.stringify(probe.executionDecoders)!==JSON.stringify(decoders)){probe.executionDecoders=decoders;headerProbe=true;}
  if(!cacheHit||headerProbe)await saveShadowJson(file, { fingerprint, probe });
  return { probe, cacheHit };
}

type Runtime = Awaited<ReturnType<typeof createJitServer>>;
interface Dependencies {
  inspect: typeof inspectJitMetadata;
  capability: typeof acquireCapability;
  createRuntime: typeof createJitServer;
  timing: typeof chooseJitTiming;
  devices: () => Promise<RegisteredDmp[]>;
  discover:typeof discoverClientEndpoints;
}

/** Opt-in sources only. Runtime objects are client/resource scoped, never a global transcoder. */
export function createExperimentalJit(directory: string, trace: JitTrace, overrides: Partial<Dependencies> = {}) {
  const deps = { inspect: inspectJitMetadata, capability: acquireCapability, createRuntime: createJitServer, timing:chooseJitTiming,
    devices: async () => await readShadowJson<RegisteredDmp[]>(path.join(shadowDirectory(), 'devices.json')) ?? [], ...overrides };
  const automatic=createAutomaticJitClients(directory,trace,async(remote,known=[],diagnostic)=>
    (deps.discover??discoverClientEndpoints)(remote,[...known,...await deps.devices()],diagnostic));
  const selectionLogs=new Map<string,string>();
  const sessions = new Map<string, { key: string; runtime: Runtime }>();
  const preparing = new Set<string>();
  const timingPreparing = new Set<string>();
  let arrival=0;
  const requests=new JitRequestQueue(trace);
  const arrivals=new WeakMap<IncomingMessage,{began:number;generation:number;requestId:string}>();
  function receive(req:IncomingMessage){let stamp=arrivals.get(req);if(!stamp){stamp={began:performance.now(),generation:++arrival,requestId:randomUUID()};arrivals.set(req,stamp);}return stamp;}
  let policyStamp=-1,policyValue:ExperimentalJitPolicy|undefined,policyJob:Promise<ExperimentalJitPolicy|undefined>|undefined,policyFingerprint:string|undefined,policyRevision=0;
  async function policy() {
    const file=path.join(directory,'jit.json');
    const stamp=await fs.stat(file).then(s=>s.mtimeMs).catch(()=>-1);
    if(stamp===policyStamp&&policyValue)return policyValue;
    if(policyJob)return policyJob;
    policyJob=(async()=>{const p = await readShadowJson<ExperimentalJitPolicy>(path.join(directory, 'jit.json')).catch(() => undefined);
    const fingerprint=snapshotHash(JSON.stringify(p??null));if(policyFingerprint!==undefined&&policyFingerprint!==fingerprint)policyRevision++;policyFingerprint=fingerprint;
    if (!p?.enabled || p.version !== 'experimental-jit-v1' || !Array.isArray(p.items) || !Array.isArray(p.capabilities) || !p.policy?.profiles) return undefined;
    // Diagnostic identity scope, never a family-classification feature. Keep the
    // stored registrations intact, but remove every individual admission path
    // from the effective policy for these receivers. No silent fallback.
    const automaticOnly=new Set(p.automaticClients?.automaticOnlyDeviceIds??[]);
    const ambiguousTrialAddresses=new Set(p.capabilities.filter(c=>automaticOnly.has(c.deviceId)&&p.capabilities.filter(v=>normalizedIp(v.remoteIp)===normalizedIp(c.remoteIp)).length!==1).map(c=>normalizedIp(c.remoteIp)));
    policyStamp=stamp;policyValue=automaticOnly.size?{...p,capabilities:p.capabilities.filter(c=>!automaticOnly.has(c.deviceId)||ambiguousTrialAddresses.has(normalizedIp(c.remoteIp))),clientTrials:p.clientTrials?.filter(t=>!automaticOnly.has(t.deviceId)),policy:{...p.policy,observations:p.policy.observations.filter(o=>!automaticOnly.has(o.deviceId))}}:p;return policyValue;})();
    try{return await policyJob;}finally{policyJob=undefined;}
  }
  function clientPolicy(p:ExperimentalJitPolicy|undefined,remote:string){
    if(!p)return;
    const resolved=resolveJitClient(p,remote);
    const auto=automatic.resolve(p,remote);
    const admission=selectClientAdmission(p,remote,auto);
    const isOverride=admission.route==='explicit-override'||admission.route==='individual-first';
    const selection={mode:'active-candidate',remoteIp:remote,identity:resolved.capability?.deviceId??auto.endpoint?.capability.deviceId,family:auto.context?.family,confidence:auto.context?.confidence,
      evidenceId:auto.evidence?.id,evidence:auto.context?.evidence,automaticTarget:auto.profile?.id,actualTarget:admission.policy?.targetProfile,override:isOverride,route:admission.route,reason:admission.reason,
      agreement:isOverride&&auto.profile?resolved.profile!.id===auto.profile.id:undefined,receiverVerification:'Family candidate is inferred; no individual success added'};
    const signature=snapshotHash(JSON.stringify(selection));if(selectionLogs.get(remote)!==signature){selectionLogs.delete(remote);selectionLogs.set(remote,signature);if(selectionLogs.size>128)selectionLogs.delete(selectionLogs.keys().next().value!);trace('CLIENT_AUTO_SELECTION',selection);}
    if(!admission.policy)return;const {policy:chosen,...metadata}=admission;
    return {...chosen,_admission:metadata};
  }
  const compatibility=createReceiverCompatibility(path.join(directory,'jit.json'),()=>automatic.peers().flatMap(peer=>peer.endpoints.map(endpoint=>{
    const selected=clientPolicy(policyValue,peer.remoteIp),cap=selected?.capabilities.find(c=>c.remoteIp===peer.remoteIp),profile=selected?.policy.profiles.find(p=>p.id===selected.targetProfile);
    const eligible=peer.fresh&&!!selected?._admission?.binding&&cap?.deviceId===endpoint.capability.deviceId&&cap.controlUrl===endpoint.capability.controlUrl&&!!profile&&!isMpeg2JitTarget(profile);
    return {endpoint,eligible,reason:eligible?'current-bound-avc-client':peer.fresh?'要求元とAVC targetの対応が未確認':'個体情報の再確認が必要。端末でサーバー一覧を開いてください'};
  })),deps.capability);
  function resource(entry: ExperimentalEntry, remote: string, p: ExperimentalJitPolicy): JitResource | undefined {
    const resolved=clientPolicy(p,remote);if(!resolved)return; p=resolved;
    const item = entry.objectId.startsWith('experimental/catalog-item/')?undefined:p.items.find(i => i.objectId === entry.objectId);
    const cap = p.capabilities.find(c => normalizedIp(c.remoteIp) === normalizedIp(remote));
    const profile = p.policy.profiles.find(v => v.id === p.targetProfile);
    if(entry.sourceStale||!cap||snapshotHash(cap.sink)!==cap.sinkHash||!profile)return;
    if(scopedWmaInputPermission(p.wmaInputPermissions,cap,p.targetProfile,entry.fingerprint,entry.lightweightProbe)&&!p._admission?.binding)return;
    const trial=matchingJitTrial(p.clientTrials,cap,profile);
    const admitted=(!item||trial)?catalogJitCandidate(entry,p,cap):undefined;
    if(trial&&!admitted)return;
    if(item?(!matchingFingerprint(item.sourceFingerprint,entry.fingerprint)||!Number.isFinite(item.durationSeconds)||item.durationSeconds<=0):!admitted)return;
    const v = profile.video.value, t = profile.transport.value;
    if (!isMpeg2JitTarget(profile)&&(v.codec !== 'h264' || v.profile !== 'Main' || v.level !== 40 || v.codedWidth !== 1920 || v.codedHeight !== 1088 || v.bitDepth !== 8 || v.chroma !== '420' || v.scan !== 'progressive' ||
      v.maxDpbFrames < 1 || v.maxBitrate < 10e6 || v.maxCpbBits < 10e6 || t.framing !== 'jp-content-packet' || t.seek !== 'time' || t.profileName !== 'AVC_TS_JP_AAC_T')) return;
    if (!trial&&!parseSinkProtocolInfo(cap.sink).some(s=>s.protocol==='http-get'&&s.mime===profile.transport.value.mime&&s.profileName===profile.transport.value.profileName)) return;
    if (!trial&&!p.policy.observations.some(o => o.deviceId === cap.deviceId && o.sinkHash === cap.sinkHash && o.observation.profileId === p.targetProfile && o.observation.outcome === 'success' && o.observation.framing === 'jp-content-packet')) return;
    const correction=receiverVideoCfrTrial(p._admission?.binding?p.receiverCfrTrials:undefined,p._admission?.binding?p.receiverWmvCfrTrials:undefined,cap,entry.lightweightProbe,!isMpeg2JitTarget(profile),entry.fingerprint,p._admission?.binding?p.receiverH264AviCfrTrials:undefined);
    return { protocolInfo: isMpeg2JitTarget(profile)?MPEG2_JIT_PROTOCOL:JIT_PROTOCOL, durationSeconds: item?.durationSeconds??admitted!.duration, targetProfile: p.targetProfile,...(p._admission?.binding?{clientBinding:dualAudioBinding(receiverCfrBinding(wmaInputBinding(p._admission.binding,scopedWmaInputPermission(p.wmaInputPermissions,cap,p.targetProfile,entry.fingerprint,entry.lightweightProbe)),correction),selectDualAudio(p.dualAudioPermissions,cap,entry.lightweightProbe,p.targetProfile,isMpeg2JitTarget(profile),!!p._admission?.binding,entry.fingerprint,correction).plan)}:{}) };
  }
  return {
    receive,
    async observeClient(req:IncomingMessage,xml=''){
      const p=await policy();await automatic.observe(await this.client(req),req.headers,xml,p?.automaticClients?.enabled&&p.automaticClients.version===AUTOMATIC_CLIENT_VERSION);
    },
    automaticIdle:()=>automatic.idle(),
    async compatibilityStatus(){await policy();return compatibility.inspect();},
    async configureCompatibility(input:unknown){await policy();const result=await compatibility.configure(input);await policy();trace('CLIENT_COMPATIBILITY_SETTING',{input,result});return result;},
    automaticStatus:()=>({...automatic.status(),revision:(automatic.status().revision+policyRevision)>>>0}),
    async revision(){await policy();return (automatic.status().revision+policyRevision)>>>0;},
    closeAutomatic:()=>automatic.close(),
    async client(req: IncomingMessage) {
      const remote = normalizedIp(req.socket.remoteAddress || '');
      if (!['127.0.0.1', '::1'].includes(remote)) return remote;
      // Verification authenticates stored identity, not the diagnostic admission
      // view. Automatic-only masking must not change this PC-only request MAC.
      const p = await readShadowJson<ExperimentalJitPolicy>(path.join(directory,'jit.json')).catch(()=>undefined);
      // Explicit PC verification only. LAN clients cannot impersonate a DMP.
      if(p&&req.headers['x-pt3-jit-verify']===snapshotHash(JSON.stringify(p))){
        const candidates=p.capabilities.filter(c=>!req.headers['x-pt3-jit-device']||c.deviceId===req.headers['x-pt3-jit-device']);
        if(candidates.length===1)return candidates[0].remoteIp;
      }
      return remote;
    },
    async decorate(entry: ExperimentalEntry, remote: string): Promise<ExperimentalEntry> {
      const p = clientPolicy(await policy(),remote);
      const cap=p?.capabilities.find(c=>normalizedIp(c.remoteIp)===normalizedIp(remote));
      if(p?.catalogMetadataResources&&cap&&p.items.some(i=>i.objectId===entry.objectId)&&entry.lightweightProbe){
        const generic=catalogJitCandidate(entry,p,cap);
        trace('CATALOG_OVERLAY_SHADOW',{sourceId:entry.objectId,genericAccepted:!!generic,strategy:generic?.execution.strategy,targetProfile:p.targetProfile,transforms:generic?.execution.transforms,actualPath:'existing overlay remains unchanged'});
      }
      return { ...entry, jit: p ? resource(entry, remote, p) : undefined };
    },
    async genericView(){return !!(await policy())?.catalogGenericView;},
    async protocolInfos(remote: string, entries: ExperimentalEntry[]) {
      const p = clientPolicy(await policy(),remote),cap=p?.capabilities.find(c=>normalizedIp(c.remoteIp)===normalizedIp(remote));
      const target=p?.policy.profiles.find(v=>v.id===p.targetProfile);
      const trial=cap&&target?matchingJitTrial(p?.clientTrials,cap,target):undefined;
      const generic=p?.catalogMetadataResources&&cap&&snapshotHash(cap.sink)===cap.sinkHash&&(target?.transport.value.profileName==='AVC_TS_JP_AAC_T'||!!target&&isMpeg2JitTarget(target))&&target.transport.value.framing==='jp-content-packet'&&
        (trial||parseSinkProtocolInfo(cap.sink).some(s=>s.protocol==='http-get'&&s.profileName===target.transport.value.profileName&&s.mime===target.transport.value.mime)&&
        p.policy.observations.some(o=>o.deviceId===cap.deviceId&&o.sinkHash===cap.sinkHash&&o.observation.profileId===p.targetProfile&&o.observation.outcome==='success'&&o.observation.framing==='jp-content-packet'));
      return p && (generic||entries.some(e => resource(e, remote, p))) ? [target&&isMpeg2JitTarget(target)?MPEG2_JIT_PROTOCOL:JIT_PROTOCOL] : [];
    },
    status() { return [...sessions.entries()].map(([client, s]) => ({ client, ...s.runtime.status() })); },
    async deliver(req: IncomingMessage, res: ServerResponse, entry: ExperimentalEntry) {
      const {began,generation,requestId}=receive(req), remote = await this.client(req), sessionId = `${remote}/${entry.objectId}`;
      let lease:JitRequestLease|undefined;
      const stage = (name: string, detail: unknown = {}) => trace('EXPERIMENTAL_JIT_STAGE', { sourceId: entry.objectId,client:remote,requestId,generation, stage: name, secondsSinceGet: (performance.now() - began) / 1000, detail });
      stage('GET_RECEIVED', { method: req.method, headers: req.headers });
      try {
        await this.observeClient(req);
        const cached=await policy(),resolution=cached?resolveJitClient(cached,remote):undefined;
        if(!resolution?.profile||cached?.automaticClients?.priority==='automatic-first')await automatic.refresh(remote);
        stage('CLIENT_RESOLUTION',{remoteIp:remote,deviceId:resolution?.capability?.deviceId,sinkHash:resolution?.capability?.sinkHash,targetProfile:resolution?.profile?.id,reason:resolution?.reason??'JIT policy unavailable',unknowns:resolution?.unknowns});
        const p = clientPolicy(cached,remote); assert.ok(p && resource(entry, remote, p), 'No opted-in JIT target for this client/source');
        const auto=automatic.resolve(cached!,remote),advertised=resource(entry,remote,p)!;
        stage('CLIENT_FAMILY_SELECTION',{...auto,route:p._admission?.route,reason:p._admission?.reason,override:p._admission?.route==='explicit-override'||p._admission?.route==='individual-first',actualTarget:p.targetProfile,agreement:resolution?.profile&&auto.profile?resolution.profile.id===auto.profile.id:undefined,receiverVerification:'family candidate is not individual success'});
        const bindingParameter=new URL(req.url??'/', 'http://localhost').searchParams.get('clientBinding');
        const boundCap=p.capabilities.find(c=>normalizedIp(c.remoteIp)===remote);
        const boundProfile=p.policy.profiles.find(v=>v.id===p.targetProfile)!;
        const boundCorrection=receiverVideoCfrTrial(p._admission?.binding?p.receiverCfrTrials:undefined,p._admission?.binding?p.receiverWmvCfrTrials:undefined,boundCap,entry.lightweightProbe,!isMpeg2JitTarget(boundProfile),entry.fingerprint,p._admission?.binding?p.receiverH264AviCfrTrials:undefined);
        const expectedBinding=dualAudioBinding(receiverCfrBinding(wmaInputBinding(p._admission?.binding,scopedWmaInputPermission(p.wmaInputPermissions,boundCap,p.targetProfile,entry.fingerprint,entry.lightweightProbe)),boundCorrection),selectDualAudio(p.dualAudioPermissions,boundCap,entry.lightweightProbe,p.targetProfile,isMpeg2JitTarget(boundProfile),!!p._admission?.binding,entry.fingerprint,boundCorrection).plan);
        if(advertised.clientBinding||bindingParameter)assert.ok(p._admission?.binding&&bindingParameter===expectedBinding&&advertised.clientBinding===expectedBinding,'Missing, stale or different-client Browse binding');
        const current = await fs.stat(entry.fingerprint.path);
        assert.ok(current.isFile() && matchingFingerprint(entry.fingerprint, { path: entry.fingerprint.path, size: current.size, mtimeMs: current.mtimeMs }), 'Source fingerprint changed');
        if (req.headers.range) { res.writeHead(400); res.end('Byte Range unsupported; use TimeSeekRange'); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
        if(req.headers['timeseekrange.dlna.org']){try{parseTimeSeek(String(req.headers['timeseekrange.dlna.org']),resource(entry,remote,p)!.durationSeconds);}catch(e){const status=timeSeekErrorStatus(e);trace('EXPERIMENTAL_JIT_SEEK_REJECTED',{status,reason:String(e)});res.writeHead(status,{'Content-Length':0,'Cache-Control':'no-store'});res.end();return;}}
        if(req.method==='GET'){
          const limit=p.maxConcurrentSessions??2;
          assert.ok(limit===1||limit===2,'JIT maxConcurrentSessions must be 1 or 2');
          lease=requests.begin(remote,generation,requestId,res,limit);if(!lease)return;
          await lease.ready();
        }
        const check=()=>lease?.check();
        const inspected = await deps.inspect(directory, entry.fingerprint,lease?.signal);check();
        stage('SOURCE_METADATA', { cacheHit: inspected.cacheHit }); stage('CACHE_LOOKUP', { metadata: inspected.cacheHit, cadence: 'incremental at start; fingerprint/policy checkpoint cache on seek' });
        assert.ok(Math.abs(Number(inspected.probe.format.duration) - resource(entry,remote,p)!.durationSeconds) < .001, 'Duration differs from catalog metadata');
        const devices = await deps.devices();check();
        const registered = devices.filter(d => normalizedIp(d.remoteIp) === remote);
        if(!registered.length&&advertised.clientBinding&&auto.endpoint)registered.push(auto.endpoint.device);
        assert.equal(registered.length,1,'Ambiguous or unregistered DMP');
        const device=registered[0],selected=resolveJitClient(p,remote);assert.ok(selected.capability&&selected.profile,'No unique client target');
        assert.ok(!device.deviceId||device.deviceId===selected.capability.deviceId,'Registered UDN differs from Browse identity');
        const cap = await deps.capability(device, lease?AbortSignal.any([lease.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000));check();
        assert.ok(cap.deviceId===selected.capability.deviceId&&cap.sinkHash===selected.capability.sinkHash&&cap.sinkHash===snapshotHash(cap.sink)&&normalizedIp(cap.remoteIp)===remote&&new URL(cap.controlUrl).href===new URL(selected.capability.controlUrl).href, 'Current capability differs from advertised client binding');
        const advertisedTrial=matchingJitTrial(p.clientTrials,selected.capability,selected.profile);
        assert.ok(!advertisedTrial||matchingJitTrial(p.clientTrials,cap,selected.profile),'Current implementation differs from fingerprint-bound trial');
        stage('CLIENT_TARGET_CONFIRMED',{deviceId:cap.deviceId,remoteIp:remote,sinkHash:cap.sinkHash,acquiredAt:cap.acquiredAt,targetProfile:selected.profile.id,reason:selected.reason,unknowns:selected.unknowns});
        if(matchingJitTrial(p.clientTrials,cap,p.policy.profiles.find(v=>v.id===p.targetProfile)!)||entry.objectId.startsWith('experimental/catalog-item/')||!p.items.some(i=>i.objectId===entry.objectId)){
          const actual=catalogJitCandidate({...entry,lightweightProbe:inspected.probe},p,cap);
          assert.ok(actual&&JSON.stringify(actual.execution.transport)===JSON.stringify(p.policy.profiles.find(v=>v.id===p.targetProfile)!.transport.value), 'Advertised target cannot execute');
          stage('CATALOG_DECISION_CONFIRMED',{strategy:actual.execution.strategy,transforms:actual.execution.transforms,targetProfile:p.targetProfile,verification:actual.verification});
        }
        const receiverCfr=receiverVideoCfrTrial(p._admission?.binding?p.receiverCfrTrials:undefined,p._admission?.binding?p.receiverWmvCfrTrials:undefined,cap,inspected.probe,!isMpeg2JitTarget(selected.profile),entry.fingerprint,p._admission?.binding?p.receiverH264AviCfrTrials:undefined);
        const dual=selectDualAudio(p.dualAudioPermissions,cap,inspected.probe,p.targetProfile,isMpeg2JitTarget(selected.profile),!!p._admission?.binding,entry.fingerprint,receiverCfr);
        assert.equal(dualAudioBinding(receiverCfrBinding(wmaInputBinding(p._admission?.binding,scopedWmaInputPermission(p.wmaInputPermissions,cap,p.targetProfile,entry.fingerprint,inspected.probe)),receiverCfr),dual.plan),advertised.clientBinding,'Receiver audio/CFR admission changed between Browse and GET');
        stage('WMA_INPUT_SELECTION',{scoped:!!scopedWmaInputPermission(p.wmaInputPermissions,cap,p.targetProfile,entry.fingerprint,inspected.probe),automaticInputPolicy:p.automaticClients?.wmaInputs,clock:'unchanged existing conversion; input permission does not enable common PCM/index clock'});
        stage('DUAL_AUDIO_SELECTION',{plan:dual.plan,reason:dual.reason,deviceId:cap.deviceId,target:p.targetProfile,otherReceiversUnchanged:true});
        stage('RECEIVER_CFR_TRIAL',{receiverCfr,deviceId:cap.deviceId,h264AviReason:evaluateH264AviCfrTrial(p._admission?.binding?p.receiverH264AviCfrTrials:undefined,cap,inspected.probe,!isMpeg2JitTarget(selected.profile),entry.fingerprint).reason,wmvReason:evaluateReceiverWmvCfrTrial(p._admission?.binding?p.receiverWmvCfrTrials:undefined,cap,inspected.probe,!isMpeg2JitTarget(selected.profile),entry.fingerprint).reason,scope:'explicit individual trial; original source selection, audio and target recipe retained'});
        stage('CURRENT_CAPABILITY', { deviceId: cap.deviceId, sinkHash: cap.sinkHash });
        if (res.destroyed) return;
        const timing=p.policy.profiles.find(v=>v.id===p.targetProfile)!.video.value.timing;
        if(req.method==='GET')assert.ok(!timingPreparing.has(remote),'Previous timing preparation not cleaned up');
        if(req.method==='GET')timingPreparing.add(remote);
        const controller=new AbortController(),cancelAnalysis=()=>controller.abort();res.once('close',cancelAnalysis);
        const mpeg2=isMpeg2JitTarget(p.policy.profiles.find(v=>v.id===p.targetProfile)!);const timingMode=mpeg2?'original':p.timingPolicy??'auto';
        const chosen=await deps.timing(directory,entry.fingerprint,timing,inspected.probe,timingMode,{cacheOnly:req.method==='HEAD',signal:controller.signal}).finally(()=>{res.off('close',cancelAnalysis);if(req.method==='GET')timingPreparing.delete(remote);});
        check();
        stage('TIMING_POLICY',{...chosen,requestMethod:req.method,selectionFinal:req.method==='GET',requestedMode:timingMode,selectedPolicy:mpeg2?'mpeg2-receiver-cfr-v1':chosen.clock?'quantized-evidence-v1':'original',sourceFingerprint:entry.fingerprint,unknowns:mpeg2?'Separate provisional MPEG-2 CFR target; receiver live JIT/seek unconfirmed':'Inferred reconstruction; unchanged target level and audio clock'});
        if(res.destroyed)return;
        if (req.method === 'HEAD') {
          const duration = Number(inspected.probe.format.duration), h = req.headers['timeseekrange.dlna.org'];
          const range = h ? parseTimeSeek(String(h), duration) : { start: 0, end: duration };
          let actual = 0;
          if (range.start > 0) {
            const timing = p.policy.profiles.find(v => v.id === p.targetProfile)!.video.value.timing;
            const minimum = minimumRemovalTicks(timing.constraint).minimumTicks;
            const seek = mpeg2 ? mpeg2Seek(range.start) : await resolveJitSeek(entry.fingerprint.path, await seekCheckpoints(entry.fingerprint.path, minimum, snapshotHash(JSON.stringify(chosen.clock?{timing,clock:chosen.clock}:timing)),undefined,undefined,chosen.clock), range.start);
            actual = Math.min(seek.firstVideoTicks, seek.audioTrimTicks - 1920) / 90000;
          }
          res.writeHead(200, { 'Content-Type': 'video/vnd.dlna.mpeg-tts', 'Accept-Ranges': 'none', 'contentFeatures.dlna.org': mpeg2?MPEG2_JIT_FEATURES:JIT_FEATURES, 'transferMode.dlna.org': 'Streaming', 'TimeSeekRange.dlna.org': `npt=${Math.max(0, actual).toFixed(6)}-${(range.end ?? duration).toFixed(6)}/${duration.toFixed(6)}` }); res.end(); return;
        }
        assert.ok(!preparing.has(remote),'Previous runtime preparation not cleaned up');
        preparing.add(remote);
        let runtime: Runtime;
        try {
          const key = snapshotHash(JSON.stringify({ fingerprint: entry.fingerprint, policy: p.policy, target: p.targetProfile, deviceId:cap.deviceId,controlUrl:cap.controlUrl, receiverCfr, dualAudio:dual.plan, clientTrial:matchingJitTrial(p.clientTrials,cap,p.policy.profiles.find(v=>v.id===p.targetProfile)!), sinkHash: cap.sinkHash,...(timingMode!=='original'?{timingChoice:{key:chosen.key,clock:chosen.clock}}:{}) }));
          for (const [id, old] of sessions) {
            if (id.startsWith(remote + '/') && (id !== sessionId || old.key !== key)) { await old.runtime.stop(); sessions.delete(id); }
            else if (!requests.has(id.slice(0,id.indexOf('/'))) && !old.runtime.status().active && id !== sessionId) sessions.delete(id);
          }
          const existing = sessions.get(sessionId);
          if (existing) runtime = existing.runtime;
          else {
            runtime = await deps.createRuntime({ source: entry.fingerprint.path, reference: '', address: '127.0.0.1', port: 19090, seconds: 150, durationMode:'source', startupSeconds: 2.2, timeSeek: true, logDirectory: path.join(directory, 'jit-logs',snapshotHash(sessionId)), audioCacheDirectory:path.join(directory,'jit-logs','audio-end-cache'),...(dual.plan?{dualAudio:dual.plan}:{}),...(receiverCfr?{receiverCfr}:{}),...(chosen.clock?{experimentalClock:chosen.clock,encoderNominalRate:chosen.encoderNominalRate}:{}) }, {
              ...(dual.permission&&dual.plan?{dualAudioPermission:dual.permission}:{}),
              clientTrial:matchingJitTrial(p.clientTrials,cap,p.policy.profiles.find(v=>v.id===p.targetProfile)!),
              ...(advertised.clientBinding?{device,acquireCapability:async(d:RegisteredDmp,signal:AbortSignal)=>{
                const current=await deps.capability(d,signal);
                assert.ok(current.deviceId===cap.deviceId&&current.sinkHash===cap.sinkHash&&current.controlUrl===cap.controlUrl&&current.implementation?.fingerprint===cap.implementation?.fingerprint,'Automatic runtime binding changed');
                assert.equal(clientPolicy(cached!,remote)?._admission?.binding,p._admission?.binding,'Client admission evidence expired or changed');return current;
              }}:{}),
              reference: { sourceFingerprint: entry.fingerprint, policy: p.policy, targetProfile: p.targetProfile, capabilitySnapshot: cap }, probe: inspected.probe,
              receiverCfrAuthorization:receiverCfr?p.receiverCfrTrials?.find(t=>t.deviceId===cap.deviceId):undefined,
              receiverH264AviCfrAuthorization:receiverCfr?matchingH264AviCfrTrial(p.receiverH264AviCfrTrials,cap,inspected.probe,!isMpeg2JitTarget(selected.profile),entry.fingerprint):undefined,
              receiverWmvCfrAuthorization:receiverCfr?matchingReceiverWmvCfrTrial(p.receiverWmvCfrTrials,cap,inspected.probe,!isMpeg2JitTarget(selected.profile),entry.fingerprint):undefined,
              timingAuthorization:chosen.clock?chosen:undefined,
              trace: (category, detail) => {trace(category, { sourceId: entry.objectId, client: remote, detail });if(category==='TIMING_MODEL_ERROR'&&chosen.clock)void rejectJitTiming(directory,chosen,JSON.stringify(detail)).catch(e=>trace('TIMING_CACHE_ERROR',{error:String(e)}));}
            });
            sessions.set(sessionId, { key, runtime });
          }
        } finally { preparing.delete(remote); }
        if (res.destroyed) return;
        check();
        const original = req.url; req.url = '/jit/media.tts';
        try { await runtime.handle(req, res, began,requestId); } finally { req.url = original; }
      } catch (e) {
        trace(res.destroyed ? 'EXPERIMENTAL_JIT_CANCELLED' : 'EXPERIMENTAL_JIT_ERROR', { sourceId: entry.objectId, error: String(e),...(e instanceof JitSeekUnavailableError?{seekRejection:{code:e.code,requested:e.requested,lastPicture:e.lastPicture}}:{}) });
        if (!res.headersSent && !res.destroyed) { res.writeHead(jitSeekFailureStatus(e,typeof req.headers['timeseekrange.dlna.org']==='string'), { 'Content-Length': 0 }); res.end(); } else res.destroy();
      } finally {lease?.finish();}
    }
  };
}
