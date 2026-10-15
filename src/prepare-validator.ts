import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { buildPcrIndex } from './pcr-index.js';
import { parseHrdTrace, hrdSchedule, bufferOccupancy } from './hrd-audit.js';
import { auditExperimentalAudio } from './experimental-audio-audit.js';
import { cadenceStats } from './experimental-jp-cadence.js';
import { pictureWindows } from './experimental-jp-jitter.js';
import { createExperimentalHandler, experimentalFormat, type ExperimentalMediaConfig } from './experimental-media.js';
import { experimentalLayout } from './experimental-content-packet.js';
import { packetTime, timeSeekSlice } from './time-seek.js';
import { execute, ffmpeg, commandOptions, probePackets, ENCODE_RECIPE, plannedVideoArguments, type EncodeInput } from './prepare-executor.js';

export function verifySelectedPixels(sourceHashes: string[], selectedHashes: string[], retainedIndices: number[]) {
  assert.deepEqual(selectedHashes, retainedIndices.map(i => sourceHashes[i]), 'Selected decoded source pixels differ from planner indices');
}
async function selectedSourcePixels(input: EncodeInput) {
  const selectionFilter = plannedVideoArguments(input, 'unused.ts');
  const select = selectionFilter[selectionFilter.indexOf('-vf') + 1].split(',scale=')[0];
  const hashes = async (filter: string, count: number) => {
    const r = await execute(ffmpeg(), ['-v', 'error', '-nostdin', '-copyts', '-i', input.source, '-t', String(input.seconds), '-map', '0:v:0', '-an', '-vf', filter,
      '-fps_mode', 'passthrough', '-enc_time_base:v', '1/90000', '-frames:v', String(count), '-f', 'framemd5', '-'], commandOptions);
    assert.equal(r.stderr.trim(), '');
    return r.stdout.split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => l.split(',').at(-1)!.trim());
  };
  const source = await hashes('format=yuv420p', input.sourceFrames);
  const selected = await hashes(select + ',format=yuv420p', input.cadence.retained.length);
  assert.equal(source.length, input.sourceFrames);
  verifySelectedPixels(source, selected, input.cadence.retained.map(p => p.index));
  return { retainedDecodedSourcePixelHashesExact: true, sourceFrames: source.length, retainedFrames: selected.length, scope: 'pre-resize decoded frame selection; H.264 encode remains lossy' };
}

