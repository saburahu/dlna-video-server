import {parseVirtual,VirtualChildren} from './virtual-folders.js';
import {createDirectMedia} from './direct-media.js';
import {createImageDelivery,photoItem,PHOTO_ROOT} from './image-delivery.js';
import {librarySwitch,libraryPagePlan,combineLibraryPage,LIBRARY_VIEWS} from './recording-library.js';
import {developmentDirectory} from './public-directory.js';
import {createExperimentalJit,type JitResource} from './experimental-jit.js';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import{sourceContained}from'./source-containment.js';
import { escapeXml } from './core.js';
import { CD_SERVICE } from './upnp.js';
import { snapshotHash, matchingFingerprint, type Fingerprint, type ShadowRecord } from './playback-shadow.js';
import type { Transport } from './playback-decision.js';
import { readShadowJson } from './playback-shadow-store.js';
import { promises as fs } from 'node:fs';
import { cadencePlanFingerprint, decisionFingerprint, matchesArtifactDecision, validateArtifact, createArtifactRuntime, type VerifiedArtifactAdapter } from './verified-artifact.js';
import {openMediaIndex,INDEX_FILE,indexedExperimentalEntry,type MediaIndex} from './media-catalog-index.js';
import {createCatalogBackground} from './catalog-background.js';
import {FOLDER_ROOT,type FolderRow} from './folder-index.js';

