import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../apps/api/server.mjs';
import {callTool,configuration,toolList} from '../packages/integration/mcp.mjs';
test('MCP connects to an isolated API and controls only explicitly enabled workers',async t=>{
 const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
 const env={SKIDBLADNIR_URL:`http://127.0.0.1:${app.server.address().port}`};
 assert.equal(toolList(env).length,1);await assert.rejects(callTool('skidbladnir_launch',{},env),/disabled/);
 env.SKIDBLADNIR_ALLOW_CONTROLS='1';
 const result=await callTool('skidbladnir_launch',{name:'Isolated MCP test',template:'general',minutes:5,requestKey:'test-request-123'},env);
 const worker=JSON.parse(result.content[0].text);assert.equal(worker.state,'running');
 await callTool('skidbladnir_control',{workerId:worker.id,action:'terminate'},env);
 const snapshot=JSON.parse((await callTool('skidbladnir_workers',{},env)).content[0].text);assert.equal(snapshot.workers[0].state,'terminated');
 await assert.rejects(callTool('skidbladnir_control',{workerId:'../escape',action:'terminate'},env),/identity/);
});
test('MCP refuses remote origins and credential bearing URLs',()=>{for(const url of ['https://example.com','http://user@127.0.0.1:4380','http://127.0.0.1:4380/path'])assert.throws(()=>configuration({SKIDBLADNIR_URL:url}));});
