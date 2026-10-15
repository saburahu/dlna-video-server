import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioEndpointEvidence} from '../src/audio-endpoint-evidence.js';
const header='[mp3float @ 00001234] Header missing';
const submission='[aist#0:1/mp3 @ 00001234] [dec:mp3float @ 00001234] Error submitting packet to decoder: Invalid data found when processing input';
function frames(a:AudioEndpointEvidence,from:number,seconds:number){for(let i=0;i<Math.round(seconds*50);i++)a.frame(Math.round((from+i*.02)*48000),960,48000);}
test('recovered MP3 warnings authorize only independently clean terminal PCM, never fatal decoder exits',()=>{
 const a=new AudioEndpointEvidence();frames(a,0,2);a.diagnostic(header);a.diagnostic(submission);frames(a,2.1,6);
 const proof=a.finish(0,400,true)!;assert.equal(proof.headerErrors,1);assert.equal(proof.packetErrors,1);assert.ok(proof.cleanTerminalSeconds>=5);
 for(const code of [1,69,null])assert.throws(()=>a.finish(code,400,true));
 assert.throws(()=>a.finish(0,0,true));assert.throws(()=>a.finish(0,400,false));
});
test('unknown, unpaired, excessive or terminal errors cannot be hidden as normal EOF',()=>{
 for(const diagnostics of [[header],[submission],['Error while decoding stream'],Array.from({length:17},()=>[header,submission]).flat()]){const a=new AudioEndpointEvidence();for(const d of diagnostics)a.diagnostic(d);frames(a,0,10);assert.throws(()=>a.finish(0,500,true));}
 const nearEnd=new AudioEndpointEvidence();frames(nearEnd,0,10);nearEnd.diagnostic(header);nearEnd.diagnostic(submission);frames(nearEnd,10,4.98);assert.throws(()=>nearEnd.finish(0,750,true));
 const interruptedClock=new AudioEndpointEvidence();interruptedClock.diagnostic(header);interruptedClock.diagnostic(submission);frames(interruptedClock,0,10);frames(interruptedClock,11,1);assert.throws(()=>interruptedClock.finish(0,550,true));
 const lateDiagnostic=new AudioEndpointEvidence();frames(lateDiagnostic,0,10);lateDiagnostic.diagnostic(header);lateDiagnostic.diagnostic(submission);assert.throws(()=>lateDiagnostic.finish(0,500,true));
});
test('clean short sources remain valid without inventing a recovery claim',()=>{
 const a=new AudioEndpointEvidence();frames(a,0,1);assert.equal(a.finish(0,50,false),undefined);
});
