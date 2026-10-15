import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function summarize(entries: any[]) {
  const trials = new Map<string, any>();
  for (const entry of entries) {
    if (!entry.trialId) continue;
    const key = `${entry.sessionId}/${entry.trialId}`;
    let trial = trials.get(key);
    if (!trial) {
      trial = { sessionId: entry.sessionId, trialId: entry.trialId, profile: entry.savedProfile,
        startedAt: null, note: null, program: null, observation: null, connections: new Map<string, any>() };
      trials.set(key, trial);
    }
    if (entry.category === "TRIAL_START") {
      trial.startedAt = entry.at; trial.note = entry.detail?.note; trial.program = entry.detail?.program;
    }
    if (entry.category === "TRIAL_OBSERVATION") trial.observation = entry.detail;
    if (!["HTTP_MEDIA", "HTTP_MEDIA_END", "HTTP_MEDIA_PROGRESS", "ERROR", "RANGE"].includes(entry.category) || !entry.connectionId) continue;
    if (!entry.programId) continue;
    let connection = trial.connections.get(entry.connectionId);
    if (!connection) {
      connection = { connectionId: entry.connectionId, socketId: entry.socketId, programId: entry.programId,
        program: entry.programTitle, method: entry.method, startedAt: entry.at,
        sentBytes: 0, elapsedMs: 0, outcome: "end-not-retained", averageMbps: null };
      trial.connections.set(entry.connectionId, connection);
    }
    const detail = entry.detail || {};
    if (entry.category === "HTTP_MEDIA") Object.assign(connection, {
      method: detail.method || connection.method, status: detail.responseStatus,
      packetSize: detail.actualPacketSize, headers: detail.responseHeaders, protocolInfo: detail.protocolInfo,
      targetMbps: detail.targetBitsPerSecond == null ? null : detail.targetBitsPerSecond / 1e6,
      bitrateSource: detail.bitrateSource, range: detail.range
    });
    if (detail.sentBytes !== undefined) {
      connection.sentBytes = detail.sentBytes; connection.elapsedMs = detail.elapsedMs;
      connection.connectionElapsedMs = detail.connectionElapsedMs ?? detail.elapsedMs;
      connection.averageMbps = detail.elapsedMs > 0 ? detail.sentBytes * 8 / detail.elapsedMs / 1000 : null;
    }
    if (detail.outcome) connection.outcome = detail.outcome;
    if (entry.category === "RANGE") { connection.status = 416; connection.outcome = "invalid-range"; }
    if (detail.responseStatus) connection.status = detail.responseStatus;
  }
  return [...trials.values()].map(trial => {
    const connections = [...trial.connections.values()];
    const perProgram = new Map<string, number>();
    for (const c of connections) {
      if (c.method !== "GET") continue;
      const count = (perProgram.get(c.programId) || 0) + 1;
      perProgram.set(c.programId, count); c.getNumber = count;
    }
    const gets = connections.filter(c => c.method === "GET");
    const sentBytes = gets.reduce((sum, c) => sum + c.sentBytes, 0);
    const elapsedMs = gets.reduce((sum, c) => sum + c.elapsedMs, 0);
    return { ...trial, connections, getCount: gets.length,
      regetCount: [...perProgram.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
      sentBytes, connectionElapsedMs: gets.reduce((sum, c) => sum + (c.connectionElapsedMs || 0), 0), transferElapsedMs: elapsedMs,
      averageMbps: elapsedMs > 0 ? sentBytes * 8 / elapsedMs / 1000 : null };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv.slice(2).find(arg => arg !== "--json") ||
    process.env.PT3_LOG_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "diagnostic-logs"));
  const files = readdirSync(directory).filter(name => /^diagnostics\.jsonl(?:\.\d+)?$/.test(name))
    .sort((a, b) => Number(b.split(".")[2] || 0) - Number(a.split(".")[2] || 0));
  const entries: any[] = [];
  for (const file of files) {
    const lines = readFileSync(path.join(directory, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try { entries.push(JSON.parse(line)); }
      catch { console.error(`不完全なJSONLを除外: ${file}:${i + 1}`); }
    });
  }
  const result = summarize(entries);
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log("保持されているログ範囲の集計。再GETは同一試行・番組の2回目以降。映像/音声は人の確認結果のみ。");
    for (const trial of result) {
      console.log(`\n試行 ${trial.trialId} / ${trial.profile} / ${trial.startedAt || "開始ログ保持なし"}`);
      console.log(`対象番組: ${trial.program?.title || [...new Set(trial.connections.map((c: any) => c.program))].join(", ") || "未指定"}`);
      console.log(`GET=${trial.getCount} 再GET=${trial.regetCount} 送信=${trial.sentBytes}bytes 接続時間合計=${trial.connectionElapsedMs}ms 平均=${trial.averageMbps?.toFixed(3) ?? "—"}Mbps`);
      console.log("人の確認:", trial.observation || "未記録", "メモ:", trial.note || "—");
      console.table(trial.connections.map((c: any) => ({
        connectionId: c.connectionId, 番組: c.program, method: c.method, GET順: c.getNumber,
        status: c.status, packet: c.packetSize, 目標Mbps: c.targetMbps?.toFixed(3),
        平均Mbps: c.averageMbps?.toFixed(3), 接続ms: c.connectionElapsedMs, 配信ms: c.elapsedMs, bytes: c.sentBytes, 終了理由: c.outcome
      })));
    }
  }
}
