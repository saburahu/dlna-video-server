import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ProfileName, stableId } from "./core.js";

import { RecordingMetadata, RecordingMetadataCache, metadataDisplay } from "./recording-metadata.js";
import {discoverLibrary,sourcePathKey,withinSourcePath,type DiscoveryState,type RecordingInventory} from './library-discovery.js';

const execFileAsync = promisify(execFile);

export interface Settings {
  friendlyName: string;
  port: number;
  interfaceAddress: string;
  folders: string[];
  profile: ProfileName;
  udn: string;
  contentPacketProgramIds?: string[];
  timeSeekProgramIds?: string[];
  pcrPacingProgramIds?: string[];
}
export interface Program {
  id: string; filePath: string; title: string; size: number; modified: string;
  duration?: number; width?: number; height?: number; videoCodec?: string;
  audioCodec?: string; bitrate?: number; station?: string; genre?: string;
  originalFilename?: string; displayTitle?: string; metadata?: RecordingMetadata;
  published: boolean; analysis: "pending" | "ok" | "fallback" | "error";
}

const dataDir = path.resolve(process.env.PT3_DATA_DIR || "data");
const settingsFile = path.join(dataDir, "settings.json");
const programsFile = path.join(dataDir, "programs.json");

export let settings: Settings = {
  friendlyName: "PT3 録画サーバー", port: 19090, interfaceAddress: "",
  folders: [], profile: "regza-zp2-buffered", udn: `uuid:${randomUUID()}`
};
export let programs: Program[] = [];
export let systemUpdateId = 1;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return fallback; }
}
export async function loadStore() {
  await fs.mkdir(dataDir, { recursive: true });
  settings = { ...settings, ...(await readJson(settingsFile, {})) };
  programs = await readJson(programsFile, []);
  await refreshMetadata(false);
  await saveSettings();
}
export async function saveSettings() {
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
}
export async function savePrograms() {
  await fs.writeFile(programsFile, JSON.stringify(programs, null, 2));
}

/** Reads only stat and cached JSON; never scans EIT. */
export async function refreshMetadata(persist = true) {
  const cache = new RecordingMetadataCache(path.join(dataDir, "eit-cache"), undefined, settings.folders);
  for (const p of programs) {
    p.originalFilename = path.basename(p.filePath);
    p.metadata = await cache.lookup(p.filePath);
    p.displayTitle = metadataDisplay(p).title;
  }
  systemUpdateId++;
  if (persist) await savePrograms();
  return programs;
}

export async function ffprobeDiagnostic(filePath: string) {
  try {
    const { stdout } = await execFileAsync(process.env.PT3_FFPROBE || "ffprobe", [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    return { available: true, ok: true, data };
  } catch (e: any) {
    return {
      available: e?.code !== "ENOENT", ok: false,
      error: e?.code === "ENOENT" ? "ffprobeが見つかりません" : String(e?.stderr || e?.message || e)
    };
  }
}

let programScanJob:Promise<Program[]>|undefined;
let inventoryObserver:((snapshot:RecordingInventory)=>void)|undefined;
export function observeRecordingInventory(observer:(snapshot:RecordingInventory)=>void){inventoryObserver=observer;}
/** Manual and catalog-triggered scans share one publication job. No parallel
 * mutation of programs during cached metadata refresh; the next cycle catches
 * any inventory that arrived while a job was active. */
export function scanFolders(log: (category: string, message: string, detail?: unknown) => void,inventory?:RecordingInventory) {
  if(programScanJob)return programScanJob;
  programScanJob=scanProgramInventory(log,inventory).finally(()=>{programScanJob=undefined;});
  return programScanJob;
}
async function scanProgramInventory(log: (category: string, message: string, detail?: unknown) => void,inventory?:RecordingInventory) {
  const roots=[...settings.folders];
  if(inventory&&JSON.stringify(inventory.roots)!==JSON.stringify(roots)){log('FILE_WATCH','設定変更前の探索結果を破棄');return programs;}
  const before=JSON.stringify(programs),previousUpdateId=systemUpdateId;
  const existing = new Map(programs.map(p => [sourcePathKey(p.filePath), p]));
  const discovery:DiscoveryState={failedPaths:inventory?.failedPaths??[],linksSkipped:0};
  const next: Program[] = [];
  const observed:RecordingInventory['entries']=[];
  for await (const {file:filePath,stat} of inventory?.entries??discoverLibrary(roots,/\.(ts|m2ts|mts)$/i,discovery)) {
    observed.push({file:filePath,stat});
    const old = existing.get(sourcePathKey(filePath));
    if (old && old.size === stat.size && old.modified === stat.mtime.toISOString()) {
      next.push(old); continue;
    }
    const base: Program = {
      id: old?.id??stableId(filePath), filePath, title: path.basename(filePath).replace(/\.(ts|m2ts|mts)$/i, ""),
      size: stat.size, modified: stat.mtime.toISOString(), published: true, analysis: "pending"
    };
    // Indexing is stat-only; explicit diagnostics/metadata jobs own probing.
    next.push(base);
  }
  const found=new Set(next.map(p=>sourcePathKey(p.filePath)));
  for(const old of programs)if(!found.has(sourcePathKey(old.filePath))&&(inventory&&discovery.failedPaths.length||discovery.failedPaths.some(p=>withinSourcePath(old.filePath,p))))next.push(old);
  for(const failed of discovery.failedPaths)log('FILE_WATCH',`探索エラーのため既存項目を保持: ${failed}`);
  if(JSON.stringify(settings.folders)!==JSON.stringify(roots)){log('FILE_WATCH','探索中に保存先が変更されたため結果を破棄');return programs;}
  inventoryObserver?.({roots,entries:observed,failedPaths:discovery.failedPaths});
  // Background scans reuse catalog stat records. No-change cycles do not
  // re-open every cached EIT document or advance the directory UpdateID.
  if(inventory&&JSON.stringify(next)===before)return programs;
  programs = next;
  await refreshMetadata(false);
  if(JSON.stringify(programs)===before)systemUpdateId=previousUpdateId;
  else await savePrograms();
  log("FILE_WATCH", `スキャン完了: ${programs.length}件`);
  return programs;
}

export async function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch, udn: settings.udn };
  if (patch.profile !== undefined || patch.contentPacketProgramIds !== undefined || patch.timeSeekProgramIds !== undefined || patch.pcrPacingProgramIds !== undefined) systemUpdateId++;
  await saveSettings();
}
