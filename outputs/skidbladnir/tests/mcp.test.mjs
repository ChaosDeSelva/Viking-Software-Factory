import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../apps/api/server.mjs';
import {callTool,configuration,toolList,dispatch} from '../packages/integration/mcp.mjs';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const env={SKIDBLADNIR_URL:'http://127.0.0.1:4999',SKIDBLADNIR_ALLOW_CONTROLS:'1'};
// Records what the tool would send; no socket is opened.
function recorder(result={ok:true}){
 const calls=[];
 const request=async(url,init)=>{calls.push({url,...init,signal:undefined});return new Response(JSON.stringify(url.endsWith('/api/session')?{token:'session-token'}:result));};
 return {calls,request};
}
async function listen(t){const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());return {app,origin:`http://127.0.0.1:${app.server.address().port}`};}

test('configuration defaults to the local API and accepts only a bare loopback origin',()=>{
 assert.deepEqual(configuration({}),{origin:'http://127.0.0.1:4380',controls:false});
 assert.deepEqual(configuration({SKIDBLADNIR_URL:'http://127.0.0.1:5001/',SKIDBLADNIR_ALLOW_CONTROLS:'1'}),{origin:'http://127.0.0.1:5001',controls:true});
 assert.equal(configuration({SKIDBLADNIR_ALLOW_CONTROLS:'true'}).controls,false);
 for(const url of ['https://127.0.0.1:4380','http://localhost:4380','http://[::1]:4380','http://user@127.0.0.1:4380','http://:secret@127.0.0.1:4380','http://127.0.0.1:4380/api','http://127.0.0.1:4380/?next=1','http://127.0.0.1:4380/#section'])assert.throws(()=>configuration({SKIDBLADNIR_URL:url}),/local IPv4 HTTP origin/,url);
 assert.throws(()=>configuration({SKIDBLADNIR_URL:'not a url'}));
});

test('tool listing marks the inspection tool read-only and hides controls until enabled',()=>{
 const inspect=toolList({});assert.deepEqual(inspect.map(t=>t.name),['skidbladnir_workers']);
 assert.deepEqual(inspect[0].annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false});
 const all=toolList(env);assert.deepEqual(all.map(t=>t.name),['skidbladnir_workers','skidbladnir_launch','skidbladnir_control','skidbladnir_execute','skidbladnir_collect_artifact','skidbladnir_command']);
 for(const tool of all.slice(1)){assert.deepEqual(tool.annotations,{readOnlyHint:false,destructiveHint:true,openWorldHint:true});assert.equal(tool.inputSchema.additionalProperties,false);assert.ok(tool.inputSchema.required.length>=2);}
});

test('each tool maps to one authenticated local request',async()=>{
 const cases=[
  ['skidbladnir_launch',{name:'w',template:'node',minutes:5,requestKey:'key-1'},'/api/workers',{name:'w',template:'node',minutes:5},'key-1'],
  ['skidbladnir_control',{workerId:'sim-1',action:'stop'},'/api/workers/sim-1/stop',{},undefined],
  ['skidbladnir_execute',{workerId:'aws-1',command:'printf hi',requestKey:'key-2'},'/api/workers/aws-1/commands',{command:'printf hi'},'key-2'],
  ['skidbladnir_collect_artifact',{workerId:'aws-1',path:'out/result.json'},'/api/workers/aws-1/artifacts',{path:'out/result.json'},undefined],
  ['skidbladnir_command',{commandId:'key-2',action:'cancel'},'/api/commands/key-2/cancel',{},undefined],
 ['skidbladnir_launch',{name:'w',template:'node',minutes:5,project:'demo-app',requestKey:'key-3'},'/api/workers',{name:'w',template:'node',minutes:5,project:'demo-app'},'key-3'],
 ];
 for(const [name,args,path,body,key] of cases){
  const {calls,request}=recorder({echo:name});const result=await callTool(name,args,env,request);
  assert.deepEqual(result,{content:[{type:'text',text:JSON.stringify({echo:name})}]});
  assert.equal(calls.length,2);assert.equal(calls[0].url,'http://127.0.0.1:4999/api/session');assert.equal(calls[0].redirect,'error');assert.equal(calls[0].method,undefined);
  assert.equal(calls[1].url,'http://127.0.0.1:4999'+path);assert.equal(calls[1].method,'POST');assert.equal(calls[1].redirect,'error');assert.deepEqual(JSON.parse(calls[1].body),body);
  assert.deepEqual(calls[1].headers,{'Content-Type':'application/json','X-Skidbladnir-Token':'session-token',...(key?{'Idempotency-Key':key}:{})});
 }
 const {calls,request}=recorder({workers:[]});await callTool('skidbladnir_workers',undefined,{SKIDBLADNIR_URL:env.SKIDBLADNIR_URL},request);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:4999/api/snapshot');assert.equal(calls[0].method,'GET');assert.deepEqual(calls[0].headers,{});assert.equal(calls[0].body,undefined);
 const scoped=recorder({workers:[]});await callTool('skidbladnir_workers',{project:'demo-app'},{SKIDBLADNIR_URL:env.SKIDBLADNIR_URL},scoped.request);
 assert.equal(scoped.calls[0].url,'http://127.0.0.1:4999/api/snapshot?project=demo-app');
});

