import {virtualId} from '../src/virtual-folders.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { browseDIDL, browsePrograms, browseRequest } from '../src/upnp.js';
import { profiles } from '../src/core.js';
import { Program } from '../src/store.js';
import { buildPcrIndex, clearPcrIndexCache, pcrIndexCacheStatus } from '../src/pcr-index.js';
import { syntheticTs } from './ts-fixture.js';

test('5000件のBrowseは要求ページだけXML化し件数/末尾/メタデータを維持する', () => {
  let titlesRead = 0;
  const programs: Program[] = Array.from({ length: 5000 }, (_, i) => ({
    id: i.toString(16), filePath: `unused-${i}.ts`, size: 18800, modified: '2026-10-05', published: i !== 0,
    analysis: 'ok', get title() { titlesRead++; return `番組${i}`; }
  }));
  const page = browseDIDL(virtualId('all','media',4000,1000), 0, 25, programs, 'http://localhost', profiles.standard);
  assert.equal(page.total, 999); assert.equal(page.numberReturned, 25); assert.equal(titlesRead, 50);
  assert.ok(page.didl.includes('番組4001')); assert.ok(!page.didl.includes('番組4000<'));
  const request = browseRequest('<ObjectID>'+virtualId('all','media',4000,1000)+'</ObjectID><StartingIndex>0</StartingIndex><RequestedCount>25</RequestedCount>');
  assert.equal(browsePrograms(request.objectId, request.start, request.count, programs).selected.length, 25);
  assert.equal(browseDIDL(virtualId('all','media',4000,1000), 990, 25, programs, '', profiles.standard).numberReturned, 9);
  assert.equal(browseDIDL(virtualId('all','media',4000,1000), 1000, 25, programs, '', profiles.standard).numberReturned, 0);
  assert.equal(browseDIDL('item:abc', 0, 1, programs, '', profiles.standard, true).numberReturned, 1);
  assert.equal(browseDIDL(virtualId('all','media',4000,1000), 998, 0, programs, '', profiles.standard).numberReturned, 1);
});

test('PCR永続キャッシュ: 並行要求統合/プロセス再起動/更新/破損/録画内保存拒否', async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'pt3-library-cache-'));
  const data = path.join(dir, 'data'), media = path.join(dir, 'media'); await fs.mkdir(media);
  const oldData = process.env.PT3_DATA_DIR; process.env.PT3_DATA_DIR = data;
  t.after(async () => { if (oldData === undefined) delete process.env.PT3_DATA_DIR; else process.env.PT3_DATA_DIR = oldData; clearPcrIndexCache(); await fs.rm(dir, { recursive: true, force: true }); });
  const file = path.join(media, 'fixture.ts'); await fs.writeFile(file, syntheticTs(2000, 5000));
  const before = await fs.stat(file), builds = pcrIndexCacheStatus().builds;
  const [a, b] = await Promise.all([buildPcrIndex(file), buildPcrIndex(file)]); assert.ok(a); assert.equal(a, b);
  assert.equal(pcrIndexCacheStatus().builds, builds + 1);
  assert.equal(pcrIndexCacheStatus().error, null);
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import {buildPcrIndex,pcrIndexCacheStatus} from './src/pcr-index.ts'; await buildPcrIndex(process.argv[1]); console.log(JSON.stringify(pcrIndexCacheStatus()));", file],
    { cwd: process.cwd(), env: { ...process.env, PT3_DATA_DIR: data } });
  const restarted = JSON.parse(stdout); assert.equal(restarted.diskHits, 1, stdout); assert.equal(restarted.builds, 0);
  await fs.writeFile(file, syntheticTs(3000, 6000)); clearPcrIndexCache();
  const changed = await buildPcrIndex(file); assert.ok(changed); assert.equal(changed.packetCount, 3000); assert.notEqual(changed.averageBitrate, a.averageBitrate);
  const cacheDir = path.join(data, 'pcr-cache'), names = await fs.readdir(cacheDir); assert.equal(names.length, 1);
  await fs.writeFile(path.join(cacheDir, names[0]), '{broken'); clearPcrIndexCache();
  assert.deepEqual(await buildPcrIndex(file), changed);
  assert.equal(pcrIndexCacheStatus().builds, builds + 3);
  const after = await fs.stat(file); assert.equal(after.size, 3000 * 188); assert.notEqual(after.size, before.size);
  process.env.PT3_DATA_DIR = media; clearPcrIndexCache();
  assert.deepEqual(await buildPcrIndex(file), changed); assert.ok(pcrIndexCacheStatus().error?.includes('録画フォルダー'));
  assert.deepEqual((await fs.readdir(media)).sort(), ['fixture.ts']);
});

