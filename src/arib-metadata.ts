import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const TsChar = require('aribts/lib/char') as new (data: Buffer) => {decode(): string};
const Crc = require('aribts/lib/crc32') as {calc(data: Buffer): number};
export const sectionCrc = (data: Buffer) => Crc.calc(data) >>> 0;
export function decodeArib(data: Buffer) {
  try { const text = new TsChar(data).decode(); return {text, suspect: text.includes('\ufffd')}; }
  catch { return {text: null, suspect: true}; }
}
function bcd(b: number) { return (b >> 4) <= 9 && (b & 15) <= 9 ? (b >> 4) * 10 + (b & 15) : null; }
export function durationBcd(data: Buffer): number | null {
  if (data.length !== 3) return null;
  const [h,m,s] = [...data].map(bcd);
  return h === null || m === null || s === null || m > 59 || s > 59 ? null : h * 3600 + m * 60 + s;
}
/** ARIB SI uses JST fields; convert explicitly, independently of the host timezone. */
export function aribDate(data: Buffer): number | null {
  if (data.length !== 5 || data.every(b => b === 255)) return null;
  const [h,m,s] = [...data.subarray(2)].map(bcd);
  if (h === null || m === null || s === null || h > 23 || m > 59 || s > 59) return null;
  return (data.readUInt16BE(0) - 40587) * 86400000 + (h * 3600 + m * 60 + s - 9 * 3600) * 1000;
}
