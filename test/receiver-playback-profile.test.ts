import {test} from 'node:test';
import assert from 'node:assert/strict';
import {receiverPlaybackProfile,automaticReceiverCfr,AutomaticCfrInputAudit} from '../src/receiver-playback-profile.js';
import {selectDualAudio,type DualAudioPermission} from '../src/jit-dual-audio.js';
import {receiverVideoCfrTrial} from '../src/receiver-wmv-cfr-trial.js';
import {snapshotHash,type CapabilitySnapshot} from '../src/playback-shadow.js';
import {jitArguments} from '../src/jit-stream.js';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {acquireCapability} from '../src/playback-shadow-store.js';
const sink='http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T';
const server=['Linux UPnP/1.0 Intel_SDK_for_UPnP_devices/1.2'];
function xml(model='Alternate-series',renderer=false,vendor='TOSHIBA TVS REGZA'){
 return `<root><manufacturer>${vendor}</manufacturer><modelDescription>TOSHIBA LCDTV</modelDescription><modelName>${model}</modelName><deviceType>urn:schemas-upnp-org:device:${renderer?'MediaRenderer':'MediaServer'}:1</deviceType>`+
 (renderer?['ConnectionManager','AVTransport','RenderingControl']:['ConnectionManager','ContentDirectory']).map(s=>`<service><serviceType>urn:schemas-upnp-org:service:${s}:1</serviceType><controlURL>/Media${renderer?'Renderer':'Server'}/${s}/Control</controlURL><SCPDURL>/xml/${s}.xml</SCPDURL></service>`).join('')+'</root>';
}
function cap(model='Alternate-series',renderer=false):CapabilitySnapshot {
 const value=renderer?sink:'';
 return {deviceId:'uuid:synthetic-'+model,remoteIp:'192.0.2.1',controlUrl:'http://192.0.2.1/control',sink:value,sinkHash:snapshotHash(value),acquiredAt:new Date().toISOString(),origin:'current-read',implementation:{version:'upnp-implementation-shadow-v1',family:'intel-upnp-layout',fingerprint:'synthetic-stack'},playbackProfile:receiverPlaybackProfile(xml(model,renderer),server,value)};
}
const fp={path:'synthetic/new-video.wmv',size:123,mtimeMs:100};
function probe(avi=false):any {return {format:{format_name:avi?'avi':'asf',duration:'30'},executionDecoders:avi?['h264','mp3']:['wmv3','wmav2'],streams:[{index:0,codec_type:'video',codec_name:avi?'h264':'wmv3',profile:avi?'High':'Main',pix_fmt:'yuv420p',width:704,height:396,field_order:'progressive',avg_frame_rate:avi?'24000/1001':'0/0',r_frame_rate:'24000/1001'},...[1,2].map(index=>({index,codec_type:'audio',codec_name:avi?'mp3':'wmav2',sample_rate:'48000',channels:2,channel_layout:'stereo',time_base:avi?'1/24000':'1/1000',start_time:'0',duration:'30'}))]};}
test('different model/UDN/IP names infer same compatibility from multiple current technical dimensions',()=>{
 for(const model of ['Representative-model','Other-OLED-77','Future-series-42','unrecognised-model-text']){
  const c=cap(model),p=probe();assert.equal(c.playbackProfile?.id,'regza-intel-server-cfr-v1');
  assert.equal(receiverVideoCfrTrial([],[],c,p,true,fp,[],true),'receiver-wmv3-cfr-30000-1001-trial-v1');
  assert.deepEqual(selectDualAudio([],c,p,'legacy-jp-observed',false,true,fp).plan?.audioPids,[257,258]);
  assert.ok(selectDualAudio([],c,p,'legacy-jp-observed',false,true,{...fp,path:'synthetic/next-video.wmv'}).plan,'No source enrollment');
  assert.equal(receiverVideoCfrTrial([],[],c,p,true,fp,[]),undefined,'Automatic correction requires a current request binding');
  assert.equal(automaticReceiverCfr(c,probe(true),true),'receiver-h264-avi-cfr-30000-1001-trial-v1');
 }
});
test('renderer profile keeps VFR and auto dual, including a model identical to a CFR representative',()=>{
 const c=cap('Representative-model',true);assert.equal(c.playbackProfile?.id,'regza-intel-renderer-vfr-v1');
 assert.equal(automaticReceiverCfr(c,probe(),true),undefined);assert.ok(selectDualAudio([],c,probe(),'legacy-jp-observed',false,true,fp).plan);
});
test('mixed receivers and source formats cannot carry a previous CFR/dual selection into another request',async()=>{
 const cfr=cap('Mixed-profile'),vfr=cap('Other-profile',true),unknown={...cfr,playbackProfile:undefined};
 const cases=[{c:cfr,p:probe(),cfr:true,dual:true},{c:vfr,p:probe(),cfr:false,dual:true},{c:unknown,p:probe(),cfr:false,dual:false},{c:cfr,p:{...probe(),format:{format_name:'mov,mp4',duration:'30'}},cfr:false,dual:false}];
 await Promise.all(Array.from({length:40},async(_,i)=>{const r=cases[i%cases.length];await new Promise(resolve=>setTimeout(resolve,i%3));assert.equal(!!automaticReceiverCfr(r.c,r.p,true),r.cfr);assert.equal(!!selectDualAudio([],r.c,r.p,'legacy-jp-observed',false,true,fp).plan,r.dual);}));
});
test('technical scope rejects observed out-of-scope Complex/30fps and unknown AVI scan without source enrollment',()=>{
 const p=probe();p.streams[0].profile='Complex';p.streams[0].avg_frame_rate='30000/1001';assert.equal(automaticReceiverCfr(cap(),p,true),undefined);assert.equal(selectDualAudio([],cap(),p,'legacy-jp-observed',false,true,fp).plan,undefined);
 const a=probe(true);delete a.streams[0].field_order;assert.equal(automaticReceiverCfr(cap(),a,true),undefined);assert.equal(selectDualAudio([],cap(),a,'legacy-jp-observed',false,true,fp).plan,undefined);
});
test('manufacturer/model/UA or Source advertisement alone does not infer receiver compatibility',()=>{
 assert.equal(receiverPlaybackProfile(xml('Representative-model',false,'Other maker'),server,''),undefined);
 assert.equal(receiverPlaybackProfile(xml(),['Generic UPnP/1.0'],''),undefined);
 assert.equal(receiverPlaybackProfile(xml().replace('TOSHIBA LCDTV','TOSHIBA RECORDER'),server,''),undefined);
 assert.equal(receiverPlaybackProfile(xml().replace('<modelDescription>TOSHIBA LCDTV</modelDescription>',''),server,''),undefined);
 assert.equal(receiverPlaybackProfile(xml().replace('ContentDirectory:1','Other:1'),server,''),undefined);
 assert.equal(receiverPlaybackProfile(xml('Other',true),server,''),undefined);
 assert.equal(receiverPlaybackProfile(xml(),server,sink),undefined);
 const c={...cap(),playbackProfile:undefined};assert.equal(automaticReceiverCfr(c,probe(),true),undefined);assert.equal(selectDualAudio([],c,probe(),'legacy-jp-observed',false,true,fp).plan,undefined);
});
test('unknown client/target, MPEG2, missing binding and unsupported source do not gain dual',()=>{
 const c=cap();assert.equal(selectDualAudio([],c,probe(),'other-target',false,true,fp).plan,undefined);
 assert.equal(selectDualAudio([],c,probe(),'legacy-jp-observed',true,true,fp).plan,undefined);
 assert.equal(selectDualAudio([],c,probe(),'legacy-jp-observed',false,false,fp).plan,undefined);
 for(const mutate of [(p:any)=>p.streams.pop(),(p:any)=>p.streams[2].channels=6,(p:any)=>p.streams[2].codec_name='ac3',(p:any)=>p.streams[0].width=3840]){const p=probe();mutate(p);assert.equal(selectDualAudio([],c,p,'legacy-jp-observed',false,true,fp).plan,undefined);}
});
test('disabled/stale/specific CFR dependencies veto automatic capability',()=>{
 const c=cap();const grant:DualAudioPermission={version:'jit-dual-audio-permission-v1',enabled:false,deviceId:c.deviceId,sinkHash:c.sinkHash,implementationFingerprint:c.implementation!.fingerprint,targetProfile:'legacy-jp-observed',reference:'Explicit local opt-out'};
 assert.equal(selectDualAudio([grant],c,probe(),'legacy-jp-observed',false,true,fp).plan,undefined);
 const scoped={...grant,enabled:true,sourceScope:{version:'jit-dual-audio-source-scope-v1' as const,fingerprints:[fp],h264AviCfrRequired:[fp]}};
 assert.equal(selectDualAudio([scoped],c,probe(true),'legacy-jp-observed',false,true,fp).plan,undefined);
 assert.equal(selectDualAudio([scoped],c,probe(true),'legacy-jp-observed',false,true,{...fp,size:555}).plan,undefined);
 assert.ok(selectDualAudio([scoped],c,probe(),'legacy-jp-observed',false,true,{...fp,path:'synthetic/unrelated.wmv'}).plan);
 assert.equal(receiverVideoCfrTrial([],[{deviceId:c.deviceId,enabled:false,videoEvidence:{fingerprint:fp}} as any],c,probe(),true,fp,[],true),undefined);
});
const frame=(n:number,t:number,i='P')=>`[Parsed_showinfo_0 @ synthetic] n: ${n} pts: ${n} pts_time:${t} fmt:yuv420p s:704x396 i:${i} iskey:0 type:B`;
test('pre-CFR audit refuses reversal, duplicate, >=2s input gap, interlacing, sequence loss and decoder corruption',()=>{
 for(const line of [frame(1,0),frame(1,-.1),frame(1,2),frame(1,.04,'T'),frame(2,.04)]){const audit=new AutomaticCfrInputAudit();audit.push(frame(0,0));assert.throws(()=>audit.push(line));}
 const bad=new AutomaticCfrInputAudit();bad.push('Error while decoding video');assert.throws(()=>bad.push(frame(0,0)));
 const preroll=new AutomaticCfrInputAudit(12);preroll.push('Error while decoding video');preroll.push(frame(0,11));preroll.push(frame(1,11.05));assert.equal(preroll.preRollDecodeWarnings,1);
 const a=new AutomaticCfrInputAudit();a.push('concealing 10 DC, 10 AC, 10 MV errors in P frame');assert.equal(a.concealmentWarnings,1);a.push('[aist#0:1/mp3] [dec:mp3float] Error submitting packet to decoder: Invalid data found when processing input');for(let i=0;i<100;i++)a.push(frame(i,i*1001/24000));assert.equal(a.frames,100);
});
test('automatic CFR uses existing video-only 3003 tick grid, audio arguments remain unchanged',()=>{
 const original=jitArguments('synthetic.wmv',2989,3),corrected=jitArguments('synthetic.wmv',2989,3,undefined,undefined,undefined,{receiverCfr:automaticReceiverCfr(cap(),probe(),true)});
 assert.equal(corrected[corrected.indexOf('-af')+1],original[original.indexOf('-af')+1]);
 assert.match(corrected[corrected.indexOf('-vf')+1],/fps=30000\/1001:round=near/);
});
test('CFR input audit accepts complete video bodies with split prefixes and merged records without losing strict sequence',()=>{
 const a=new AutomaticCfrInputAudit();a.push('[Parsed_showinfo_0 @ synthetic]');a.push(frame(0,0).replace(/^.*?\] /,''));
 a.push('[ashowinfo @ synthetic] n:7 pts:2048 pts_time:0.04 fmt:fltp channels:2 chlayout:stereo rate:48000 nb_samples:2048 '+frame(1,.04)+' '+frame(2,.08));
 assert.equal(a.frames,3);assert.throws(()=>a.push(frame(4,.12)),/sequence/);
 const bad=new AutomaticCfrInputAudit();bad.push(frame(0,0));assert.throws(()=>bad.push(frame(1,2)),/gap/);
 const unknown=new AutomaticCfrInputAudit();assert.throws(()=>unknown.push(frame(0,0).replace('pts_time:0','pts_time:N/A')));
});
test('production CM reader derives profile from current description rather than saved enrollment',async()=>{
 const deviceId='uuid:synthetic-profile-reader';
 const host=createServer((req,res)=>{res.setHeader('Server',server[0]);res.end(req.method==='POST'?'<Envelope><Body><GetProtocolInfoResponse><Sink></Sink></GetProtocolInfoResponse></Body></Envelope>':xml('No-listed-model').replace('<root>',`<root><UDN>${deviceId}</UDN>`));});
 host.listen(0,'127.0.0.1');await once(host,'listening');
 try {const base='http://127.0.0.1:'+(host.address() as any).port;
  const c=await acquireCapability({deviceId,remoteIp:'127.0.0.1',descriptionUrl:base+'/description.xml',controlUrl:base+'/MediaServer/ConnectionManager/Control',allowEmptySink:true},AbortSignal.timeout(3000));
  assert.equal(c.playbackProfile?.id,'regza-intel-server-cfr-v1');assert.equal(c.origin,'current-read');
 }finally{host.closeAllConnections();await new Promise<void>(r=>host.close(()=>r()));}
});
