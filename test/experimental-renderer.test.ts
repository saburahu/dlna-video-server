import test from "node:test";
import assert from "node:assert/strict";
import { experimentalRendererTrial, type RendererAction } from "../src/experimental-renderer.js";
const config = { file: "sampleA.mp4", title: "SampleA & 第3話", durationSeconds: 1798.195, address: "10.254.254.119", port: 19092, udn: "uuid:1111" };
test("renderer check sends only GetTransportInfo and creates no trial", async () => {
  const calls: RendererAction[] = [];
  const result = await experimentalRendererTrial(config, 999, false, async action => { calls.push(action); return "<CurrentTransportState>PLAYING</CurrentTransportState>"; }, async () => { throw Error("must not create trial"); });
  assert.deepEqual(calls, ["GetTransportInfo"]); assert.equal(result.playbackCommandsSent, false);
});
test("renderer run retains original MP4 metadata/URI and only starts when stopped", async () => {
  const calls: RendererAction[] = [];
  const result = await experimentalRendererTrial(config, 999, true, async (action, args) => {
    calls.push(action);
    if (action === "SetAVTransportURI") { assert.equal(args.CurrentURI, "http://10.254.254.119:19092/media/sampleA.mp4"); assert.match(args.CurrentURIMetaData, /http-get:\*:video\/mp4:DLNA.ORG_OP=01;DLNA.ORG_CI=0/); assert.match(args.CurrentURIMetaData, /SampleA &amp; 第3話/); assert.doesNotMatch(args.CurrentURIMetaData, /MPEG_TS_JP|AVC_TS_JP|pacing=/); }
    return "<CurrentTransportState>STOPPED</CurrentTransportState>";
  }, async () => "trial1");
  assert.deepEqual(calls, ["GetTransportInfo", "SetAVTransportURI", "Play"]); assert.equal(result.trialId, "trial1");
});
test("active/unknown renderer state prevents setters and trial creation", async () => {
  for (const state of ["PLAYING", "TRANSITIONING", "PAUSED_PLAYBACK", ""]) {
    const calls: RendererAction[] = [];
    await assert.rejects(experimentalRendererTrial(config, 999, true, async action => { calls.push(action); return `<CurrentTransportState>${state}</CurrentTransportState>`; }, async () => { throw Error("must not create trial"); }), /TV not stopped/);
    assert.deepEqual(calls, ["GetTransportInfo"]);
  }
});
test("SetAVTransportURI rejection does not send Play", async () => {
  const calls: RendererAction[] = [];
  await assert.rejects(experimentalRendererTrial(config, 999, true, async action => { calls.push(action); if (action === "SetAVTransportURI") throw Error("unsupported URI"); return "<CurrentTransportState>NO_MEDIA_PRESENT</CurrentTransportState>"; }, async () => "trial2"), /unsupported URI/);
  assert.deepEqual(calls, ["GetTransportInfo", "SetAVTransportURI"]);
});
