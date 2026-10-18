import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createApp} from '../apps/api/server.mjs';
import {callTool} from '../packages/integration/mcp.mjs';
test('artifact downloads survive API restart and expired workers without exposing session tokens',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'skid-evidence-')),database=join(dir,'state.db');
 const data=Buffer.from('retained result'),payload={data:data.toString('base64'),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),id:'untrusted-id',workerId:'other'};
 const provider={mode:'aws',config:{accountId:'test',region:'test',fleetId:'test',templates:{general:{}}},inspect:async w=>({...w,ownershipConfirmed:true}),execute:async()=>({commandId:'c'}),command:async()=>({status:'Success',exitCode:0,stdout:JSON.stringify(payload)}),request:async()=>({SessionId:'remote-session',TokenValue:'secret-test-token',StreamUrl:'wss://example.test'})};
 let app=createApp({database,provider});
 const start=async()=>{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${app.server.address().port}`;};
 try{let origin=await start();app.store.save({id:'w',instanceId:'i',state:'running'},'Synthetic');
 const {token}=await(await fetch(origin+'/api/session')).json();
 const headers={'Content-Type':'application/json','X-Skidbladnir-Token':token};
 const denied=await fetch(origin+'/api/workers/w/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
 const session=await(await fetch(origin+'/api/workers/w/terminals',{method:'POST',headers,body:'{}'})).json();assert.equal(session.connection.TokenValue,'secret-test-token');
 const collected=JSON.parse((await callTool('skidbladnir_collect_artifact',{workerId:'w',path:'result.txt'},{SKIDBLADNIR_URL:origin,SKIDBLADNIR_ALLOW_CONTROLS:'1'})).content[0].text);
 assert.notEqual(collected.id,'untrusted-id');assert.equal(collected.workerId,'w');assert.equal(JSON.stringify(app.snapshot()).includes('secret-test-token'),false);assert.equal(app.snapshot().artifacts[0].data,undefined);
 app.store.save({id:'w',instanceId:'i',state:'terminated'},'Expired');await app.close();app=createApp({database,provider});origin=await start();
 const result=await fetch(origin+'/api/artifacts/'+collected.id);assert.equal(result.status,200);assert.equal(await result.text(),'retained result');assert.match(result.headers.get('content-disposition'),/attachment/);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
