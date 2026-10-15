import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { variablePcrTs } from './ts-fixture.js';
import { buildPcrIndex } from '../src/pcr-index.js';
import { Tts192Transform } from '../src/tts.js';
import { profiles } from '../src/core.js';

test('実HTTP: 可変PCRの188/192/包み区間時計、Range/時間シーク、切断、既定維持', { timeout: 90_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'pt3-local-pcr-'));
  const data = path.join(dir, 'data'), media = path.join(dir, 'media');
  await fs.mkdir(data); await fs.mkdir(media);
  const source = variablePcrTs(), sourcePath = path.join(media, 'variable.ts');
  await fs.writeFile(sourcePath, source);
  const index = (await buildPcrIndex(sourcePath))!, parts: Buffer[] = [];
  await pipeline(createReadStream(sourcePath), new Tts192Transform(0, index.averageBitrate, 0, 40_000 * 192, index, profiles['container-192-mpeg']),
    new Writable({ write(c, _e, cb) { parts.push(Buffer.from(c)); cb(); } }));
  const native = Buffer.concat(parts), nativePath = path.join(media, 'native.m2ts'); await fs.writeFile(nativePath, native);
  const discontinuous = Buffer.from(source); discontinuous[20_000 * 188 + 5] |= 0x80;
  const badPath = path.join(media, 'discontinuous.ts'); await fs.writeFile(badPath, discontinuous);
  const catalog = [];
  for (const [id, file] of [['abcdef', sourcePath], ['abcdef12', nativePath], ['abcdef34', badPath]]) {
    const st = await fs.stat(file); catalog.push({ id, filePath: file, title: id, size: st.size, modified: st.mtime.toISOString(), duration: 1, published: true, analysis: 'ok' });
  }
  await fs.writeFile(path.join(data, 'programs.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ port: 0, interfaceAddress: '127.0.0.1', folders: [media], profile: 'container-188-mpeg' }));
  let child: ChildProcess | undefined;
  async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } child = undefined; }
  t.after(async () => { await stop(); await fs.rm(dir, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env: { ...process.env, PT3_DATA_DIR: data, PT3_LOG_DIR: path.join(dir, 'logs'), PT3_DISABLE_SSDP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return await new Promise<string>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error(output)), 15000);
      child!.once('error', e => { clearTimeout(timer); reject(e); }); child!.once('exit', code => { clearTimeout(timer); reject(new Error(`${code}: ${output}`)); });
      child!.stderr!.on('data', b => { output += b; }); child!.stdout!.on('data', b => { output += b; const m = /管理画面: http:\/\/localhost:(\d+)/.exec(output); if (m && output.includes('スキャン完了')) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); } });
    });
  }
  let url = await start();
  async function api(route: string, body?: unknown) { const r = await fetch(url + route, body === undefined ? undefined : { method: 'POST', headers: { 'X-PT3-Management':'1','content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); }
  async function receive(route: string, headers = {}, halfBytes?: number) {
    const started = performance.now(), r = await fetch(url + route, { headers }); assert.ok([200, 206].includes(r.status));
    const chunks: Buffer[] = []; let bytes = 0, halfMs = 0;
    for await (const chunk of r.body!) { chunks.push(Buffer.from(chunk)); bytes += chunk.length; if (halfBytes && !halfMs && bytes >= halfBytes) halfMs = performance.now() - started; }
    const elapsedMs = performance.now() - started; assert.equal(bytes, Number(r.headers.get('content-length')));
    return { body: Buffer.concat(chunks), halfMs, elapsedMs, headers: r.headers };
  }
  for (const [profile, id, size, expected] of [['container-188-mpeg', 'abcdef', 188, source], ['container-192-mpeg', 'abcdef', 192, native], ['container-192-mpeg', 'abcdef12', 192, native]] as const) {
    await api('/api/settings', { profile });
    const r = await receive(`/media/${id}?pacing=pcr`, {}, 20_000 * size);
    assert.deepEqual(r.body, expected);
    assert.ok(Math.abs(r.halfMs - 2000) < 450, `First half ${profile}/${id}: ${r.halfMs}`);
    assert.ok(Math.abs(r.elapsedMs - r.halfMs - 6000) < 450, `Second half ${profile}/${id}: ${r.elapsedMs-r.halfMs}`);
    console.log(`local PCR ${size}/${id}: first ${r.halfMs.toFixed(0)}ms, second ${(r.elapsedMs-r.halfMs).toFixed(0)}ms`);
    const ranged = await receive(`/media/${id}?pacing=pcr`, { Range: `bytes=${20_000*size+7}-${25_000*size-1}` });
    assert.deepEqual(ranged.body, expected.subarray(20_000*size+7,25_000*size)); assert.ok(Math.abs(ranged.elapsedMs-1500)<350);
    const abort = new AbortController(); const interrupted = await fetch(url+`/media/${id}?pacing=pcr`, { signal: abort.signal }); await interrupted.body!.getReader().read(); abort.abort();
    const after = await receive(`/media/${id}?pacing=pcr`, { Range: `bytes=0-${5000*size-1}` }); assert.ok(Math.abs(after.elapsedMs-500)<300);
  }
  const unavailable = await fetch(url+'/media/abcdef34?pacing=pcr'); assert.equal(unavailable.status,422); await unavailable.json();
  await api('/api/settings', { contentPacketProgramIds: ['abcdef'], timeSeekProgramIds: ['abcdef'], pcrPacingProgramIds: ['abcdef'] });
  const wrapped = '/media/abcdef?encapsulation=arib-content-packet&seek=pcr';
  const envelope = await receive(wrapped+'&pacing=pcr'); assert.ok(Math.abs(envelope.elapsedMs-8000)<450);
  const payload: Buffer[] = []; let pos=0;
  while(pos<envelope.body.length) { assert.ok(envelope.body.subarray(pos,pos+10).equals(Buffer.alloc(10))); const n=envelope.body.readUInt32BE(pos+10); assert.equal(n%192,0); payload.push(envelope.body.subarray(pos+14,pos+14+n));pos+=14+n; }
  assert.equal(pos,envelope.body.length); assert.deepEqual(Buffer.concat(payload),native);
  // One diagnostic variable: initial PCR prebuffer + constant 1.1s schedule lead.
  const blockBytes = envelope.body.readUInt32BE(10);
  const halfPayload = 20_000 * 192;
  const halfWire = halfPayload + Math.ceil(halfPayload / blockBytes) * 14;
  const ahead = await receive(wrapped+'&pacing=pcr&pcrLeadMs=1100', {}, halfWire);
  assert.deepEqual(ahead.body,envelope.body,'Lead must not alter TS/TTS/Content Packet bytes');
  for (const key of ['content-type','content-length','contentfeatures.dlna.org','timeseekrange.dlna.org'])
    assert.equal(ahead.headers.get(key),envelope.headers.get(key));
  assert.ok(Math.abs(ahead.halfMs-900)<450,`Lead first PCR 2s boundary: ${ahead.halfMs}`);
  assert.ok(Math.abs(ahead.elapsedMs-6900)<450,`Lead full PCR 8s boundary: ${ahead.elapsedMs}`);
  assert.ok(Math.abs(ahead.elapsedMs-ahead.halfMs-6000)<450,'Local VBR interval after prebuffer must remain 6s');
  const leadGet=(await api('/api/logs')).findLast((l:any)=>l.category==='HTTP_MEDIA'&&l.detail?.pacingLeadMs===1100);
  assert.equal(leadGet.detail.pacingMode,'local-pcr');assert.equal(leadGet.detail.conversion.atsCounterBits,32);
  for (const route of [wrapped+'&pcrLeadMs=1100',wrapped+'&pacing=pcr&pcrLeadMs=1101','/media/abcdef?pacing=pcr&pcrLeadMs=1100']) {
    const invalidLead=await fetch(url+route);assert.equal(invalidLead.status,400);await invalidLead.json();
  }
  for(const request of ['npt=0-2','npt=4-6']) {
    const r=await receive(wrapped+'&pacing=pcr', {'TimeSeekRange.dlna.org':request});
    const npt=/npt=([\d.]+)-([\d.]+)\/[^ ]+ bytes=(\d+)-(\d+)/.exec(r.headers.get('timeseekrange.dlna.org')!)!;
    assert.deepEqual(r.body,envelope.body.subarray(Number(npt[3]),Number(npt[4])+1));
    assert.ok(Math.abs(r.elapsedMs-(Number(npt[2])-Number(npt[1]))*1000)<350);
  }
  // Explicit URL selection: the successful baseline still uses average pacing.
  await receive(wrapped, {'TimeSeekRange.dlna.org':'npt=0-1'});
  const logs=await api('/api/logs'),getLogs=logs.filter((l:any)=>l.category==='HTTP_MEDIA'&&l.method==='GET');
  assert.equal(getLogs.at(-1).detail.pacingMode,'whole-file-average');
  assert.ok(getLogs.some((l:any)=>l.detail.pacingMode==='local-pcr'));
  assert.equal(logs.filter((l:any)=>l.category==='ERROR').length,0);
  const browse=await fetch(url+'/upnp/control/content-directory',{method:'POST',headers:{soapaction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'},body:'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>all</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>0</RequestedCount><SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>'}); assert.equal(browse.status,200);assert.ok((await browse.text()).includes('pacing=pcr'));
  const invalid=await fetch(url+'/api/settings',{method:'POST',headers:{'X-PT3-Management':'1','content-type':'application/json'},body:JSON.stringify({pcrPacingProgramIds:['abcdef34']})});assert.equal(invalid.status,400);await invalid.json();
  await stop(); url=await start();assert.deepEqual((await api('/api/status')).settings.pcrPacingProgramIds,['abcdef']);
  // Normal catalogue policy must match the verified diagnostic bytes/declarations,
  // without recording IDs or pacing/lead query parameters selecting the behavior.
  await api('/api/settings',{profile:'regza-zp2-192-paced-ats-minus-500ms'});
  const experiment=await receive(wrapped+'&pacing=pcr&pcrLeadMs=1100');
  const seekExperiment=await receive(wrapped+'&pacing=pcr&pcrLeadMs=1100',{'TimeSeekRange.dlna.org':'npt=4-6'});
  await api('/api/settings',{profile:'regza-zp2-buffered',contentPacketProgramIds:[],timeSeekProgramIds:[],pcrPacingProgramIds:[]});
  const catalogue=await fetch(url+'/upnp/control/content-directory',{method:'POST',headers:{soapaction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'},body:'<ObjectID>all</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>3</RequestedCount>'});
  const catalogueText=await catalogue.text();assert.equal(catalogue.status,200);
  const didl=catalogueText.match(/<Result>([\s\S]*?)<\/Result>/)![1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
  const published=didl.match(/<item id="item:abcdef"[\s\S]*?<res[^>]*>([^<]+)<\/res>/)![1].replace(/&amp;/g,'&');
  assert.ok(!published.includes('pacing=')&&!published.includes('pcrLeadMs='));
  assert.ok(didl.includes('DLNA.ORG_OP=10'));
  const badItem=didl.match(/<item id="item:abcdef34"[\s\S]*?<\/item>/)?.[0];
  assert.ok(badItem);assert.ok(!badItem.includes('<res'));
  const normalRoute=new URL(published).pathname+new URL(published).search;
  const normal=await receive(normalRoute,{},halfWire);
  assert.deepEqual(normal.body,experiment.body);
  for(const key of ['content-type','content-length','contentfeatures.dlna.org','availableSeekRange.dlna.org'])assert.equal(normal.headers.get(key),experiment.headers.get(key));
  assert.ok(Math.abs(normal.halfMs-900)<450);assert.ok(Math.abs(normal.elapsedMs-6900)<450);
  const seekNormal=await receive(normalRoute,{'TimeSeekRange.dlna.org':'npt=4-6'});
  assert.deepEqual(seekNormal.body,seekExperiment.body);
  const seekNpt=/npt=([\d.]+)-([\d.]+)/.exec(seekNormal.headers.get('timeseekrange.dlna.org')!)!;
  assert.ok(Math.abs(seekNormal.elapsedMs-Math.max(0,(Number(seekNpt[2])-Number(seekNpt[1]))*1000-1100))<400);
  const normalLog=(await api('/api/logs')).findLast((l:any)=>l.category==='HTTP_MEDIA');
  assert.equal(normalLog.detail.pacingMode,'local-pcr');assert.equal(normalLog.detail.pacingLeadMs,1100);assert.equal(normalLog.detail.conversion.atsCounterBits,32);
  const unavailableNormal=await fetch(url+'/media/abcdef34');assert.equal(unavailableNormal.status,422);await unavailableNormal.json();
});
