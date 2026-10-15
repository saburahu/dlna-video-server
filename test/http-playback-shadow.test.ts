import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { syntheticTs } from './ts-fixture.js';
import { sourceCacheFile } from '../src/playback-shadow-store.js';
import { experimentalObjectId, CATALOG_VERSION } from '../src/experimental-catalog.js';

test('normal HTTP shadow cache failure preserves full TS/TTS, HEAD, TimeSeek, Range, pacing and startup', { timeout: 35000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-shadow-')), data = path.join(dir, 'data'), media = path.join(dir, 'media'), shadow = path.join(dir, 'shadow');
  await fs.mkdir(data); await fs.mkdir(media);
  const file = path.join(media, 'synthetic.ts'), source = syntheticTs(1500, 500);
  await fs.writeFile(file, source); const st = await fs.stat(file);
  let child: ChildProcess | undefined;
  const stop = async () => { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } child = undefined; };
  t.after(async () => { await stop(); await fs.rm(dir, { recursive: true, force: true }); });
  async function start(disabled: boolean) {
    await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ port: 0, interfaceAddress: '127.0.0.1', folders: [media], profile: 'regza-zp2-buffered' }));
    await fs.writeFile(path.join(data, 'programs.json'), JSON.stringify([{ id: 'abcdef', filePath: file, title: 'fixture', size: st.size, modified: st.mtime.toISOString(), published: true, analysis: 'ok', duration: 3 }]));
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { env: { ...process.env, PT3_DATA_DIR: data, PT3_LOG_DIR: path.join(dir, 'logs'), PT3_SHADOW_DIR: shadow, PT3_EXPERIMENTAL_CATALOG_DIR: path.join(dir, 'experimental'), PT3_SHADOW_DISABLED: disabled ? '1' : '0', PT3_DISABLE_SSDP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise<string>((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error(output)), 10000);
      child!.once('error', reject); child!.stderr!.on('data', b => { output += b; }); child!.stdout!.on('data', b => { output += b; const match = /管理画面: http:\/\/localhost:(\d+)/.exec(output); if (match && output.includes('スキャン完了')) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
    });
  }
  const conditions: { method: string; headers: Record<string, string> }[] = [{ method: 'GET', headers: {} }, { method: 'HEAD', headers: {} },
    { method: 'GET', headers: { 'TimeSeekRange.dlna.org': 'npt=1-2' } }, { method: 'GET', headers: { Range: 'bytes=0-191' } }];
  const receive = async (base: string, condition: typeof conditions[number]) => {
    const start = performance.now(), response = await fetch(base + '/media/abcdef', condition), headers = Object.fromEntries([...response.headers].filter(([key]) => !['date', 'keep-alive'].includes(key)));
    const firstMs = performance.now() - start, body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers, body, firstMs, elapsedMs: performance.now() - start };
  };
  const base = await start(true), before = [];
  const browse = async (base: string, id: string, metadata = false) => {
    const r = await fetch(base + '/upnp/control/content-directory', { method: 'POST', headers: { SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' },
      body: `<ObjectID>${id}</ObjectID><BrowseFlag>${metadata ? 'BrowseMetadata' : 'BrowseDirectChildren'}</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>0</RequestedCount>` });
    assert.equal(r.status, 200); return (await r.text()).replace(/:\d+\//g, ':PORT/');
  };
  const cold=await browse(base,'all');assert.ok(!cold.includes(' size=&quot;'),'Unindexed wrapped size is unknown');
  assert.equal((await fetch(base+'/api/status').then(r=>r.json())).pcrCache.builds,0,'Browse must not prepare a PCR index');
  // Compare equivalent warm metadata on both runs. Playback, not Browse,
  // establishes the exact wrapped size persisted for subsequent processes.
  await receive(base,{method:'HEAD',headers:{}});
  const normalBefore = await Promise.all(['rec', 'all', 'item:abcdef'].map(id => browse(base, id, id.startsWith('item:'))));
  for (const condition of conditions) before.push(await receive(base, condition));
  await stop();
  const entries = [];
  for (const filename of ['SampleA.mp4', 'SampleB.MP4', 'サンプル映像C.mkv']) {
    const file = path.join(dir, filename); await fs.writeFile(file, 'no valid video; Browse must not decode'); const st = await fs.stat(file);
    entries.push({ objectId: experimentalObjectId(file), filename, fingerprint: { path: file, size: st.size, mtimeMs: st.mtimeMs }, sourceState: 'unanalysed', decisions: [] });
  }
  await fs.mkdir(path.join(dir, 'experimental'));
  await fs.writeFile(path.join(dir, 'experimental', 'catalog.json'), JSON.stringify({ version: CATALOG_VERSION, enabled: true, entries }));
  // Broken offline analysis, not a valid plan. The actual path must still succeed.
  await fs.mkdir(path.dirname(sourceCacheFile(shadow, file)), { recursive: true }); await fs.writeFile(sourceCacheFile(shadow, file), '{broken');
  const enabled = await start(false), after = [];
  assert.deepEqual(await Promise.all(['rec', 'all', 'item:abcdef'].map(id => browse(enabled, id, id.startsWith('item:')))), normalBefore);
  const experimental = await browse(enabled, 'experimental');
  for (const e of entries) assert.ok(!experimental.includes(e.filename));
  assert.ok(!experimental.includes('&lt;res '));
  assert.match(experimental,/<TotalMatches>0<\/TotalMatches>/);
  assert.ok(!(await browse(enabled, '0')).includes('Experimental Media'));
  const refused = await fetch(enabled + '/experimental/media/' + entries[0].objectId.split('/').at(-1));
  assert.equal(refused.status, 409); assert.equal((await refused.arrayBuffer()).byteLength, 0);
  await fs.writeFile(path.join(dir, 'experimental', 'catalog.json'), '{broken');
  assert.deepEqual(await Promise.all(['rec', 'all', 'item:abcdef'].map(id => browse(enabled, id, id.startsWith('item:')))), normalBefore);
  for (const condition of conditions) after.push(await receive(enabled, condition));
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].status, before[i].status); assert.deepEqual(after[i].headers, before[i].headers); assert.deepEqual(after[i].body, before[i].body);
    assert.ok(after[i].firstMs < before[i].firstMs + 600, `startup change ${after[i].firstMs - before[i].firstMs}ms`);
    assert.ok(Math.abs(after[i].elapsedMs - before[i].elapsedMs) < 600, 'pacing differs');
  }
  const logFile = path.join(shadow, 'logs', 'diagnostics.jsonl');
  for (let i = 0; i < 40; i++) { try { if ((await fs.readFile(logFile, 'utf8')).trim().split('\n').length >= 3) break; } catch {} await new Promise(resolve => setTimeout(resolve, 25)); }
  const rows = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 3); assert.ok(rows.every(r => r.decisionStatus === 'error' && r.applied === false));
  assert.ok(rows.every(r => r.actualPlaybackPath.handler === 'existing-serveMedia' && r.actualPlaybackPath.localPcrPacing && r.actualPlaybackPath.pacingLeadMs === 1100));
  assert.ok(rows.some(r => r.request.headers['timeseekrange.dlna.org'] === 'npt=1-2'));
  assert.deepEqual(await fs.readFile(file), source); assert.equal((await fs.stat(file)).mtimeMs, st.mtimeMs);
});