export async function validatePreparedArtifact(file: string, input: EncodeInput, evidenceDirectory: string) {
  const selectionEvidence = await selectedSourcePixels(input);
  const directory = path.dirname(file), raw = await fs.readFile(path.join(directory, 'media.ts')), tts = await fs.readFile(file);
  const output = await probePackets(file), video = output.packets.filter((p: any) => p.stream_index === 0), audio = output.packets.filter((p: any) => p.stream_index === 1);
  assert.deepEqual(video.map((p: any) => p.pts), input.cadence.normalizedTimestamps.map(t => t + ENCODE_RECIPE.commonShiftTicks), 'Executor frame selection/display PTS differs from planner');
  assert.ok(video.every((p: any) => p.pts === p.dts));
  const s = output.streams.find((s: any) => s.codec_type === 'video');
  assert.ok(s.codec_name === 'h264' && s.profile === 'Main' && s.level === 40 && s.field_order === 'progressive' && s.has_b_frames === 0 && s.width === 1920 && s.height === 1080);
  const a = output.streams.find((s: any) => s.codec_type === 'audio');
  assert.ok(a.codec_name === 'aac' && a.channels === 2 && Number(a.sample_rate) === 48000);
  const stableAudio = await probePackets(path.join(directory, 'audio.ts'));
  const audioFields = (p: any[]) => p.map(({ pts, dts, size, data_hash }: any) => ({ pts, dts, size, data_hash }));
  assert.deepEqual(audioFields(audio), audioFields(stableAudio.packets), 'Mux must preserve normalized audio ES and timestamps');
  assert.ok(audio.length > 0 && audio.every((p: any, i: number) => p.pts === p.dts && (!i || p.pts - audio[i - 1].pts === 1920)));
  assert.ok(Math.abs(audio[0].pts - (ENCODE_RECIPE.commonShiftTicks + input.sourceAudioStart * 90000 - 1920)) <= 1);
  const audioAudit = auditExperimentalAudio(raw);
  assert.ok(audioAudit.adts.frames > 0 && !audioAudit.adts.invalidInterior && !audioAudit.adts.trailingBytes);
  assert.ok(audioAudit.pmts.length && audioAudit.pmts.every(p => p.audio.length && p.audio.every(a => a.streamType === 15)));
  assert.deepEqual(Object.keys(audioAudit.adts.kinds), ['{"mpegId":1,"profile":2,"sampleFrequencyIndex":3,"channelConfiguration":2}']);
  const trace = (await execute(ffmpeg(), ['-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'trace_headers', '-an', '-f', 'null', '-'], commandOptions)).stderr;
  await fs.writeFile(path.join(evidenceDirectory, 'trace-validation.log'), trace);
  for (const name of ['Sequence Parameter Set', 'Picture Parameter Set', 'Access Unit Delimiter']) assert.ok(trace.includes(name), `Missing ${name}`);
  const h = parseHrdTrace(trace), schedule = hrdSchedule(h.pictures, h.rate, h.clock, h.cbr);
  assert.equal(schedule.length, video.length);
  const alignment = video[0].dts / 90000 - schedule[0].removal;
  const hrdDtsError = Math.max(...schedule.map((p, i) => Math.abs(p.removal + alignment - video[i].dts / 90000) * 1000));
  assert.ok(hrdDtsError <= 1 / 90);
  const intervals = schedule.slice(1).map((p, i) => p.removal - schedule[i].removal);
  assert.ok(intervals.every(d => d >= input.cadence.minimum.minimumSeconds - 1e-9));
  const model = bufferOccupancy(schedule, schedule.map(p => ({ time: p.removal, bits: p.bits })), h.capacity);
  assert.equal(model.underflows.length, 0); assert.equal(model.overflows.length, 0);
  assert.ok(h.rate <= 20000000 && h.capacity <= 25000000 && h.dpb.refs === 1 && h.dpb.frames <= 4 && h.dpb.reorder === 0);
  // Annex A dimensions/DPB/rate/CPB and AU size limits, independently of declared nominal fps.
  const picMbs = Math.ceil(s.width / 16) * Math.ceil(s.height / 16);
  assert.ok(picMbs <= 8192 && picMbs * h.dpb.frames <= 32768);
  const maxMBPS = picMbs / Math.min(...intervals); assert.ok(maxMBPS <= 245760 + 1e-6);
  assert.equal(h.pictures.filter((p, i) => p.bits / 8 > (i ? 384 * 245760 * intervals[i - 1] / 4 : 384 * picMbs / 4) + 1).length, 0);
  const stats = cadenceStats(video); assert.equal(stats.keys[0].index, 0); assert.ok(stats.gopIntervalsSeconds.every(s => s <= 2.12));
  const index = await buildPcrIndex(file); assert.ok(index && !index.discontinuities && !index.invalidIntervals);
  const gaps = index.points.slice(1).map((p, i) => (p.unwrappedPcr - index.points[i].unwrappedPcr) / 27000);
  assert.ok(Math.max(...gaps) <= 51 && gaps.every(g => g > 0));
  assert.equal(tts.length, index.packetCount * 192); assert.equal(raw.length, index.packetCount * 188);
  let anchor = 0, previous: number | undefined, wraps = 0;
  for (let i = 0; i < index.packetCount; i++) {
    while (anchor + 1 < index.points.length - 1 && index.points[anchor + 1].packet <= i) anchor++;
    const a = index.points[anchor], b = index.points[anchor + 1], den = BigInt(b.packet - a.packet);
    const n = BigInt(a.unwrappedPcr) * den + BigInt(b.unwrappedPcr - a.unwrappedPcr) * BigInt(i - a.packet);
    const expected = Number(((2n * n + den) / (2n * den)) % 4294967296n), actual = tts.readUInt32BE(i * 192);
    assert.ok(Math.min((actual - expected + 4294967296) % 4294967296, (expected - actual + 4294967296) % 4294967296) <= 1);
    assert.ok(tts.subarray(i * 192 + 4, i * 192 + 192).equals(raw.subarray(i * 188, i * 188 + 188)));
    if (previous !== undefined) { const delta = (actual - previous + 4294967296) % 4294967296; assert.ok(delta > 0 && delta < 2700000); if (actual < previous) wraps++; } previous = actual;
  }
  const decode = await execute(ffmpeg(), ['-v', 'error', '-nostdin', '-progress', 'pipe:1', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], commandOptions);
  assert.equal(decode.stderr.trim(), '');
  const decodedFrames = Number([...decode.stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]); assert.equal(decodedFrames, input.cadence.retained.length);
  const decodeSeconds = Number([...decode.stdout.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1]) / 1e6;
  assert.ok(decodeSeconds >= input.seconds - .15);
  const config: ExperimentalMediaConfig = { file, title: 'Prepared diagnostic artifact', mode: 'remux', timeSeek: true, contentPacket: true,
    contentPacketBlockBytes: 5568, pcrLeadMs: 1100, audioTreatment: 'mpeg2-aac-lc', videoTreatment: 'vfr-idr', videoEncoder: 'libx264',
    address: '127.0.0.1', port: 0, udn: `uuid:${randomUUID()}`, durationSeconds: Number(output.format.duration), ssdp: false };
  const logs: unknown[] = [], handler = createExperimentalHandler(config, (category, message, detail) => logs.push({ at: new Date().toISOString(), category, message, detail }), index);
  const server = createServer((req, res) => { void handler(req, res).catch(e => { res.destroy(e); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); config.port = (server.address() as { port: number }).port;
  const uri = experimentalFormat(config).uri, layout = experimentalLayout(tts.length, index.averageBitrate, true, 5568);
  let httpEvidence;
  try {
    const head = await fetch(uri, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(layout.servedBytes));
    assert.equal(head.headers.get('accept-ranges'), 'none'); assert.equal(head.headers.get('contentfeatures.dlna.org'), experimentalFormat(config).features);
    const range = await fetch(uri, { headers: { Range: 'bytes=0-192' } }); assert.equal(range.status, 400); await range.arrayBuffer();
    const request = 'npt=90.123-90.223', slice = timeSeekSlice(index, 5568, request);
    const seek = await fetch(uri, { headers: { 'TimeSeekRange.dlna.org': request } }); assert.equal(seek.status, 200);
    const unwrap = (wire: Buffer, first: number, last: number) => {
      let offset = 0, payload = first;
      while (offset < wire.length) { assert.ok(wire.subarray(offset, offset + 10).equals(Buffer.alloc(10))); const n = wire.readUInt32BE(offset + 10); assert.equal(n, Math.min(5568, last - payload)); assert.ok(wire.subarray(offset + 14, offset + 14 + n).equals(tts.subarray(payload, payload + n))); offset += 14 + n; payload += n; }
      assert.equal(payload, last);
    };
    const seekBytes = Buffer.from(await seek.arrayBuffer()); assert.equal(seekBytes.length, slice.wireBytes); assert.equal(slice.firstPacket % 29, 0); unwrap(seekBytes, slice.firstPacket * 192, slice.endPacket * 192);
    const start = performance.now(), response = await fetch(uri); assert.equal(response.status, 200); assert.ok(response.body);
    let carry: Buffer = Buffer.alloc(0), payload = 0, bytes = 0, next = 4;
    const lead: { position: number; elapsed: number; lead: number }[] = [], hash = createHash('sha256');
    for await (const chunk of response.body) {
      const b = Buffer.from(chunk); bytes += b.length; carry = Buffer.concat([carry, b]);
      while (carry.length >= 14) { const n = carry.readUInt32BE(10); assert.equal(n, Math.min(5568, tts.length - payload)); if (carry.length < 14 + n) break;
        unwrap(carry.subarray(0, 14 + n), payload, payload + n); hash.update(carry.subarray(14, 14 + n)); payload += n; carry = carry.subarray(14 + n); }
      const position = packetTime(index, payload / 192), elapsed = (performance.now() - start) / 1000;
      if (position >= next) { lead.push({ position, elapsed, lead: position - elapsed }); next = position + 1; }
    }
    assert.equal(carry.length, 0); assert.equal(payload, tts.length); assert.equal(bytes, layout.servedBytes);
    assert.equal(hash.digest('hex'), createHash('sha256').update(tts).digest('hex'));
    const steady = lead.filter(p => p.position >= 4 && p.position <= input.seconds - 5);
    assert.ok(steady.length > input.seconds - 15 && steady.every(p => Math.abs(p.lead - 1.1) < .2));
    httpEvidence = { bodyExact: true, bytes, headers: Object.fromEntries(head.headers), protocolInfo: experimentalFormat(config).protocolInfo,
      timeSeek: { request, response: seek.headers.get('timeseekrange.dlna.org'), slice, bodyExact: true }, lead, leadMin: Math.min(...steady.map(p => p.lead)), leadMax: Math.max(...steady.map(p => p.lead)), logs };
  } finally { await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); }); }
  const evidence = { frameCount: video.length, sourceFrames: input.sourceFrames, retained: input.cadence.retained.length, dropped: input.cadence.dropped.length, duplicate: 0,
    retainedPtsExact: true, selectionEvidence, uniformPtsShiftTicks: ENCODE_RECIPE.commonShiftTicks, sourceAudioStart: input.sourceAudioStart, audioPaddingSamples: 1024,
    audioTimelineAndMuxEsExact: true, audioAudit, profile: s, stats, density: pictureWindows(video.map((p: any) => p.pts)),
    hrd: { maxDtsErrorMs: hrdDtsError, minRemovalMs: Math.min(...intervals) * 1000, maxMBPS, picMbs, rate: h.rate, capacity: h.capacity, dpb: h.dpb, cpbMax: model.maxBits, underflow: 0, overflow: 0, violations: 0 },
    pcr: { maxMs: Math.max(...gaps), minMs: Math.min(...gaps) }, tts: { wraps, all32bitWithinOneTick: true, bodyExact: true },
    decodeSeconds, decodedFrames, http: httpEvidence, normativeJpConformance: 'unknown', televisionConfirmation: 'not-tested',
    limitations: ['HRD/CPB is a PC model, not receiver buffer measurement', 'encoded pixels are lossy; exact retained source indices/PTS selection only', 'first bounded sample only'] };
  await fs.writeFile(path.join(evidenceDirectory, 'validation.json'), JSON.stringify(evidence));
  return { passed: true as const, evidence };
}
