import { createRequire } from "node:module";
const Packet = createRequire(import.meta.url)("aribts/lib/packet") as new (b: Buffer) => {
  decode(): { PID: number; payload_unit_start_indicator: number; data_byte?: Buffer };
};

/** Offline experiment only. Expected SPS and RBSP bit position come from trace_headers.
 * Preserves every byte except the one identified bit in each identical SPS occurrence. */
export function patchFixedFrameRateTts(input: Buffer, videoPid: number, expectedSps: Buffer, bitPosition: number) {
  if (!input.length || input.length % 192 || expectedSps.length < 2 || (expectedSps[0] & 31) !== 7 || !Number.isSafeInteger(bitPosition) || bitPosition < 8)
    throw new Error("Invalid TTS/SPS patch parameters");
  const rbspOffsets: number[] = [];
  for (let i = 0; i < expectedSps.length; i++) {
    if (i >= 2 && expectedSps[i] === 3 && expectedSps[i - 1] === 0 && expectedSps[i - 2] === 0) continue;
    rbspOffsets.push(i);
  }
  const byte = rbspOffsets[Math.floor(bitPosition / 8)], mask = 1 << (7 - bitPosition % 8);
  if (byte === undefined || !(expectedSps[byte] & mask)) throw new Error("Expected fixed frame rate bit is not one");
  const patchedSps = Buffer.from(expectedSps); patchedSps[byte] &= ~mask;
  const result = replaceSpsByteTts(input, videoPid, expectedSps, patchedSps, byte);
  return { ...result, bitPosition, mask };
}

/** Offline, one-byte SPS diagnostic; refuses length/escape changes and mixed SPS. */
export function replaceSpsByteTts(input: Buffer, videoPid: number, expectedSps: Buffer, patchedSps: Buffer, byte: number) {
  if (!input.length || input.length % 192 || expectedSps.length < 2 || (expectedSps[0] & 31) !== 7 || patchedSps.length !== expectedSps.length || !Number.isInteger(byte) || byte < 1 || byte >= expectedSps.length || expectedSps.some((v,i)=>i!==byte && v!==patchedSps[i]))
    throw new Error("Invalid single-byte SPS replacement");
  // Refuse a change needing a different emulation-prevention layout or NAL length.
  for (let i = 2; i < patchedSps.length; i++) {
    if (patchedSps[i - 2] === 0 && patchedSps[i - 1] === 0 && patchedSps[i] <= 2) throw new Error("Patch requires emulation prevention rewrite");
    if (patchedSps[i - 2] === 0 && patchedSps[i - 1] === 0 && patchedSps[i] === 3 && (i + 1 >= patchedSps.length || patchedSps[i + 1] > 3)) throw new Error("Invalid emulation prevention layout");
  }
  const chunks: Buffer[] = [], spans: { start: number; end: number; file: number }[] = [];
  let length = 0, started = false;
  for (let offset = 0; offset < input.length; offset += 192) {
    if (input[offset + 4] !== 0x47) throw new Error("Invalid TTS sync");
    const p = new Packet(input.subarray(offset + 4, offset + 192)).decode();
    if (p.PID !== videoPid || !p.data_byte?.length) continue;
    let data = p.data_byte, file = offset + 192 - data.length;
    if (p.payload_unit_start_indicator) {
      if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1 || data[3] < 0xe0 || data[3] > 0xef || 9 + data[8] > data.length) throw new Error("Invalid video PES header");
      const skip = 9 + data[8]; data = data.subarray(skip); file += skip; started = true;
    }
    if (!started) throw new Error("Video starts inside PES");
    if (data.length) { spans.push({ start: length, end: length + data.length, file }); chunks.push(data); length += data.length; }
  }
  const es = Buffer.concat(chunks), nals: { start: number; prefix: number }[] = [];
  for (let i = 0; i < es.length - 3;) {
    const prefix = es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1 ? 3 : es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 0 && es[i + 3] === 1 ? 4 : 0;
    if (prefix) { nals.push({ start: i, prefix }); i += prefix + 1; } else i++;
  }
  const offsets: number[] = [];
  for (let i = 0; i < nals.length; i++) {
    const n = nals[i], start = n.start + n.prefix, end = nals[i + 1]?.start ?? es.length;
    if ((es[start] & 31) !== 7) continue;
    if (!es.subarray(start, end).equals(expectedSps)) throw new Error("Unexpected SPS; refusing mixed/unverified parameters");
    const position = start + byte;
    let low = 0, high = spans.length - 1;
    while (low < high) { const mid = (low + high) >>> 1; if (spans[mid].end <= position) low = mid + 1; else high = mid; }
    const span = spans[low]; if (!span || position < span.start || position >= span.end) throw new Error("SPS mapping failed");
    offsets.push(span.file + position - span.start);
  }
  if (!offsets.length) throw new Error("No SPS found");
  const output = Buffer.from(input);
  for (const offset of offsets) output[offset] = patchedSps[byte];
  return { output, offsets, expectedSpsHex: expectedSps.toString("hex"), patchedSpsHex: patchedSps.toString("hex") };
}