test('実HTTP: 5000録画のBrowseはページ内もPCR解析しない; GETで初めて索引を生成する', { timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'pt3-library-http-'));
  const data = path.join(dir, 'data'), media = path.join(dir, 'media'); await fs.mkdir(data); await fs.mkdir(media);
  const fixture = path.join(dir, 'generated.ts'); await fs.writeFile(fixture, syntheticTs(200, 5000));
  const catalog: Program[] = [];
  for (let i = 0; i < 5000; i++) {
    const filePath = path.join(media, `${String(i).padStart(4, '0')}.ts`);
    // NTFS limits links to one file; use independent generated seeds per 1000 entries.
    const seed = path.join(dir, `generated-${Math.floor(i / 1000)}.ts`);
    if (i % 1000 === 0) await fs.copyFile(fixture, seed);
    if (i === 0) await fs.writeFile(filePath, Buffer.alloc(200 * 188)); else await fs.link(seed, filePath);
    const st = await fs.stat(filePath); catalog.push({ id: i.toString(16), filePath, title: `番組${i}`, size: st.size, modified: st.mtime.toISOString(), published: true, analysis: 'ok' });
  }
  await fs.writeFile(path.join(data, 'programs.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ port: 0, folders: [media], interfaceAddress: '127.0.0.1', profile: 'regza-zp2-192-paced-ats-minus-500ms', contentPacketProgramIds: ['0', 'fa0'], timeSeekProgramIds: ['fa0'] }));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env: { ...process.env, PT3_DATA_DIR: data, PT3_LOG_DIR: path.join(dir, 'logs'), PT3_DISABLE_SSDP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } await fs.rm(dir, { recursive: true, force: true }); });
  const base = await new Promise<string>((resolve, reject) => {
    // Baseline and current NTFS cold-cache metadata lookups can exceed 30s for 5000 entries.
    // This is a startup wait budget, not a relaxation of the no-PCR/Browse/GET assertions.
    let output = ''; const timer = setTimeout(() => reject(new Error('Server readiness exceeded 60s: '+output)), 60000);
    const consume = (chunk: Buffer) => { output += chunk.toString(); const match = /http:\/\/(?:localhost|127\.0\.0\.1):\d+/.exec(output); if (match) { clearTimeout(timer); resolve(match[0].replace('localhost', '127.0.0.1')); } };
    child.stdout.on('data', consume); child.stderr.on('data', consume); child.once('error', e => { clearTimeout(timer); reject(e); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`exit ${code}: ${output}`)); });
  });
  async function soap(action: string, payload: string) {
    const response = await fetch(base + '/upnp/control/content-directory', { method: 'POST', headers: { soapaction: `"urn:schemas-upnp-org:service:ContentDirectory:1#${action}"` }, body: payload });
    assert.equal(response.status, 200); return response.text();
  }
  const status = async () => (await fetch(base + '/api/status')).json();
  assert.equal((await status()).programCount, 5000);
  const root = await soap('Browse', '<ObjectID>0</ObjectID><RequestedCount>1</RequestedCount>'); assert.ok(root.includes('録画番組'));
  await soap('GetProtocolInfo', ''); assert.equal((await status()).pcrCache.builds, 0);
  const page = await soap('Browse', '<ObjectID>'+virtualId('all','media',4000,1000)+'</ObjectID><StartingIndex>0</StartingIndex><RequestedCount>25</RequestedCount>');
  assert.ok(page.includes('<NumberReturned>25</NumberReturned>')); assert.ok(page.includes('<TotalMatches>1000</TotalMatches>'));
  assert.ok(page.includes('encapsulation=arib-content-packet')); assert.ok(page.length < 30000);
  assert.equal((await status()).pcrCache.builds, 0);
  assert.equal(await soap('Browse', '<ObjectID>'+virtualId('all','media',4000,1000)+'</ObjectID><StartingIndex>0</StartingIndex><RequestedCount>25</RequestedCount>'), page);
  assert.equal((await status()).pcrCache.builds, 0);
  const decoded=page.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&').replaceAll('&quot;','"');
  const resource=/<res\b[^>]*>([^<]+)<\/res>/.exec(decoded)![1].replaceAll('&amp;','&');
  assert.ok(!/<res\b[^>]*>/.exec(decoded)![0].includes('size='),'Unknown wrapped size must not be guessed');
  const response=await fetch(resource,{headers:{'TimeSeekRange.dlna.org':'npt=0-0.1'}});assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>0);
  assert.equal((await status()).pcrCache.builds,1);
  await soap('Browse','<ObjectID>'+virtualId('all','media',4000,1000)+'</ObjectID><StartingIndex>0</StartingIndex><RequestedCount>25</RequestedCount>');
  assert.equal((await status()).pcrCache.builds,1);
});
