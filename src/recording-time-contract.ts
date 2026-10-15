/** Offline comparison of observed declarations, not a DLNA or receiver conformance verdict. */
export interface RecordingTimeContractInput {
  didl?: {duration?: string; size?: string; protocolInfo?: string};
  headers?: Record<string, string | number>;
  status?: number;
  method?: string;
  receivedBytes?: number;
  slice?: {actualStart: number; actualEnd: number; duration: number; startByte: number; wireBytes: number};
  pcr?: {discontinuities: number; invalidIntervals: number};
}
export function durationSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(value);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}
export function inspectRecordingTimeContract(input: RecordingTimeContractInput) {
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([k,v]) => [k.toLowerCase(), String(v)]));
  const issues: string[] = [];
  const time = headers['timeseekrange.dlna.org'];
  const match = time && /^npt=([\d.]+)-([\d.]+)\/([\d.]+) bytes=(\d+)-(\d+)\/(\d+)$/.exec(time);
  const npt = match ? {start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]),
    firstByte: Number(match[4]), lastByte: Number(match[5]), totalBytes: Number(match[6])} : undefined;
  const didlDuration = durationSeconds(input.didl?.duration);
  const length = headers['content-length'] === undefined ? undefined : Number(headers['content-length']);
  if (input.didl?.duration && didlDuration === undefined) issues.push('invalid-didl-duration');
  if (time && !npt) issues.push('unrecognised-time-response-syntax');
  if (npt) {
    if (![npt.start,npt.end,npt.duration,npt.firstByte,npt.lastByte,npt.totalBytes].every(Number.isFinite) ||
      npt.start < 0 || npt.end < npt.start || npt.end > npt.duration || npt.firstByte < 0 ||
      npt.lastByte < npt.firstByte || npt.lastByte >= npt.totalBytes) issues.push('invalid-time-response-bounds');
    if (length !== undefined && length !== npt.lastByte - npt.firstByte + 1) issues.push('time-byte-length-mismatch');
    if (input.didl?.size !== undefined && Number(input.didl.size) !== npt.totalBytes) issues.push('didl-time-total-size-mismatch');
    if (input.slice) {
      const s = input.slice;
      if ([Math.abs(npt.start-s.actualStart),Math.abs(npt.end-s.actualEnd),Math.abs(npt.duration-s.duration)].some(x=>x>0.000501))
        issues.push('pcr-time-response-mismatch');
      if (npt.firstByte !== s.startByte || npt.lastByte !== s.startByte+s.wireBytes-1) issues.push('slice-byte-response-mismatch');
    }
  }
  if (input.receivedBytes !== undefined && input.method !== 'HEAD' && length !== undefined && input.receivedBytes !== length)
    issues.push('incomplete-http-body');
  if (headers['transfer-encoding'] && length !== undefined) issues.push('length-and-transfer-encoding');
  if (input.didl?.protocolInfo && headers['contentfeatures.dlna.org'] && input.didl.protocolInfo.split(':').slice(3).join(':') !== headers['contentfeatures.dlna.org'])
    issues.push('didl-http-features-mismatch');
  if (input.pcr && (input.pcr.discontinuities || input.pcr.invalidIntervals)) issues.push('pcr-timeline-not-continuous');
  return {scope: 'Observed recording contract consistency only; no receiver acceptance or normative conformance assertion.',
    didlDuration, httpDuration: npt?.duration, didlMinusHttpSeconds: didlDuration !== undefined && npt ? didlDuration-npt.duration : undefined,
    npt, issues, receiverDurationDisplay: 'unknown', receiverDecode: 'unknown'};
}
