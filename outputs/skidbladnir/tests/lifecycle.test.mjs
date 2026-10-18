import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/api/server.mjs';
async function start(t,options) {
 const app=createApp(options); await new Promise(r=>app.server.listen(0,'127.0.0.1',r)); t.after(()=>app.close());
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const {token}=await (await fetch(base+'/api/session')).json();
 const post=(path,body={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Skidbladnir-Token':token},body:JSON.stringify(body)});
 return {...app,base,post};
}
const spec={name:'Acceptance worker',template:'node',minutes:5};
test('lifecycle retains evidence and forbids restarting terminated workers',async t=>{
 const app=await start(t);const response=await app.post('/api/workers',spec);assert.equal(response.status,201);
 const worker=await response.json();assert.equal(worker.state,'running');
 for(const [action,state] of [['stop','stopped'],['start','running'],['reboot','running'],['terminate','terminated']]) {
  const res=await app.post(`/api/workers/${worker.id}/${action}`); assert.equal(res.status,200);assert.equal((await res.json()).state,state);
 }
 assert.equal((await app.post(`/api/workers/${worker.id}/start`)).status,400);
 assert.equal(app.snapshot().events.length,5);
});
test('capacity limit remains enforced for concurrent create requests',async t=>{
 const app=await start(t);
 const responses=await Promise.all(Array.from({length:10},()=>app.post('/api/workers',spec)));
 assert.equal(responses.filter(x=>x.status===201).length,5);assert.equal(responses.filter(x=>x.status===409).length,5);
});
test('input validation and same-origin mutation protections',async t=>{
 const app=await start(t);
 for(const bad of [{...spec,minutes:0},{...spec,template:'arbitrary-shell'},{...spec,name:'<script>'},{...spec,minutes:Infinity}]) assert.equal((await app.post('/api/workers',bad)).status,400);
 assert.equal((await fetch(app.base+'/api/workers',{method:'POST',body:'{}'})).status,403);
 assert.equal((await fetch(app.base+'/api/session',{headers:{Origin:'https://unrelated.example'}})).status,403);
 const badHostStatus = await new Promise((resolve,reject)=>{const req=request(app.base+'/api/session',{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
 assert.equal(badHostStatus,403);
 assert.equal((await app.post('/api/workers',{...spec,name:'a'.repeat(9000)})).status,413);
});
test('worker state survives a store restart and expired workers reconcile',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'skidbladnir-')),database=join(dir,'db.sqlite');
 const app=createApp({database});
 app.store.save({id:'sim-old',...spec,state:'stopped',createdAt:new Date(0).toISOString(),expiresAt:new Date(0).toISOString()},'Created before restart');
 await app.close();
 const resumed=createApp({database});
 try {assert.equal(resumed.snapshot().workers.length,1);await resumed.expire();assert.equal(resumed.snapshot().workers[0].state,'terminated');assert.equal(resumed.snapshot().events.length,2);await resumed.expire();assert.equal(resumed.snapshot().events.length,2);}
 finally {await resumed.close();rmSync(dir,{recursive:true,force:true});}
});
test('SSE delivers snapshots and lifecycle updates',async t=>{
 const app=await start(t);const controller=new AbortController();
 const response=await fetch(app.base+'/api/events',{signal:controller.signal});assert.match(response.headers.get('content-type'),/event-stream/);
 const reader=response.body.getReader();const initial=await reader.read();assert.match(new TextDecoder().decode(initial.value),/"mode":"simulation"/);
 await app.post('/api/workers',spec);const update=await reader.read();assert.match(new TextDecoder().decode(update.value),/Acceptance worker/);
 controller.abort();await reader.cancel().catch(()=>{});
});
