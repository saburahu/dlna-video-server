export function syntheticTs(packetCount = 50_000, packetsPerSecond = 5000) {
  const data = Buffer.alloc(packetCount * 188, 0xff);
  for (let i = 0; i < packetCount; i++) {
    const packet = data.subarray(i * 188, (i + 1) * 188);
    const withPcr = i >= 2 && (i % 100 === 0 || i === 2 || i === packetCount - 1);
    const pid = i === 0 ? 0 : i === 1 ? 257 : withPcr ? 256 : 0x1fff;
    packet[0] = 0x47; packet[1] = (pid >> 8) & 0x1f; packet[2] = pid & 0xff;
    packet[3] = withPcr ? 0x20 : 0x10;
    if (withPcr) {
      packet[4] = 7; packet[5] = 0x10;
      const ticks = Math.round(i * 27_000_000 / packetsPerSecond);
      const base = Math.floor(ticks / 300), ext = ticks % 300;
      packet[6] = Math.floor(base / 2 ** 25) & 255;
      packet[7] = Math.floor(base / 2 ** 17) & 255;
      packet[8] = Math.floor(base / 2 ** 9) & 255;
      packet[9] = Math.floor(base / 2) & 255;
      packet[10] = ((base & 1) << 7) | 0x7e | (ext >> 8); packet[11] = ext & 255;
    }
    if (i < 2) { packet[1] |= 0x40; packet[4] = 0; }
  }
  Buffer.from([0, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 1, 0, 0, 0, 0]).copy(data, 5);
  Buffer.from([2, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, 2, 0xe1, 0x11, 0xf0, 0, 0, 0, 0, 0]).copy(data, 188 + 5);
  return data;
}

// Same packet counts: first half takes 2s, second half 6s. Whole-file average
// pacing would incorrectly take 4s for each half.
export function variablePcrTs() {
  const data = syntheticTs(40_000);
  for (let i = 0; i < 40_000; i++) {
    const packet = data.subarray(i * 188, (i + 1) * 188);
    if (packet[3] !== 0x20) continue;
    const ticks = Math.round((i < 20_000 ? i / 10_000 : 2 + (i - 20_000) * 6 / 20_000) * 27_000_000);
    const base = Math.floor(ticks / 300), ext = ticks % 300;
    packet[6] = Math.floor(base / 2 ** 25) & 255; packet[7] = Math.floor(base / 2 ** 17) & 255;
    packet[8] = Math.floor(base / 2 ** 9) & 255; packet[9] = Math.floor(base / 2) & 255;
    packet[10] = ((base & 1) << 7) | 0x7e | (ext >> 8); packet[11] = ext & 255;
  }
  return data;
}
