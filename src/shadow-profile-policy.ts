import type { ShadowPolicy } from './playback-shadow.js';

/** Candidate recipes, NOT universal normative DLNA profile definitions. */
export function initialShadowPolicy(): ShadowPolicy {
  const inferred = { status: 'inferred' as const, reference: 'PLAYBACK_DECISION.md / bounded experimental output recipes', scope: 'only a diagnostic candidate without matching DMP + Sink observation' };
  const unknown = { status: 'unknown' as const, reference: 'JP / HD60 profile study', scope: 'complete normative profile not established' };
  const video = { codec: 'h264', profile: 'Main', level: 40, codedWidth: 1920, codedHeight: 1088, bitDepth: 8, chroma: '420', scan: 'progressive',
    maxDpbFrames: 4, maxBitrate: 20e6, maxCpbBits: 25e6,
    timing: { id: 'legacy-main40-shadow', mediaProfile: 'AVC_TS_JP_AAC_T', evidence: 'compatibility-experiment' as const, maxFrameMacroblocks: 8192,
      constraint: { codedWidth: 1920, codedHeight: 1088, maxMBPS: 245760, minimumFrameSeconds: 1 / 172, timebase: 90000 } } };
  return { version: 'shadow-recipes-v1', observations: [], executionCapabilitiesStatus: 'unknown', capabilities: { encoders: [], decoders: [] }, profiles: [
    { id: 'legacy-jp-observed', transport: { evidence: inferred, value: { container: 'mpegts', framing: 'jp-content-packet', mime: 'video/vnd.dlna.mpeg-tts', profileName: 'AVC_TS_JP_AAC_T', seek: 'time' } },
      video: { evidence: inferred, value: video }, audio: { evidence: inferred, value: { codec: 'aac', format: 'mpeg2-aac-lc', maxChannels: 2, sampleRates: [48000], allowAbsent: true } }, conformance: unknown },
    { id: 'hd60-raw-reference', transport: { evidence: inferred, value: { container: 'mpegts', framing: 'tts192', mime: 'video/vnd.dlna.mpeg-tts', profileName: 'AVC_TS_HD_60_AC3_T', seek: 'byte' } },
      video: { evidence: inferred, value: { ...video, scan: 'interlaced', timing: { ...video.timing, mediaProfile: 'AVC_TS_HD_60_AC3_T' } } },
      audio: { evidence: inferred, value: { codec: 'ac3', format: 'ac3', maxChannels: 2, sampleRates: [48000], allowAbsent: false } }, conformance: unknown }
  ] };
}
