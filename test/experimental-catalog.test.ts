import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { browseExperimental, createExperimentalCatalog, experimentalObjectId, CATALOG_VERSION, type ExperimentalCatalog, type ExperimentalEntry } from '../src/experimental-catalog.js';
import { prepareExperimentalCatalog } from '../src/prepare-experimental-catalog.js';
import { browseDIDL } from '../src/upnp.js';
import { profiles } from '../src/core.js';
import type { Transport } from '../src/playback-decision.js';
import {openMediaIndex} from '../src/media-catalog-index.js';
import {DatabaseSync} from 'node:sqlite';
const names = ['SampleA.mp4', 'SampleB.MP4', 'サンプル映像C.mkv'];
const entries = (): ExperimentalEntry[] => names.map(filename => ({ objectId: experimentalObjectId('/fixtures/' + filename), filename, fingerprint: { path: '/fixtures/' + filename, size: 100, mtimeMs: 1 }, sourceState: 'unanalysed', decisions: [] }));
const catalog = (): ExperimentalCatalog => ({ version: CATALOG_VERSION, enabled: true, generatedAt: new Date().toISOString(), entries: entries() });
const root = (metadata: boolean) => browseDIDL('0', 0, 0, [], 'http://localhost', profiles.standard, metadata);
const request = (objectId: string, metadata = false, start = 0, count = 0) => ({ objectId, metadata, start, count });
test('temporary SQLite initialization lock does not poison subsequent normal library Browse',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-open-lock-'));
 const db=await openMediaIndex(dir);db.enable(true);db.close();await fs.writeFile(path.join(dir,'library.json'),JSON.stringify({version:'recording-library-v1',enabled:true}));
 const writer=new DatabaseSync(path.join(dir,'media-index.sqlite'));writer.exec('BEGIN IMMEDIATE');
 const errors:string[]=[],controller=createExperimentalCatalog(dir,event=>errors.push(event));t.after(async()=>{await controller.closeIndex();await fs.rm(dir,{recursive:true,force:true});});
 const legacy=(start:number,count:number,metadata:boolean)=>browseDIDL('all',start,count,[],'http://test',profiles.standard,metadata);
 await controller.libraryBrowse(request('all'),'', 'http://test',legacy);assert.ok(errors.includes('LIBRARY_BROWSE_ERROR'));
 writer.exec('ROLLBACK');writer.close();errors.length=0;
 const recovered=await controller.libraryBrowse(request('all'),'', 'http://test',legacy);assert.ok(recovered);assert.ok(recovered.updateId!==undefined);assert.equal(errors.includes('LIBRARY_BROWSE_ERROR'),false);
});
test('opt-in root append preserves original rec XML and pagination', () => {
  assert.equal(browseExperimental(undefined, request('0'), '', '', root), undefined);
  const page = browseExperimental(catalog(), request('0'), '', '', root)!;
  const legacy = root(false).didl.match(/<container[^]*?<\/container>/)![0];
  assert.ok(page.didl.includes(legacy)); assert.equal(page.total, 2);
  assert.ok(page.didl.indexOf('id="rec"') < page.didl.indexOf('id="experimental"'));
  assert.equal(browseExperimental(catalog(), request('0', false, 1, 1), '', '', root)!.numberReturned, 1);
  assert.ok(browseExperimental(catalog(), request('0', true), '', '', root)!.didl.includes('childCount="2"'));
});
test('normal namespaces bypass experimental handling entirely', () => {
  for (const id of ['rec', 'all', 'date', 'folder', 'item:abcdef']) assert.equal(browseExperimental(catalog(), request(id), '', '', () => { throw Error('legacy must not be called'); }), undefined);
});
test('known MP4/MKV filenames visible with stable separated IDs but no invented res', () => {
  const page = browseExperimental(catalog(), request('experimental'), '192.168.1.2', 'http://server', root)!;
  assert.equal(page.total, 3); for (const name of names) assert.ok(page.didl.includes(name));
  assert.ok(!page.didl.includes('<res')); assert.ok(page.didl.includes('unanalysed'));
  assert.equal(experimentalObjectId('/fixtures/SampleA.mp4'), entries()[0].objectId);
});
test('incomplete, diagnostic-only, unsupported or unbound executable decisions never advertise resources', () => {
  for (const disposition of ['incomplete', 'diagnostic-only', 'unsupported', 'executable'] as const) {
    const c = catalog(), e = c.entries[0]; e.sourceState = 'cached';
    e.decisions.push({ remoteIp: '192.168.1.2', deviceId: 'uuid:test', sinkHash: 'hash', acquiredAt: new Date().toISOString(), decisionId: 'id', sourceFingerprint: e.fingerprint, sourceCharacteristics: {}, decisionStatus: 'complete', disposition, candidateStrategies: [], unknowns: [] });
    assert.ok(!browseExperimental(c, request(e.objectId, true), '192.168.1.2', '', root)!.didl.includes('<res'));
  }
});
test('legacy URI-only adapter cannot advertise any resource without verified artifact identity', () => {
  const c = catalog(), e = c.entries[0], now = Date.now(); e.sourceState = 'cached';
  const transport: Transport = { container: 'mpegts', framing: 'jp-content-packet', mime: 'video/vnd.dlna.mpeg-tts', profileName: 'AVC_TS_JP_AAC_T', seek: 'time' };
  const protocolInfo = 'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T;DLNA.ORG_OP=10;DLNA.ORG_CI=1';
  e.decisions = [{ remoteIp: '192.168.1.2', deviceId: 'uuid:test', sinkHash: 'hash', acquiredAt: new Date(now).toISOString(), decisionId: 'id', sourceFingerprint: e.fingerprint, sourceCharacteristics: {}, decisionStatus: 'complete', disposition: 'executable', candidateStrategies: [], unknowns: [], selected: { strategy: 'full-transcode', targetProfileId: 'jp', transport, transforms: [], verification: 'supported-candidate' } }];
  e.adapter = { kind: 'pre-generated-isolated', sourceFingerprint: e.fingerprint, deviceId: 'uuid:test', sinkHash: 'hash', decisionId: 'id', targetProfileId: 'jp', transport, uri: 'http://192.168.1.1:19110/media/test.tts', protocolInfo, size: 10000, durationSeconds: 150, validated: true, experimentReference: 'fixture only' } as any;
  const page = (client: string, time = now) => browseExperimental(c, request(e.objectId, true), client, 'http://server', root, time)!.didl;
  assert.ok(!page('192.168.1.2').includes('<res')); assert.ok(!page('192.168.1.2').includes('video/mp4'));
  assert.ok(!page('192.168.1.3').includes('<res')); assert.ok(!page('192.168.1.2', now + 300001).includes('<res'));
  e.adapter!.sinkHash = 'different'; assert.ok(!page('192.168.1.2').includes('<res'));
});
test('preparation is discovery/cache only; source bytes and mtime preserved; TS excluded', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-catalog-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const media = path.join(dir, 'media'); await fs.mkdir(media);
  for (const n of [...names, 'original.ts']) await fs.writeFile(path.join(media, n), 'not even valid video: must not probe');
  const before = await fs.stat(path.join(media, names[0]));
  const c = await prepareExperimentalCatalog([media], path.join(dir, 'cache'), path.join(dir, 'shadow'));
  assert.equal(c.entries.length, 3); assert.ok(c.entries.every(e => e.sourceState === 'unanalysed'));
  assert.equal((await fs.stat(path.join(media, names[0]))).mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(path.join(media, names[0]), 'utf8'), 'not even valid video: must not probe');
  await assert.rejects(prepareExperimentalCatalog([media], path.join(media, 'unsafe-cache'), path.join(dir, 'shadow')));
});
test('malformed experimental cache does not intercept normal Browse', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-broken-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'catalog.json'), '{broken');
  const controller = createExperimentalCatalog(dir, () => {});
  assert.equal(await controller.browse(request('all'), '', '', root), undefined);
  assert.equal(await controller.browse(request('0'), '', '', root), undefined);
});
