import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

// Synchronous append preserves event order and leaves no pending writes at shutdown.
export class DiagnosticLog {
  readonly directory: string;
  readonly file: string;
  private bytes = 0;
  constructor(directory: string, readonly maxBytes = 10 * 1024 * 1024, readonly archives = 5) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, "diagnostics.jsonl");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(archives) || archives < 1) {
      throw new Error("Invalid log retention limits");
    }
  }
  assertSeparate(folders: string[]) {
    const canonical = (p: string) => {
      const resolved = path.resolve(p);
      return existsSync(resolved) ? realpathSync(resolved) : resolved;
    };
    const logDir = canonical(this.directory);
    for (const folder of folders) {
      const relative = path.relative(canonical(folder), logDir);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        throw new Error("診断ログ保存先を録画フォルダーの外にしてください");
      }
    }
  }
  open(folders: string[]) {
    this.assertSeparate(folders);
    mkdirSync(this.directory, { recursive: true });
    this.assertSeparate(folders);
    this.bytes = existsSync(this.file) ? statSync(this.file).size : 0;
    if (this.bytes > 0) {
      const descriptor = openSync(this.file, "r");
      const last = Buffer.alloc(1);
      try { readSync(descriptor, last, 0, 1, this.bytes - 1); } finally { closeSync(descriptor); }
      // Preserve a torn last record in an archive instead of joining new JSON to it.
      if (last[0] !== 10 || this.bytes > this.maxBytes) this.rotate();
    }
  }
  private rotate() {
    rmSync(`${this.file}.${this.archives}`, { force: true });
    for (let i = this.archives - 1; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
    this.bytes = 0;
  }
  append(entry: unknown) {
    const line = JSON.stringify(entry) + "\n";
    const length = Buffer.byteLength(line);
    if (length > this.maxBytes) throw new Error("診断ログ1件がファイル容量上限を超えました");
    if (this.bytes + length > this.maxBytes) this.rotate();
    appendFileSync(this.file, line, "utf8");
    this.bytes += length;
  }
}
