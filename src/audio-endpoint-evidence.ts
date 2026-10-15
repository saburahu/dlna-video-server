import assert from 'node:assert/strict';

/** Evidence for the decoded endpoint, not a declaration that the whole source is sound. */
export class AudioEndpointEvidence {
 private headers=0;private packets=0;private unknown=false;
 private cleanSince:number|undefined;private lastEnd:number|undefined;
 private diagnosticAt:number|undefined;private discontinuities=0;
 diagnostic(line:string){
  if(!/Error|Invalid data|Header missing|corrupt/i.test(line))return;
  this.diagnosticAt=this.lastEnd;this.cleanSince=undefined;
  if(/^\[mp3(?:float)?\s+@[^\]]+\]\s+Header missing\s*$/.test(line))this.headers++;
  else if(/\bmp3(?:float)?\b/.test(line)&&/Error submitting packet to decoder: Invalid data found when processing input\s*$/.test(line))this.packets++;
  else this.unknown=true;
 }
 frame(pts:number,samples:number,rate:number){
  const start=pts/rate,end=(pts+samples)/rate;
  if(this.lastEnd!==undefined&&Math.abs(start-this.lastEnd)>2/rate){this.cleanSince=undefined;this.discontinuities++;}
  this.cleanSince??=start;this.lastEnd=end;
 }
 finish(exitCode:number|null,frames:number,allowRecoveredMp3:boolean){
  assert.equal(exitCode,0,'Audio endpoint decoder did not exit successfully');assert.ok(frames>0,'No decoded audio endpoint');
  const diagnostics=this.headers+this.packets;
  if(!diagnostics&&!this.unknown)return;
  assert.ok(allowRecoveredMp3&&!this.unknown&&this.headers>0&&this.headers===this.packets&&this.headers<=16,'Unverified audio decoder diagnostics');
  const cleanTerminalSeconds=this.lastEnd!-(this.cleanSince??this.lastEnd!);
  assert.ok(cleanTerminalSeconds>=5,'Recovered MP3 endpoint requires at least 5s of contiguous clean terminal PCM');
  return {kind:'recovered-mp3-packets' as const,headerErrors:this.headers,packetErrors:this.packets,cleanTerminalSeconds,lastDiagnosticSeconds:this.diagnosticAt,clockDiscontinuities:this.discontinuities};
 }
}
