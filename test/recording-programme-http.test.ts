import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture } from './broadcast-fixture.js';
test('OFF -> automatic programme publication, old aliases, source bytes, seeks, revision invalidation, restart and rollback', { timeout: 120000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pt3-programme-http-')), data = path.join(root, 'data'), media = path.join(root, 'media'), source = path.join(media, 'source.ts');
    await fs.mkdir(data);
    await fs.mkdir(media);
    const bytes = fixture();
    await fs.writeFile(source, bytes);
    await fs.utimes(source, new Date(0), new Date(0));
    const stamp = await fs.stat(source), udn = 'uuid:00000000-0000-4000-8000-000000000123';
    await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ udn, port: 0, interfaceAddress: '127.0.0.1', folders: [media], profile: 'regza-zp2-buffered' }));
    await fs.writeFile(path.join(data, 'pcr-cache-policy.json'), JSON.stringify({ settleMs: 20, idleGraceMs: 100, readBytesPerSecond: 64 * 1024 ** 2, minFreeBytes: 0 }));
    await fs.mkdir(path.join(data, 'experimental-catalog'));
    await fs.writeFile(path.join(data, 'experimental-catalog', 'library.json'), JSON.stringify({ version: 'recording-library-v1', enabled: true }));
    let child: ChildProcess | undefined, base = '';
    const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'exit');
        child.kill();
        await done;
    } child = undefined; };
    t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
    const start = async (enabled: boolean) => { child = spawn(process.execPath, ['--import', 'tsx', process.env.PT3_TEST_DIST === '1' ? 'dist/src/server.js' : 'src/server.ts'], { env: { ...process.env, PT3_DATA_DIR: data, PT3_LOG_DIR: path.join(root, 'logs'), PT3_DISABLE_SSDP: '1', PT3_BIND_LOOPBACK: '1', PT3_PROGRAMME_TIMELINE: enabled ? '1' : '0', PT3_BACKGROUND_PROCESS_OVERRIDE: '1', PT3_SHADOW_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }); base = await new Promise<string>((resolve, reject) => { let text = ''; const timeout = setTimeout(() => reject(Error(text)), 20000); const read = (b: Buffer) => { text += b; const m = /localhost:(\d+)/.exec(text); if (m && text.includes('スキャン完了')) {
        clearTimeout(timeout);
        resolve('http://127.0.0.1:' + m[1]);
    } }; child!.stdout!.on('data', read); child!.stderr!.on('data', read); child!.once('error', reject); child!.once('exit', code => { if (code)
        reject(Error(text)); }); }); };
    const browse = async (id: string, metadata = false) => { const r = await fetch(base + '/upnp/control/content-directory', { method: 'POST', headers: { SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' }, body: `<ObjectID>${id}</ObjectID><BrowseFlag>${metadata ? 'BrowseMetadata' : 'BrowseDirectChildren'}</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>200</RequestedCount>` }); assert.equal(r.status, 200); return (await r.text()).replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&'); };
    await start(false);
    let p: any;
    for (let i = 0; i < 900; i++) {
        p = (await fetch(base + '/api/programs').then(r => r.json()))[0];
        if (p?.metadata?.state === 'confirmed')
            break;
        await sleep(50);
    }
    assert.equal(p.metadata.state, 'confirmed');
    const oldId = 'item:' + p.id, oldXml = await browse(oldId, true), oldPath = new URL(/<res\b[^>]*>([^<]+)/.exec(oldXml)![1]);
    assert.ok(!(await browse('all')).includes('programme-v1'));
    await stop();
    await start(true);
    let xml = '';
    const publishDeadline=Date.now()+45000;
    while (Date.now()<publishDeadline) {
        xml = await browse('all');
        if (xml.includes('/programme-v1/'))
            break;
        await sleep(30);
    }
    assert.ok(xml.includes('/programme-v1/'),xml+JSON.stringify({pcr:await fetch(base+'/api/pcr-cache').then(r=>r.json()),tail:(await fs.readFile(path.join(root,'logs','diagnostics.jsonl'),'utf8')).split(/\r?\n/).slice(-25)}));
    assert.match(xml, /<item\b[^>]*id=/, xml);
    const newId = /<item[^>]* id="([^"]+)/.exec(xml)![1], newPath = new URL(/<res\b[^>]*>([^<]+)/.exec(xml)![1]);
    assert.ok(newId.startsWith('programme:'));
    assert.equal((xml.match(/<item\b/g) ?? []).length, 1);
    assert.ok(xml.includes('object.item.videoItem</upnp:class>'));
    assert.ok(xml.includes('regza:network_id'));
    assert.ok(!xml.includes('recordedStartDateTime'));
    const meta = await browse(newId, true);
    assert.ok(meta.includes(`id="${newId}"`));
    const badMetadata=await fetch(base+'/upnp/control/content-directory',{method:'POST',headers:{SOAPAction:'"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'},body:`<ObjectID>programme:${p.id}:${'0'.repeat(24)}</ObjectID><BrowseFlag>BrowseMetadata</BrowseFlag>`});assert.equal(badMetadata.status,500);assert.ok((await badMetadata.text()).includes('<errorCode>701</errorCode>'));
    const legacy = await browse(oldId, true);
    assert.ok(legacy.includes(`id="${oldId}"`));
    assert.ok(!legacy.includes('/programme-v1/'));
    assert.equal((await fetch(base + '/api/status').then(r => r.json())).settings.udn, udn);
    const url = () => base + newPath.pathname;
    const head = await fetch(url(), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(head.headers.get('timeseekrange.dlna.org')!.includes('/40.000'));
    for (const q of [0, 12, 37]) {
        const r = await fetch(url(), { headers: { 'TimeSeekRange.dlna.org': `npt=${q}-${q + 1}` } });
        assert.equal(r.status, 200);
        const wire = Buffer.from(await r.arrayBuffer()), range = r.headers.get('timeseekrange.dlna.org')!, firstBytes = Number(/bytes=(\d+)/.exec(range)![1]), block = 960, firstPacket = 100 + Math.floor(firstBytes / (block + 14)) * 5, parts: Buffer[] = [];
        for (let o = 0; o < wire.length;) {
            const n = wire.readUInt32BE(o + 10);
            for (let j = o + 14; j < o + 14 + n; j += 192)
                parts.push(wire.subarray(j + 4, j + 192));
            o += 14 + n;
        }
        const raw = Buffer.concat(parts);
        assert.deepEqual(raw, bytes.subarray(firstPacket * 188, firstPacket * 188 + raw.length));
        assert.equal(wire.length, Number(r.headers.get('content-length')));
    }
    const mediaLogs=(await fs.readFile(path.join(root,'logs','diagnostics.jsonl'),'utf8')).trim().split(/\r?\n/).map(s=>JSON.parse(s)).filter(e=>e.category==='HTTP_MEDIA'&&e.url?.startsWith('/programme-v1/'));assert.ok(mediaLogs.length);for(const e of mediaLogs){const d=e.detail;assert.equal(d.pacingMode,'local-pcr');assert.ok(d.wholeFileBitsPerSecond>d.encapsulation.payloadBitsPerSecond,'content-packet overhead must not be reduced by excluded recording margins');assert.ok(Math.abs(d.wholeFileBitsPerSecond-d.encapsulation.payloadBitsPerSecond*d.encapsulation.servedBytes/d.encapsulation.payloadBytes)<0.0001);}
    const transfers=(await fs.readFile(path.join(root,'logs','diagnostics.jsonl'),'utf8')).trim().split(/\r?\n/).map(s=>JSON.parse(s));assert.ok(transfers.some(e=>e.category==='HTTP_TRANSFER'&&e.url?.startsWith('/programme-v1/')&&e.message==='HTTP_TRANSFER_FINISH'&&e.detail.completed));
    let folder = '';
    for (let i = 0; i < 200; i++) {
        folder = await browse('folders');
        if (/id="library\/folder\//.test(folder))
            break;
        await sleep(50);
    }
    const folderId = /<container id="(library\/folder\/[a-f0-9]+)"/.exec(folder)?.[1];
    assert.ok(folderId, folder);
    const folderXml = await browse(folderId), folderProgrammeId = /<item[^>]* id="([^"]+)"/.exec(folderXml)?.[1];
    assert.ok(folderProgrammeId?.startsWith('programme:'), folderXml);
    assert.ok((await browse(folderProgrammeId!, true)).includes(folderProgrammeId!));
    const notify: string[] = [];
    const callback = createServer(async (req, res) => { let text = ''; for await (const b of req)
        text += b; notify.push(text); res.end(); });
    await new Promise<void>(resolve => callback.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => callback.close(() => resolve())));
    const callbackPort = (callback.address() as {
        port: number;
    }).port, sub = await fetch(base + '/upnp/event/content-directory', { method: 'SUBSCRIBE', headers: { CALLBACK: '<http://127.0.0.1:' + callbackPort + '/notify>', NT: 'upnp:event', TIMEOUT: 'Second-30' } });
    assert.equal(sub.status, 200);
    for (let i = 0; i < 50 && !notify.length; i++)
        await sleep(20);
    assert.ok(notify.length);
    const beforeUpdate = Number(/<Id>(\d+)/.exec(await fetch(base + '/upnp/control/content-directory', { method: 'POST', headers: { SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#GetSystemUpdateID"' } }).then(r => r.text()))![1]);
    const cacheDir = path.join(data, 'eit-cache');
    let cacheFile = '';
    for (const f of await fs.readdir(cacheDir)) {
        const full = path.join(cacheDir, f), record = JSON.parse(await fs.readFile(full, 'utf8'));
        if (record.source === source) {
            cacheFile = full;
            break;
        }
    }
    assert.ok(cacheFile);
    const broken = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    broken.sha256 = '0'.repeat(64);
    await fs.writeFile(cacheFile, JSON.stringify(broken));
    assert.equal((await fetch(url(), { method: 'HEAD' })).status, 410);
    const refresh = await fetch(base + '/api/metadata/refresh', { method: 'POST', headers: { 'X-PT3-Management': '1' } });
    assert.equal(refresh.status, 200);
    const repairDeadline = Date.now() + 30000;
    while (Date.now() < repairDeadline) {
        if ((await browse('all')).includes('/programme-v1/'))
            break;
        await sleep(50);
    }
    assert.ok((await browse('all')).includes('/programme-v1/'),JSON.stringify({pcr:await fetch(base+'/api/pcr-cache').then(r=>r.json()),tail:(await fs.readFile(path.join(root,'logs','diagnostics.jsonl'),'utf8')).split(/\r?\n/).slice(-25)}));
    const afterUpdate = Number(/<Id>(\d+)/.exec(await fetch(base + '/upnp/control/content-directory', { method: 'POST', headers: { SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#GetSystemUpdateID"' } }).then(r => r.text()))![1]);
    assert.ok(afterUpdate > beforeUpdate);
    for (let i = 0; i < 150 && !notify.some(n => n.includes('<SystemUpdateID>' + afterUpdate + '</SystemUpdateID>')); i++)
        await sleep(20);
    assert.ok(notify.some(n => n.includes('<SystemUpdateID>' + afterUpdate + '</SystemUpdateID>')));
    await fetch(base + '/upnp/event/content-directory', { method: 'UNSUBSCRIBE', headers: { SID: sub.headers.get('sid')! } });
    const cancelling = new AbortController(), oldGet = await fetch(url(), { signal: cancelling.signal }), oldReader = oldGet.body!.getReader();
    await oldReader.read();
    const replacement = await fetch(url(), { headers: { 'TimeSeekRange.dlna.org': 'npt=12-13' } });
    assert.equal(replacement.status, 200);
    await replacement.arrayBuffer();
    cancelling.abort();
    await oldReader.cancel().catch(() => { });
    await sleep(100);
    assert.equal((await fetch(base + '/api/pcr-cache').then(r => r.json())).work.mediaRequests, 0);
    await fs.rename(source,source+'.temporarily-missing');try{const missing=await fetch(url());assert.ok([403,404,410].includes(missing.status),'missing source must be refused; Public containment may return 403 before shared 404/410');await missing.arrayBuffer();assert.equal((await fetch(base+'/api/status').then(r=>r.json())).running,true);}finally{await fs.rename(source+'.temporarily-missing',source);}
    const oldHead = await fetch(base + oldPath.pathname + oldPath.search, { method: 'HEAD' });
    assert.equal(oldHead.status, 200);
    assert.ok(oldHead.headers.get('timeseekrange.dlna.org')!.includes('/60.000'));
    assert.equal((await fetch(url().replace(/\/[a-f0-9]{24}\.tts$/, '/' + '0'.repeat(24) + '.tts'), { method: 'HEAD' })).status, 410);
    await stop();
    await start(true);
    assert.ok((await browse(newId, true)).includes('/programme-v1/'));
    await stop();
    await start(false);
    assert.equal((await fetch(url(), { method: 'HEAD' })).status, 404);
    assert.ok(!(await browse('all')).includes('programme-v1'));
    const final = await fs.stat(source);
    assert.equal(final.size, stamp.size);
    assert.equal(final.mtimeMs, stamp.mtimeMs);
});