test('arguments are validated before any request is made',async()=>{
 const {calls,request}=recorder();
 for(const [name,args,message] of [
  ['skidbladnir_missing',{},/Unknown tool or controls are disabled/],
  ['skidbladnir_launch',{name:'w',template:'node',minutes:5},/Missing requestKey/],
  ['skidbladnir_launch',{name:'w',template:'node',minutes:5,requestKey:'key-1',extra:1},/Unexpected argument extra/],
  ['skidbladnir_launch',{name:'w',template:'node',minutes:5,requestKey:'key 1'},/Invalid identity/],
  ['skidbladnir_control',{workerId:'a/b',action:'stop'},/Invalid identity/],
  ['skidbladnir_control',{workerId:'sim-1',action:'explode'},/Invalid action/],
  ['skidbladnir_command',{commandId:'../x',action:'refresh'},/Invalid identity/],
  ['skidbladnir_command',{commandId:'key-1',action:'delete'},/Invalid action/],
  ['skidbladnir_control',{workerId:['sim-1'],action:'stop'},/Invalid identity/],
  ['skidbladnir_workers',null,/Arguments must be an object/],
  ['skidbladnir_workers',[],/Arguments must be an object/],
  ['skidbladnir_workers','all',/Arguments must be an object/],
 ])await assert.rejects(callTool(name,args,env,request),message,name+' '+JSON.stringify(args));
 assert.equal(calls.length,0);
 await assert.rejects(callTool('skidbladnir_control',{workerId:'sim-1',action:'stop'},{SKIDBLADNIR_URL:env.SKIDBLADNIR_URL},request),/controls are disabled/);
});

test('failed and oversized responses are reported without their bodies',async()=>{
 await assert.rejects(callTool('skidbladnir_workers',{},env,async()=>new Response('{"error":"internal detail"}',{status:500})),error=>{assert.equal(error.message,'Skidbladnir returned HTTP 500');return true;});
 const megabyte=new Uint8Array(1024*1024);let sent=0;
 const large=async()=>new Response(new ReadableStream({pull(controller){if(sent++<3)controller.enqueue(megabyte);else controller.close();}}));
 await assert.rejects(callTool('skidbladnir_workers',{},env,large),/Result exceeds context limit/);
 await assert.rejects(callTool('skidbladnir_control',{workerId:'sim-1',action:'stop'},env,async()=>new Response('{}',{status:403})),/HTTP 403/);
});

test('dispatch answers the protocol methods and turns tool failures into error results',async t=>{
 const {origin}=await listen(t),local={SKIDBLADNIR_URL:origin};
 assert.deepEqual(await dispatch({method:'initialize'},local),{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'skidbladnir',version:'0.1.0'}});
 assert.deepEqual(await dispatch({method:'ping'},local),{});
 assert.deepEqual((await dispatch({method:'tools/list'},local)).tools.map(x=>x.name),['skidbladnir_workers']);
 const snapshot=await dispatch({method:'tools/call',params:{name:'skidbladnir_workers',arguments:{}}},local);assert.equal(JSON.parse(snapshot.content[0].text).mode,'simulation');assert.equal(snapshot.isError,undefined);
 assert.deepEqual(await dispatch({method:'tools/call',params:{name:'skidbladnir_launch',arguments:{}}},local),{isError:true,content:[{type:'text',text:'Unknown tool or controls are disabled.'}]});
 assert.equal((await dispatch({method:'tools/call'},local)).isError,true);
 await assert.rejects(dispatch({method:'resources/list'},local),/Unsupported method/);
});

test('the stdio server answers one line per request and survives malformed input',async t=>{
 const {origin}=await listen(t);
 const child=spawn(process.execPath,[join(project,'packages/integration/mcp.mjs')],{env:{...process.env,SKIDBLADNIR_URL:origin,SKIDBLADNIR_ALLOW_CONTROLS:''},stdio:['pipe','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
 const exited=new Promise(done=>child.on('exit',code=>done(code)));t.after(()=>child.kill('SIGKILL'));
 child.stdin.end([
  JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'}),
  JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}),
  JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'}),
  JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'skidbladnir_workers',arguments:{}}}),
  'not json',
  JSON.stringify({jsonrpc:'2.0',id:4,method:'ping',padding:'x'.repeat(70000)}),
  JSON.stringify({jsonrpc:'2.0',id:5,method:'resources/list'}),
  'null',
  JSON.stringify({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'skidbladnir_launch',arguments:{}}}),
  JSON.stringify({jsonrpc:'2.0',id:0,method:'ping'}),
 ].join('\n')+'\n');
 assert.equal(await exited,0,errors);
 const replies=output.trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(replies.map(r=>r.id),[1,2,3,null,null,5,null,6,0]);
 for(const reply of replies)assert.equal(reply.jsonrpc,'2.0');
 assert.equal(replies[0].result.serverInfo.name,'skidbladnir');assert.equal(replies[1].result.tools.length,1);
 assert.equal(JSON.parse(replies[2].result.content[0].text).mode,'simulation');
 assert.equal(replies[3].error.code,-32600);assert.equal(replies[4].error.message,'Request too large');
 assert.equal(replies[5].error.message,'Unsupported method');assert.equal(typeof replies[6].error.message,'string');
 assert.equal(replies[7].result.isError,true);assert.deepEqual(replies[8].result,{});
});
