import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DiagnosticLog } from './diagnostic-log.js';
import { experimentalCatalogDirectory, experimentalObjectId, CATALOG_VERSION, cachedExperimentalDecision, type ExperimentalCatalog } from './experimental-catalog.js';
import { shadowDirectory, sourceCacheFile, readShadowJson, saveShadowJson } from './playback-shadow-store.js';
import { runShadow, matchingFingerprint, SHADOW_VERSION, type SourceSnapshot, type CapabilitySnapshot, type ShadowPolicy } from './playback-shadow.js';

/** Explicit opt-in preparation. Directory discovery/stat and cache reads only; no media probe or encoder. */
export async function prepareExperimentalCatalog(folders: string[], directory: string, shadow: string): Promise<ExperimentalCatalog> {
  new DiagnosticLog(directory).assertSeparate(folders);
  const files = new Set<string>();
  async function walk(folder: string) {
    for (const e of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.resolve(folder, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(file);
      else if (e.isFile() && /\.(mp4|mkv)$/i.test(e.name)) files.add(file);
    }
  }
  for (const folder of folders) await walk(folder);
  const policy = await readShadowJson<ShadowPolicy>(path.join(shadow, 'policy.json'));
  const capabilities: CapabilitySnapshot[] = [];
  for (const name of await fs.readdir(path.join(shadow, 'capabilities')).catch(() => [] as string[])) {
    try { const c = await readShadowJson<CapabilitySnapshot>(path.join(shadow, 'capabilities', name));
      if (c && Date.now() - Date.parse(c.acquiredAt) >= 0 && Date.now() - Date.parse(c.acquiredAt) < 300000) capabilities.push(c);
    } catch { /* A broken cache cannot create a playable resource. */ }
  }
  const entries: ExperimentalCatalog['entries'] = [];
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    const stat = await fs.stat(file), fingerprint = { path: file, size: stat.size, mtimeMs: stat.mtimeMs };
    let source: SourceSnapshot | undefined;
    try { source = await readShadowJson<SourceSnapshot>(sourceCacheFile(shadow, file)); } catch {}
    if (source?.version !== SHADOW_VERSION || !matchingFingerprint(source.fingerprint, fingerprint)) source = undefined;
    const decisions = [];
    if (policy) for (const capability of capabilities) {
      const record = await runShadow({ fingerprint, remoteIp: capability.remoteIp, method: 'catalog-prepare', headers: {}, actualPlaybackPath: 'catalog-only; no executor' }, {
        source: async () => source, capability: async () => capability, policy: async () => policy,
        record: record => saveShadowJson(path.join(directory, 'decisions', `${record.decisionId}.json`), record)
      });
      const cached = cachedExperimentalDecision(record); if (cached) decisions.push(cached);
    }
    entries.push({ objectId: experimentalObjectId(file), filename: path.basename(file), fingerprint, sourceState: source ? 'cached' : 'unanalysed', decisions });
  }
  const catalog: ExperimentalCatalog = { version: CATALOG_VERSION, enabled: true, generatedAt: new Date().toISOString(), entries };
  await saveShadowJson(path.join(directory, 'catalog.json'), catalog);
  return catalog;
}
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('prepare-experimental-catalog.ts')) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--enable', '--disable'].includes(args[0])) throw new Error('media:experimental-catalog -- --enable | --disable');
  const directory = experimentalCatalogDirectory();
  const settings = await readShadowJson<{ folders: string[] }>(path.resolve(process.env.PT3_DATA_DIR || 'data', 'settings.json'));
  const folders = settings?.folders ?? []; new DiagnosticLog(directory).assertSeparate(folders);
  if (args[0] === '--disable') {
    const {INDEX_FILE,openMediaIndex}=await import('./media-catalog-index.js');
    if(await fs.stat(path.join(directory,INDEX_FILE)).catch(()=>undefined)){
      const db=await openMediaIndex(directory);try{db.enable(false);}finally{db.close();}
    }
    const catalog = await readShadowJson<ExperimentalCatalog>(path.join(directory, 'catalog.json'));
    if (catalog) await saveShadowJson(path.join(directory, 'catalog.json'), { ...catalog, enabled: false });
    console.log('Experimental container disabled; recordings/settings unchanged.');
  } else {
    const c = await prepareExperimentalCatalog(folders, directory, shadowDirectory());
    console.log(JSON.stringify({ enabled: c.enabled, entries: c.entries.length, cachedSources: c.entries.filter(e => e.sourceState === 'cached').length, cachedDecisions: c.entries.reduce((n, e) => n + e.decisions.length, 0), playableResources: 0, files: c.entries.map(e => e.filename) }, null, 2));
  }
}