export const EXPERIMENTAL_ROOT = 'experimental';
export const CATALOG_VERSION = 'experimental-catalog-v1';
export const experimentalCatalogDirectory = () => path.resolve(process.env.PT3_EXPERIMENTAL_CATALOG_DIR || path.join(process.env.PT3_DATA_DIR || 'data', 'experimental-catalog'));
export const experimentalObjectId = (file: string) => `experimental/item/${snapshotHash(process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)).slice(0, 32)}`;
export interface CachedExperimentalDecision {
  remoteIp: string; deviceId: string; sinkHash: string; acquiredAt: string; decisionId: string;
  sourceFingerprint: Fingerprint; sourceCharacteristics: unknown;
  decisionStatus: ShadowRecord['decisionStatus']; disposition: ShadowRecord['disposition'];
  selected?: { strategy: string; targetProfileId: string; transport: Transport; transforms: unknown; cadenceRequired?: boolean; cadenceFingerprint?: string; verification: string };
  candidateStrategies: string[]; unknowns: string[];
  decisionFingerprint?: string;
  artifactCandidate?: CachedExperimentalDecision['selected'];
}
export interface ExperimentalEntry {
  objectId: string; filename: string; fingerprint: Fingerprint; sourceState: 'cached' | 'unanalysed';
  decisions: CachedExperimentalDecision[]; adapter?: VerifiedArtifactAdapter; jit?:JitResource; sourceStale?:boolean;
  lightweightProbe?:any;
}
export interface ExperimentalCatalog { version: string; enabled: boolean; generatedAt: string; entries: ExperimentalEntry[]; indexedTotal?:number }
export interface BrowsePage { didl: string; numberReturned: number; total: number; updateId?:number }
export interface BrowseInput { objectId: string; start: number; count: number; metadata: boolean }
const wrap = (entries: string[]) => `<?xml version="1.0"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${entries.join('')}</DIDL-Lite>`;
const container = (children: number) => `<container id="${EXPERIMENTAL_ROOT}" parentID="0" restricted="1" childCount="${children}"><dc:title>Experimental Media</dc:title><upnp:class>object.container</upnp:class></container>`;
const ip = (value: string) => value.replace(/^::ffff:/, '');
const folderContainer=(r:FolderRow)=>`<container id="${r.id}" parentID="${r.parent}" restricted="1" childCount="${r.children??0}"><dc:title>${escapeXml(r.name)}</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`;
export function folderAlias(xml:string,row:FolderRow){return xml.replace(/<item id="[^"]+" parentID="[^"]+"/,`<item id="${row.id}" parentID="${row.parent}"`);}
export function selectedCachedDecision(entry: ExperimentalEntry, remoteIp: string, now = Date.now()) {
  const candidates = entry.decisions.filter(d => ip(d.remoteIp) === ip(remoteIp) && matchingFingerprint(d.sourceFingerprint, entry.fingerprint) &&
    Number.isFinite(Date.parse(d.acquiredAt)) && now - Date.parse(d.acquiredAt) >= 0 && now - Date.parse(d.acquiredAt) < 300000);
  return candidates.length === 1 ? candidates[0] : undefined;
}
export function resolveExperimentalAdapter(entry: ExperimentalEntry, decision: CachedExperimentalDecision | undefined) {
  const adapter = entry.adapter;
  if (adapter?.kind === 'verified-artifact') return matchesArtifactDecision(entry, decision, adapter) ? adapter : undefined;
  return undefined;
}
function item(entry: ExperimentalEntry, remoteIp: string, baseUrl: string, now: number) {
  const decision = selectedCachedDecision(entry, remoteIp, now), adapter = resolveExperimentalAdapter(entry, decision);
  const seconds = entry.jit?.durationSeconds ?? adapter?.durationSeconds ?? 0;
  const duration = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}`;
  const state = entry.sourceState === 'unanalysed' ? 'unanalysed' : decision ? decision.disposition : 'decision incomplete';
  const generic=entry.objectId.startsWith('experimental/catalog-item/');
  return `<item id="${entry.objectId}" parentID="${generic?'experimental/catalog':'experimental'}" restricted="1"><dc:title>${escapeXml(entry.filename)}</dc:title><upnp:class>object.item.videoItem</upnp:class><dc:description>${escapeXml(`Experimental only; ${state}; source filename retained. ${entry.jit ? 'Opt-in JIT on GET; no encode during Browse.' : 'No automatic executor.'}`)}</dc:description>${entry.jit ? `<res protocolInfo="${escapeXml(entry.jit.protocolInfo)}" duration="${duration}">${escapeXml(`${baseUrl}/experimental/${generic?'catalog-jit':'jit'}/${entry.objectId.split('/').at(-1)}${entry.jit.clientBinding?'?clientBinding='+entry.jit.clientBinding:''}`)}</res>` : adapter ? `<res protocolInfo="${escapeXml(adapter.protocolInfo)}" size="${adapter.size}" duration="${duration}">${escapeXml(`${baseUrl}/experimental/media/${entry.objectId.split('/').at(-1)}`)}</res>` : ''}</item>`;
}
export function libraryItem(entry:ExperimentalEntry,baseUrl:string){
 const token=entry.objectId.split('/').at(-1),seconds=entry.jit?.durationSeconds??0;
 const duration=`${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${(seconds%60).toFixed(3).padStart(6,'0')}`;
 return `<item id="library/item/${token}" parentID="all" restricted="1"><dc:title>${escapeXml(entry.filename)}</dc:title><upnp:class>object.item.videoItem</upnp:class><dc:date>${new Date(entry.fingerprint.mtimeMs).toISOString()}</dc:date>${entry.jit?`<res protocolInfo="${escapeXml(entry.jit.protocolInfo)}" duration="${duration}">${escapeXml(`${baseUrl}/library/jit/${token}${entry.jit.clientBinding?'?clientBinding='+entry.jit.clientBinding:''}`)}</res>`:''}</item>`;
}
/** Root append only: existing rec entry, sibling order and every rec subtree remain untouched. */
export function browseExperimental(catalog: ExperimentalCatalog | undefined, request: BrowseInput, remoteIp: string, baseUrl: string,
  legacyRoot: (metadata: boolean) => BrowsePage, now = Date.now()): BrowsePage | undefined {
  if (!catalog?.enabled || catalog.version !== CATALOG_VERSION) return undefined;
  const { objectId, start, count, metadata } = request;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0) throw new Error('Invalid experimental page');
  if (objectId === '0') {
    const old = legacyRoot(metadata);
    if (metadata) return { ...old, didl: old.didl.replace('childCount="1"', 'childCount="2"') };
    const contents = /<DIDL-Lite\b[^>]*>([\s\S]*)<\/DIDL-Lite>/.exec(old.didl)?.[1];
    if (contents === undefined) return undefined;
    const entries = [contents, container(catalog.indexedTotal??catalog.entries.length)], selected = entries.slice(start, count ? start + count : undefined);
    return { didl: wrap(selected), numberReturned: selected.length, total: 2 };
  }
  if (objectId !== EXPERIMENTAL_ROOT && !objectId.startsWith('experimental/')) return undefined;
  let entries: string[] = [];
  if (objectId === EXPERIMENTAL_ROOT) entries = metadata ? [container(catalog.indexedTotal??catalog.entries.length)] : catalog.entries.map(e => item(e, remoteIp, baseUrl, now));
  else if (metadata) { const entry = catalog.entries.find(e => e.objectId === objectId); if (entry) entries = [item(entry, remoteIp, baseUrl, now)]; }
  const selected = metadata ? entries : entries.slice(start, count ? start + count : undefined);
  return { didl: wrap(selected), numberReturned: selected.length, total: entries.length };
}
export function experimentalBrowseSoap(page: BrowsePage, updateId: number) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:BrowseResponse xmlns:u="${CD_SERVICE}"><Result>${escapeXml(page.didl)}</Result><NumberReturned>${page.numberReturned}</NumberReturned><TotalMatches>${page.total}</TotalMatches><UpdateID>${page.updateId??updateId}</UpdateID></u:BrowseResponse></s:Body></s:Envelope>`;
}
export function cachedExperimentalDecision(record: ShadowRecord): CachedExperimentalDecision | undefined {
  if (!record.capabilitySnapshot) return undefined;
  const d = record.shadowDecision?.selected;
  const candidate = !d && record.shadowDecision?.candidates.length === 1 ? record.shadowDecision.candidates[0] : undefined;
  return { remoteIp: record.capabilitySnapshot.remoteIp, deviceId: record.capabilitySnapshot.deviceId, sinkHash: record.capabilitySnapshot.sinkHash,
    acquiredAt: record.capabilitySnapshot.acquiredAt, decisionId: record.decisionId, sourceFingerprint: record.request.fingerprint,
    sourceCharacteristics: record.sourceSnapshot && { ...record.sourceSnapshot.characteristics, video: { ...record.sourceSnapshot.characteristics.video, displayTicks: undefined, removalTicks: undefined } }, decisionStatus: record.decisionStatus, disposition: record.disposition,
    ...(d ? { selected: { strategy: d.strategy, targetProfileId: d.target.id, transport: d.target.transport.value, transforms: d.transforms, cadenceRequired: d.cadence?.required, ...(d.cadence?.required ? { cadenceFingerprint: cadencePlanFingerprint(d.cadence) } : {}), verification: d.verification } } : {}),
    ...(candidate ? { artifactCandidate: { strategy: candidate.strategy, targetProfileId: candidate.target.id, transport: candidate.target.transport.value, transforms: candidate.transforms, cadenceRequired: candidate.cadence?.required, ...(candidate.cadence?.required ? { cadenceFingerprint: cadencePlanFingerprint(candidate.cadence) } : {}), verification: candidate.verification } } : {}),
    candidateStrategies: [...new Set(record.shadowDecision?.candidates.map(c => c.strategy))], unknowns: record.unknowns, decisionFingerprint: decisionFingerprint(record) };
}
/** No scans/network/probes. Only a small allowlisted manifest refreshed by explicit CLI. */
export function createExperimentalCatalog(directory: string, trace: (message: string, detail: unknown) => void, folders: () => string[] = () => [], jitDependencies:Parameters<typeof createExperimentalJit>[2]={},recordings?:NonNullable<Parameters<typeof createCatalogBackground>[3]>['recordings'],scanDependencies:Pick<NonNullable<Parameters<typeof createCatalogBackground>[3]>,'busy'|'recordingState'>={}) {
  const images=createImageDelivery(directory,trace);
  const direct=createDirectMedia(folders,trace);
  const integrationEnabled=librarySwitch(directory);
  const jit = createExperimentalJit(directory, (category, detail) => trace(category, detail),jitDependencies);
  const renderLibrary=async(e:ExperimentalEntry,base:string,remote:string)=>direct.item(e,base,remote)??libraryItem(await jit.decorate(e,remote),base);
  const background=createCatalogBackground(directory,folders,trace,{...scanDependencies,busy:()=>jit.status().some(s=>s.active)||scanDependencies.busy?.()===true,probe:jitDependencies.inspect,recordings});
  const artifacts = createArtifactRuntime(directory, folders, (category, message, detail) => trace(`${category}: ${message}`, detail));
  let cached: ExperimentalCatalog | undefined, stamp = -1;
  let database:Promise<MediaIndex>|undefined;
  async function index(){
    if(!database){if(!await fs.stat(path.join(directory,INDEX_FILE)).catch(()=>undefined))return;database=openMediaIndex(directory).catch(error=>{database=undefined;throw error;});}
    return database;
  }
  async function load() {
    try {
      const file = path.join(directory, 'catalog.json'), st = await fs.stat(file);
      if (st.mtimeMs !== stamp) { const next = await readShadowJson<ExperimentalCatalog>(file);
        if (next?.version !== CATALOG_VERSION || !Array.isArray(next.entries) || next.entries.some(e => !/^experimental\/item\/[a-f0-9]{32}$/.test(e.objectId) || !/\.(mp4|mkv)$/i.test(e.filename))) throw new Error('Invalid experimental manifest');
        cached = next; stamp = st.mtimeMs;
      }
      return cached;
    } catch { cached = undefined; stamp = -1; return undefined; }
  }
  async function lookup(objectId:string){
    if(objectId.startsWith('experimental/catalog-item/')){
      const db=await index(),r=db?.enabled?db.get(objectId.replace('/catalog-item/','/item/')):undefined;
      return r?.availability==='available'?{...indexedExperimentalEntry(r),objectId}:undefined;
    }
    const legacy=(await load())?.entries.find(e=>e.objectId===objectId),db=await index();
    if(!db?.enabled)return legacy;
    const r=db.get(objectId);if(!r||r.availability!=='available')return;
    const e=indexedExperimentalEntry(r);
    return legacy?{...legacy,...e,decisions:legacy.decisions,adapter:legacy.adapter}:e;
  }
  const currentEntries = async (catalog: ExperimentalCatalog, request: BrowseInput, remote:string) => {
    // Verify only this page's source stat. Never open/parse source media during Browse.
    const entries = request.objectId === 'experimental' && !request.metadata ? catalog.entries.slice(request.start, request.count ? request.start + request.count : undefined)
      : catalog.entries.filter(e => e.objectId === request.objectId);
    const stale = new Set<string>();
    for (const entry of entries) { try { const s = await fs.stat(entry.fingerprint.path); if (s.size !== entry.fingerprint.size || s.mtimeMs !== entry.fingerprint.mtimeMs) stale.add(entry.objectId);
      if (entry.adapter?.kind === 'verified-artifact' && !(await jit.decorate(entry,remote)).jit && !await validateArtifact(entry.adapter)) stale.add(entry.objectId);
    } catch { stale.add(entry.objectId); } }
    return { ...catalog, entries: catalog.entries.map(e => stale.has(e.objectId) ? { ...e, sourceStale:true, sourceState: 'unanalysed' as const, decisions: [], adapter: undefined } : e) };
  };
  return {
    libraryEnabled:integrationEnabled,
    async folderBrowse(request:BrowseInput,remote:string,baseUrl:string,renderTs:(file:string)=>Promise<string|undefined>){
      const folderBase=parseVirtual(request.objectId)?.base??request.objectId;
      if(folderBase!==FOLDER_ROOT&&!/^library\/folder(?:-item)?\/[a-f0-9]{32}$/.test(folderBase))return;
      try{
        const db=await index();if(!db?.enabled)return {didl:wrap([]),numberReturned:0,total:0};
        const root:FolderRow={id:FOLDER_ROOT,parent:'rec',root_id:'',name:'フォルダ別',sort_key:'',kind:'folder',children:db.folders.count(FOLDER_ROOT)};
        const object=db.folders.browseGet(request.objectId);
        const page=request.metadata?{rows:object?[object]:[],total:object?1:0}:object?.kind==='folder'?db.folders.browsePage(object.id,request.start,request.count):{rows:[],total:0};
        const items=await Promise.all(page.rows.map(async r=>{
          if(r.kind==='folder')return folderContainer(r);
          if(r.source_id!.startsWith('item:'))return folderAlias(await renderTs(r.source_path!)??`<item id="unavailable" parentID="all" restricted="1"><dc:title>${escapeXml(r.name)}</dc:title><upnp:class>object.item.videoItem</upnp:class></item>`,r);
          const row=db.get(r.source_id!);if(!row||row.availability!=='available')return '';
          const entry={...indexedExperimentalEntry(row),objectId:row.objectId.replace('/item/','/catalog-item/')};
          const checked=await currentEntries({version:CATALOG_VERSION,enabled:true,generatedAt:'index',entries:[entry]},{objectId:entry.objectId,start:0,count:1,metadata:true},remote);
          return folderAlias(await integrationEnabled()?await renderLibrary(checked.entries[0],baseUrl,remote):libraryItem({...checked.entries[0],jit:undefined},baseUrl),r);
        }));
        const present=items.filter(Boolean);return {didl:wrap(present),numberReturned:present.length,total:page.total,updateId:(db.updateId+await integrationEnabled.revision()+await jit.revision()+1)>>>0};
      }catch(error){trace('FOLDER_BROWSE_ERROR',{error:String(error)});return {didl:wrap([]),numberReturned:0,total:0};}
    },
    async libraryBrowse(request:BrowseInput,remote:string,baseUrl:string,legacy:(start:number,count:number,metadata:boolean,objectId?:string)=>BrowsePage&{position?:number}){
      if(!await integrationEnabled())return;
      const base=parseVirtual(request.objectId)?.base??request.objectId;
      if(!LIBRARY_VIEWS.has(base)&&base!=='rec'&&!base.startsWith('library/item/')&&!base.startsWith('item:'))return;
      try{
        const db=await index();if(!db?.enabled)return;const revision=(await integrationEnabled.revision()+await jit.revision()+1)>>>0,tsTotal=legacy(0,1,false,'all').total,projection=new VirtualChildren('all',0,tsTotal+db.count()),updateId=(db.updateId+revision)>>>0;
        const parentXml=(xml:string,parent:string)=>xml.replace(/parentID="[^"]*"/,'parentID="'+parent+'"');
        if(base.startsWith('item:')){if(!request.metadata)return;const raw=legacy(0,1,true,base),parent=projection.parent('media',raw.position??-1);return {...raw,didl:parent?parentXml(raw.didl,parent):raw.didl,updateId};}
        if(base.startsWith('library/item/')){
          const e=request.metadata?await lookup(base.replace('library/item/','experimental/catalog-item/')):undefined,checked=e?await currentEntries({version:CATALOG_VERSION,enabled:true,generatedAt:'index',entries:[e]},{objectId:e.objectId,start:0,count:1,metadata:true},remote):undefined,entry=checked?.entries[0],position=db.position(base.replace('library/item/','experimental/item/'));
          const xml=entry?await renderLibrary(entry,baseUrl,remote):'';return {didl:wrap(xml?[parentXml(xml,projection.parent('media',tsTotal+(position??-tsTotal-1))??'all')]:[]),numberReturned:entry?1:0,total:entry?1:0,updateId};
        }
        if(base==='rec'){
          const old=legacy(request.start,request.count,request.metadata,'rec');return {...old,didl:old.didl.replace(/<container\b[^>]*>/g,tag=>tag.includes('id="all"')?tag.replace(/childCount="\d+"/,'childCount="'+projection.page('all',0,1).total+'"'):tag.includes('id="folders"')?tag.replace(/childCount="\d+"/,'childCount="'+db.folders.projection(FOLDER_ROOT).page(FOLDER_ROOT,0,1).total+'"'):tag),updateId};
        }
        if(request.metadata){const n=projection.node(request.objectId),r=request.objectId==='all'?{id:'all',parent:'rec',name:'すべて',children:projection.page('all',0,1).total}:n?{id:n.id,parent:n.parent,name:n.title,children:n.children}:undefined;return {didl:wrap(r?[folderContainer({...r,kind:'folder',root_id:'',sort_key:''})]:[]),numberReturned:r?1:0,total:r?1:0,updateId};}
        const logical=projection.page(request.objectId,request.start,request.count);
        if(logical.children.every(c=>c.kind==='virtual'))return {didl:wrap(logical.children.map(c=>folderContainer({id:c.id,parent:c.parent,name:c.title,children:c.children,kind:'folder',root_id:'',sort_key:''}))),numberReturned:logical.children.length,total:logical.total,updateId};
        const first=logical.children.find(c=>c.kind==='entry'),start=first?.kind==='entry'?first.index:0,plan=libraryPagePlan(start,logical.children.length,tsTotal);
        if(!logical.children.length)return {didl:wrap([]),numberReturned:0,total:logical.total,updateId};
        const ts=plan.tsCount?legacy(plan.tsStart,plan.tsCount,false,'all'):{didl:wrap([]),numberReturned:0,total:tsTotal},page=plan.catalogCount?db.page(plan.catalogStart,plan.catalogCount):{entries:[],total:db.count(),updateId:db.updateId};
        const entries=page.entries.map(r=>({...indexedExperimentalEntry(r),objectId:r.objectId.replace('/item/','/catalog-item/')})),checked=await currentEntries({version:CATALOG_VERSION,enabled:true,generatedAt:'index',entries},{objectId:'experimental',start:0,count:0,metadata:false},remote),items=await Promise.all(checked.entries.map(async e=>renderLibrary(e,baseUrl,remote)));
        const result=combineLibraryPage(ts,items,logical.total,updateId);return {...result,didl:result.didl.replace(/parentID="all"/g,'parentID="'+request.objectId+'"')};
      }catch(error){trace('LIBRARY_BROWSE_ERROR',{error:String(error)});return {didl:wrap([]),numberReturned:0,total:0};}
    },
    async libraryMedia(req:IncomingMessage,res:ServerResponse,token:string){jit.receive(req);if(!await integrationEnabled()){res.writeHead(404);res.end();return;}return this.jitMedia(req,res,token,true);},
    startBackground:()=>background.start(),stopBackground:async()=>{await background.stop();await jit.closeAutomatic();},backgroundStatus:()=>background.status(),rescan:()=>background.scanNow(),configureScanInterval:(seconds:number)=>background.configureInterval(seconds),
    async updateId(){try{const db=await index();return ((db?.enabled?db.updateId:0)+await integrationEnabled.revision()+await jit.revision()+1)>>>0;}catch{return 0;}},
    async closeIndex(){if(database){const db=await database;db.close();database=undefined;}},
    observe(record: ShadowRecord) {
      const entry = cached?.entries.find(e => matchingFingerprint(e.fingerprint, record.request.fingerprint));
      const decision = cachedExperimentalDecision(record);
      if (entry && decision) entry.decisions = [...entry.decisions.filter(d => d.remoteIp !== decision.remoteIp), decision];
    },
    isJit:async(objectId:string,remote:string)=>{const e=await lookup(objectId);return !!e&&(await jit.decorate(e,remote)).jit!==undefined;},
    client:async(req:IncomingMessage)=>direct.client(req,await jit.client(req)),
    async directMedia(req:IncomingMessage,res:ServerResponse,token:string){if(!await integrationEnabled()){res.writeHead(404);res.end();return;}return direct.deliver(req,res,await lookup(`experimental/catalog-item/${token}`));},
    observeClient:(req:IncomingMessage,xml='')=>jit.observeClient(req,xml),
    automaticIdle:()=>jit.automaticIdle(),
    automaticStatus:()=>jit.automaticStatus(),
    colorTrialPeers:()=>jit.colorTrialPeers(),
    verifyColorTrialPeer:(id:string,remote?:string)=>jit.verifyColorTrialPeer(id,remote),
    async colorTrialSources(query:string){const db=await index();if(!db)return [];const result:{id:string;title:string}[]=[];for(let offset=0;offset<db.count()&&result.length<100;offset+=200){for(const r of db.page(offset,200).entries)if(r.container==='mp4'&&r.filename.toLowerCase().includes(query.toLowerCase()))result.push({id:r.objectId.replace('/item/','/catalog-item/'),title:r.filename});}return result.slice(0,100);},
    mpeg2TrialStatus:()=>jit.mpeg2TrialStatus(),
    configureMpeg2Trial:(input:unknown)=>jit.configureMpeg2Trial(input),
    compatibilityStatus:()=>jit.compatibilityStatus(),
    configureCompatibility:(input:unknown)=>jit.configureCompatibility(input),
    jitStatus:()=>jit.status(),
    async jitMedia(req:IncomingMessage,res:ServerResponse,token:string,generic=false) {jit.receive(req);try{const c=await load(),db=await index(),e=c?.enabled||db?.enabled?await lookup(`experimental/${generic?'catalog-item':'item'}/${token}`):undefined;if(!e){res.writeHead(404);res.end();return;}if(!await sourceContained(e.fingerprint.path,folders())){res.writeHead(403);res.end();return;}await jit.deliver(req,res,e);}catch{if(!res.headersSent&&!res.destroyed)res.writeHead(503);if(!res.destroyed)res.end();}},
    async imageMedia(req:IncomingMessage,res:ServerResponse,token:string){const db=await index(),r=db?.get(`experimental/item/${token}`);if(!r||r.container!=='webp'||r.availability!=='available'){res.writeHead(404);res.end();return;}if(!await sourceContained(r.path,folders())){res.writeHead(403);res.end();return;}return images.deliver(req,res,r,await jit.client(req));},
    async entry(objectId: string) { return lookup(objectId); },
    async decide(request: import('./playback-shadow.js').ShadowRequest) {
      const entry = (await load())?.entries.find(e => matchingFingerprint(e.fingerprint, request.fingerprint));
      return entry?.adapter?.kind === 'verified-artifact' ? artifacts.decide(request, entry.adapter) : undefined;
    },
    async boundEntries() { return (await load())?.entries.filter(e => e.adapter?.kind === 'verified-artifact') ?? []; },
    async protocolInfos(remoteIp: string) {
      const values: string[] = [];
      try {
        for (const entry of (await load())?.entries ?? []) {
          const adapter = resolveExperimentalAdapter(entry, selectedCachedDecision(entry, remoteIp));
          if (adapter && await validateArtifact(adapter)) values.push(adapter.protocolInfo);
        }
        values.push(...await jit.protocolInfos(remoteIp,(await load())?.entries??[]));
        const imageTarget=await images.target(remoteIp);if(imageTarget&&(await index())?.photoCount())values.push(imageTarget.protocolInfo);
        return [...new Set(values)];
      } catch { return []; } // Experimental corruption must not break normal ConnectionManager.
    },
    async browse(request: BrowseInput, remoteIp: string, baseUrl: string, legacyRoot: (metadata: boolean) => BrowsePage, publicOnly=false) {
      if(publicOnly&&developmentDirectory(request.objectId))return {didl:wrap([]),numberReturned:0,total:0,updateId:await this.updateId()};
      if(publicOnly&&request.objectId==='0'){
        const db=await index(),photos=db?.enabled?db.photoCount():0,old=legacyRoot(request.metadata);
        const entries=[/<DIDL-Lite\b[^>]*>([\s\S]*)<\/DIDL-Lite>/.exec(legacyRoot(false).didl)?.[1]??''];
        if(photos)entries.push(`<container id="photos" parentID="0" restricted="1" childCount="${photos}"><dc:title>写真・画像</dc:title><upnp:class>object.container</upnp:class></container>`);
        const updateId=await this.updateId();
        if(request.metadata)return {...old,didl:old.didl.replace(/childCount="\d+"/,`childCount="${entries.length}"`),updateId};
        const selected=entries.slice(request.start,request.count?request.start+request.count:undefined);
        return {didl:wrap(selected),numberReturned:selected.length,total:entries.length,updateId};
      }
      if(request.objectId===PHOTO_ROOT||request.objectId.startsWith('photos/item/')){
        const db=await index();if(!db?.enabled)return {didl:wrap([]),numberReturned:0,total:0};
        const target=await images.target(remoteIp),container=`<container id="photos" parentID="0" restricted="1" childCount="${db.photoCount()}"><dc:title>写真・画像</dc:title><upnp:class>object.container</upnp:class></container>`;
        if(request.objectId===PHOTO_ROOT&&request.metadata)return {didl:wrap([container]),numberReturned:1,total:1,updateId:db.updateId};
        const page=db.photoPage(request.start,request.count),r=request.metadata?db.get(request.objectId.replace('photos/item/','experimental/item/')):undefined;
        const rows=request.metadata?(r?.container==='webp'&&r.availability==='available'?[r]:[]):page.entries;
        return {didl:wrap(rows.map(r=>photoItem(r,baseUrl,target))),numberReturned:rows.length,total:request.metadata?rows.length:page.total,updateId:db.updateId};
      }
      if (request.objectId !== '0' && request.objectId !== 'experimental' && !request.objectId.startsWith('experimental/')) return undefined;
      try {
        let original = await load();const db=await index();let dbPage:ReturnType<MediaIndex['page']>|undefined;
        const genericView=db?.enabled&&await jit.genericView(),generic=request.objectId==='experimental/catalog'||request.objectId.startsWith('experimental/catalog-item/');
        if(generic&&!genericView)return undefined;
        if(db?.enabled){
          let entries:ExperimentalEntry[]=[];
          if((request.objectId==='experimental'||request.objectId==='experimental/catalog')&&!request.metadata){dbPage=db.page(request.start,request.count);entries=dbPage.entries.map(r=>{const e=indexedExperimentalEntry(r);if(generic)return {...e,objectId:e.objectId.replace('/item/','/catalog-item/')};const overlay=original?.entries.find(v=>v.objectId===e.objectId);return overlay?{...overlay,...e,decisions:overlay.decisions,adapter:overlay.adapter}:e;});}
          else if(request.objectId.startsWith('experimental/item/')||request.objectId.startsWith('experimental/catalog-item/')){const e=await lookup(request.objectId);if(e)entries=[e];}
          original={version:CATALOG_VERSION,enabled:true,generatedAt:'index',entries,indexedTotal:(dbPage?.total??db.count())+(request.objectId==='0'&&genericView?1:0)};
        }
        if (!original) return undefined;
        const renderRequest=dbPage?{...request,objectId:generic?'experimental':request.objectId,start:0,count:0}:request.objectId==='experimental/catalog'?{...request,objectId:'experimental'}:request;
        let catalog = await currentEntries(original, renderRequest, remoteIp);
        const ids=new Set((renderRequest.objectId==='experimental'&&!renderRequest.metadata?catalog.entries.slice(renderRequest.start,renderRequest.count?renderRequest.start+renderRequest.count:undefined):catalog.entries.filter(e=>e.objectId===request.objectId)).map(e=>e.objectId));
        catalog={...catalog,entries:await Promise.all(catalog.entries.map(e=>ids.has(e.objectId)?jit.decorate(e,remoteIp):e))};
        const rendered = browseExperimental(catalog, renderRequest, remoteIp, baseUrl, legacyRoot);
        let page=rendered&&db?.enabled?{...rendered,total:dbPage?.total??rendered.total,updateId:dbPage?.updateId??db.updateId}:rendered;
        if(page&&generic&&request.objectId==='experimental/catalog'&&request.metadata)page={...page,didl:page.didl.replace('id="experimental" parentID="0"','id="experimental/catalog" parentID="experimental"').replace('Experimental Media','Catalog JIT (generic)')};
        if(page&&genericView&&!generic&&request.objectId==='experimental'){
          const n=db!.count(),limit=request.count===0?200:Math.min(request.count,200);
          if(request.metadata)page={...page,didl:page.didl.replace(`childCount="${n}"`,`childCount="${n+1}"`)};
          else{if(request.start<=n&&request.start+limit>n)page={...page,numberReturned:page.numberReturned+1,didl:page.didl.replace('</DIDL-Lite>',`<container id="experimental/catalog" parentID="experimental" restricted="1" childCount="${n}"><dc:title>Catalog JIT (generic)</dc:title><upnp:class>object.container</upnp:class></container></DIDL-Lite>`)};page={...page,total:n+1};}
        }
        if(page&&request.objectId==='0'&&db?.enabled&&db.photoCount()){
          const all=browseExperimental(catalog,{...renderRequest,start:0,count:0},remoteIp,baseUrl,legacyRoot)!;
          if(request.metadata)page={...page,didl:all.didl.replace(/childCount="2"/, 'childCount="3"')};
          else{const entries:string[]=[...(all.didl.match(/<container\b[\s\S]*?<\/container>/g)??[])];entries.push(`<container id="photos" parentID="0" restricted="1" childCount="${db.photoCount()}"><dc:title>写真・画像</dc:title><upnp:class>object.container</upnp:class></container>`);const chosen=entries.slice(request.start,request.start+Math.min(request.count||200,200));page={...page,didl:wrap(chosen),numberReturned:chosen.length,total:entries.length};}
        }
        if (request.metadata && request.objectId.startsWith('experimental/item/')) {
          const entry = catalog.entries.find(e => e.objectId === request.objectId);
          if (entry) trace('Experimental item selected (cached decision only)', { objectId: entry.objectId, fingerprint: entry.fingerprint,
            sourceState: entry.sourceState, cachedDecision: selectedCachedDecision(entry, remoteIp), adapterApplied: false });
        }
        return page;
      } catch { return undefined; }
    },
    async media(req: IncomingMessage, res: ServerResponse, token: string) {
      try {
        const catalog = await load(),db=await index(), entry = catalog?.enabled||db?.enabled ? await lookup(`experimental/item/${token}`) : undefined;
        if (!entry) { res.writeHead(404); res.end(); return; }
        const s = await fs.stat(entry.fingerprint.path);
        const remote = req.socket.remoteAddress || '';
        const localVerification = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && entry.adapter?.kind === 'verified-artifact' && req.headers['x-pt3-artifact-verify'] === entry.adapter.decisionFingerprint;
        const client = localVerification ? entry.decisions.find(d => d.deviceId === entry.adapter?.deviceId)?.remoteIp || remote : remote;
        const decision = s.size === entry.fingerprint.size && s.mtimeMs === entry.fingerprint.mtimeMs ? selectedCachedDecision(entry, client) : undefined;
        const adapter = resolveExperimentalAdapter(entry, decision);
        trace('Experimental playback adapter boundary', { objectId: entry.objectId, cachedDecision: decision, adapterApplied: !!adapter });
        if (!adapter) { res.writeHead(409, { 'Content-Length': 0 }); res.end(); return; }
        return artifacts.deliver(req, res, adapter, decision?.decisionId);
      } catch { if (!res.headersSent) res.writeHead(503, { 'Content-Length': 0 }); res.end(); }
    }
  };
}
