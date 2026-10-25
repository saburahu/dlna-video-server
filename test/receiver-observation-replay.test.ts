import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {receiverPlaybackProfile} from '../src/receiver-playback-profile.js';
import {requestFamilyFeatures,classifyClientFamily,endpointFamilyFeatures} from '../src/client-family.js';
import {acquireCapability} from '../src/playback-shadow-store.js';
const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/receiver-observations.json',import.meta.url),'utf8'));
const raw=process.env.PT3_RECEIVER_OBSERVATIONS;
const batches=[{name:'redacted observed',rows:fixture},...(raw?[{name:'unaltered private observation replay',rows:JSON.parse(await fs.readFile(raw,'utf8'))}]:[])];
for(const batch of batches)for(const r of batch.rows)test(`${batch.name}: ${r.id}`,async()=>{
 assert.equal(receiverPlaybackProfile(r.descriptionXml,[r.server],r.sink)?.id??null,r.expected);
 // Model and individual identity cannot select the profile. Keep all technical
 // fields and remove/change identity labels in the captured XML.
 const changed=r.descriptionXml.replace(/<(\w+:)?modelName>[^<]*<\/(\w+:)?modelName>/g,'<modelName>Unknown alternative model</modelName>').replace(/uuid:[\w-]+/g,'uuid:unregistered-alternative');
 assert.equal(receiverPlaybackProfile(changed,[r.server],r.sink)?.id??null,r.expected);
 if(!r.expected)return;
 const requests=requestFamilyFeatures(r.request.headers,r.request.xml),endpoint=endpointFamilyFeatures(r.descriptionXml,[r.server]);
 assert.ok(requests.some(s=>s.dimension==='request-stack'&&s.family==='intel-upnp-layout'));
 assert.equal(classifyClientFamily([...endpoint.signals,...requests]).family,'intel-upnp-layout');
 // Replay exact description and SOAP bytes through the production reader.
 const udn=/<UDN>([^<]+)<\/UDN>/.exec(r.descriptionXml)?.[1];assert.ok(udn);
 const control=/<controlURL>([^<]*ConnectionManager\/Control)<\/controlURL>/.exec(r.descriptionXml)?.[1];assert.ok(control);
 const host=createServer((req,res)=>{res.setHeader('Server',r.server);res.end(req.method==='POST'?r.soapXml:r.descriptionXml);});
 host.listen(0,'127.0.0.1');await once(host,'listening');
 try {const base='http://127.0.0.1:'+(host.address() as any).port;
  const cap=await acquireCapability({deviceId:udn,remoteIp:'127.0.0.1',descriptionUrl:base+'/description.xml',controlUrl:base+control,allowEmptySink:true},AbortSignal.timeout(5000));
  assert.equal(cap.playbackProfile?.id,r.expected);assert.equal(cap.sink,r.sink);
 }finally{host.closeAllConnections();await new Promise<void>(resolve=>host.close(()=>resolve()));}
});
