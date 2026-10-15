import { Transform } from "node:stream";
import { timestampTicksForPacket, timestampTicksFromPcrIndex, PcrIndex, Profile } from "./core.js";

export class Tts192Transform extends Transform {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private packetIndex: number;
  private skip: number;
  private remaining: number;

  constructor(packetIndex: number, private readonly bitrate: number, skip: number, length: number,
    private readonly index?: PcrIndex | null, private readonly atsOptions: Pick<Profile,
      "atsOffsetMs" | "atsByteOrder" | "atsClock" | "atsOrigin" | "atsTopBits"> = {
        atsOffsetMs: 0, atsByteOrder: "big-endian", atsClock: "27mhz",
        atsOrigin: "pcr-absolute", atsTopBits: 0
      }) {
    super();
    this.packetIndex = packetIndex;
    this.skip = skip;
    this.remaining = length;
  }

  private emitConverted(packet: Buffer) {
    const converted = Buffer.allocUnsafe(192);
    const baseAts = this.index
      ? timestampTicksFromPcrIndex(this.packetIndex, this.index)
      : timestampTicksForPacket(this.packetIndex, this.bitrate);
    const origin = this.atsOptions.atsOrigin === "zero-based" && this.index?.points.length
      ? this.index.points[0].unwrappedPcr
      : 0;
    const clockDivisor = this.atsOptions.atsClock === "90khz" ? 300 : 1;
    const ticksPerMs = this.atsOptions.atsClock === "90khz" ? 90 : 27_000;
    const clockValue = Math.floor((baseAts - origin) / clockDivisor);
    // DLNA TTS is a full 32-bit counter, not M2TS's CPI + 30-bit ATS.
    // Nonzero atsTopBits remains an explicitly nonconforming historical experiment.
    const modulus = this.atsOptions.atsTopBits === 0 ? 0x100000000 : 0x40000000;
    const ats = ((clockValue + this.atsOptions.atsOffsetMs * ticksPerMs) % modulus + modulus) % modulus;
    const header = (ats | (this.atsOptions.atsTopBits << 30)) >>> 0;
    this.packetIndex++;
    if (this.atsOptions.atsByteOrder === "little-endian") converted.writeUInt32LE(header, 0);
    else converted.writeUInt32BE(header, 0);
    packet.copy(converted, 4);
    if (this.skip >= converted.length) {
      this.skip -= converted.length;
      return;
    }
    const start = this.skip;
    this.skip = 0;
    const take = Math.min(converted.length - start, this.remaining);
    if (take > 0) {
      this.push(converted.subarray(start, start + take));
      this.remaining -= take;
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      let offset = 0;
      while (offset + 188 <= data.length && this.remaining > 0) {
        const packet = data.subarray(offset, offset + 188);
        if (packet[0] !== 0x47) throw new Error(`TS同期バイト不一致: source offset ${this.packetIndex * 188}`);
        this.emitConverted(packet);
        offset += 188;
      }
      this.pending = this.remaining > 0 ? data.subarray(offset) : Buffer.alloc(0);
      callback();
    } catch (e) {
      callback(e as Error);
    }
  }

  override _flush(callback: (error?: Error | null) => void) {
    if (this.remaining > 0) callback(new Error(`TS変換が予定より早く終了しました: 残り${this.remaining}バイト`));
    else callback();
  }
}
