import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {contentDirectoryEvents} from '../src/content-directory-events.js';

test('CD events: initial and changed revisions only, renewal, owner isolation, unsubscribe',async t=>{
 let value=7;const events:any[]=[];const manager=contentDirectoryEvents(async()=>value,()=>{},async(url,options)=>{events.push({url,...options});return {};});
 const server=createServer((req,res)=>manager.handle(req,res));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 t.after(async()=>{manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const denied=await fetch(base,{method:'SUBSCRIBE',headers:{CALLBACK:'<http://192.168.0.2/events>',NT:'upnp:event'}});assert.equal(denied.status,412);
 const subscribed=await fetch(base,{method:'SUBSCRIBE',headers:{CALLBACK:'<http://127.0.0.1/events>',NT:'upnp:event',TIMEOUT:'Second-1800'}});assert.equal(subscribed.status,200);const sid=subscribed.headers.get('sid')!;
 await manager.tick();assert.equal(events.length,1);assert.equal(events[0].headers.SEQ,'0');assert.ok(events[0].body.includes('<SystemUpdateID>7</SystemUpdateID>'));
 await manager.tick();assert.equal(events.length,1);value=8;await manager.tick();assert.equal(events.length,2);assert.equal(events[1].headers.SEQ,'1');
 assert.equal((await fetch(base,{method:'SUBSCRIBE',headers:{SID:sid}})).status,200);await manager.tick();assert.equal(events.length,2);
 assert.equal((await fetch(base,{method:'UNSUBSCRIBE',headers:{SID:sid}})).status,200);value=9;await manager.tick();assert.equal(events.length,2);
 assert.equal((await fetch(base,{method:'SUBSCRIBE',headers:{SID:sid}})).status,412);
});
