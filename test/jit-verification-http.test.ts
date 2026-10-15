import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {jitVerificationRequest} from '../src/jit-verification-http.js';

test('PC verifier pins the requested client and resource without confusing IP prefixes',async t=>{
 const token='fixture-policy-hash',device='uuid:fixture',resource='a'.repeat(32);
 const server=createServer((req,res)=>{
  assert.equal(req.headers['x-pt3-jit-verify'],token);assert.equal(req.headers['x-pt3-jit-device'],device);
  res.setHeader('Content-Type','application/json');
  if(req.url==='/status')res.end(JSON.stringify([
   {client:`192.168.1.42/experimental/catalog-item/${resource}`,marker:'other-client'},
   {client:`192.168.1.4/experimental/catalog-item/${resource}`,marker:'requested-client'}
  ]));
  else{assert.equal(req.url,`/library/jit/${resource}`);res.end('{}');}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const request=jitVerificationRequest(base,{source:'unused',reference:'unused',address:'127.0.0.1',port:0,seconds:1,
  startupSeconds:2.2,logDirectory:'unused',mediaPath:`/library/jit/${resource}`,statusPath:'/status',
  verificationToken:token,verificationDeviceId:device,verificationRemoteIp:'192.168.1.4'});
 assert.equal((await(await request(base+'/api/status')).json()).marker,'requested-client');
 assert.equal((await request(base+'/jit/media.tts')).status,200);
});
