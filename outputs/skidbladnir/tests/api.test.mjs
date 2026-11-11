import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../apps/api/server.mjs';
import {AwsProvider} from '../packages/providers/aws.mjs';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const spec={name:'Api worker',template:'general',minutes:5};
const config={profile:'test',region:'us-west-2',accountId:'123456789012',fleetId:'api-fleet-123',cleanupStack:'test-cleanup',subnetId:'subnet-123',securityGroupIds:['sg-123'],maxWorkers:2,templates:{general:{imageId:'ami-123',instanceType:'t3.small',diskGiB:20}}};
// An in-memory stand-in for the AWS APIs the provider calls. Nothing here reaches a network.
function cloud(){
 const state={instances:[],calls:[],fail:{},ping:'Online',sessions:[],invocation:{Status:'Success',ResponseCode:0,StandardOutputContent:'done',StandardErrorContent:''}};
 const fixed={
  'sts/get-caller-identity':{Account:config.accountId},
  'cloudformation/describe-stacks':{Stacks:[{StackStatus:'CREATE_COMPLETE',Outputs:Object.entries({FleetId:config.fleetId,InstanceProfileName:'profile',ExpiryRuleName:'rule',ExpiryFunctionName:'expiry'}).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]},
  'events/describe-rule':{State:'ENABLED'},
  'lambda/get-function-configuration':{State:'Active',FunctionArn:'arn:test:expiry'},
  'events/list-targets-by-rule':{Targets:[{Arn:'arn:test:expiry'}]},
  'ec2/describe-images':{Images:[{State:'available',Architecture:'x86_64',RootDeviceType:'ebs',RootDeviceName:'/dev/xvda',BlockDeviceMappings:[{DeviceName:'/dev/xvda',Ebs:{VolumeSize:8}}]}]},
  'ec2/describe-instance-types':{InstanceTypes:[{ProcessorInfo:{SupportedArchitectures:['x86_64']}}]},
  'ssm/send-command':{Command:{CommandId:'command-123'}},
 };
 const request=async(service,operation,input={})=>{
  const key=service+'/'+operation;state.calls.push({key,input});
  if(state.fail[key])throw state.fail[key];
  if(key==='ec2/describe-instances')return {Reservations:[{Instances:structuredClone(state.instances)}]};
  if(key==='ec2/run-instances'){const instance={InstanceId:'i-'+(state.instances.length+1),ClientToken:input.ClientToken,State:{Name:'pending'},Tags:input.TagSpecifications[0].Tags};state.instances.push(instance);return {Instances:[structuredClone(instance)]};}
  const change={'ec2/start-instances':'pending','ec2/stop-instances':'stopping','ec2/terminate-instances':'shutting-down'}[key];
  if(change){for(const instance of state.instances)if(input.InstanceIds.includes(instance.InstanceId))instance.State.Name=change;return {};}
  if(key==='ssm/describe-instance-information')return {InstanceInformationList:[{PingStatus:state.ping}]};
  if(key==='ssm/describe-sessions')return {Sessions:structuredClone(state.sessions)};
  if(key==='ssm/start-session')return {SessionId:'session-'+state.calls.length,TokenValue:'secret-stream-token',StreamUrl:'wss://example.test'};
  if(key==='ssm/get-command-invocation')return structuredClone(state.invocation);
  return structuredClone(fixed[key]??{});
 };
 return {state,provider:new AwsProvider(config,request)};
}
async function start(t,options){
 const app=createApp(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const {token}=await(await fetch(base+'/api/session')).json();
 const post=(path,body={},headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Skidbladnir-Token':token,...headers},body:typeof body==='string'?body:JSON.stringify(body)});
 // node:http keeps Host and Sec-Fetch-* exactly as given, which fetch does not promise.
 const raw=(path,headers={},method='GET')=>new Promise((done,reject)=>{const req=request(base+path,{method,headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>done({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();});
 return {...app,base,token,post,raw,get:path=>fetch(base+path)};
}
const settle=()=>new Promise(r=>setImmediate(r));
async function until(check){for(let i=0;i<6000;i++){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,5));}throw Error('Condition was not reached.');}
async function readUntil(reader,pattern){let text='';while(!pattern.test(text)){const {value,done}=await reader.read();if(done)throw Error('Stream ended before '+pattern);text+=new TextDecoder().decode(value);}return text;}

test('a repeated launch key returns the first simulated worker instead of provisioning another',async t=>{
 const app=await start(t);const headers={'Idempotency-Key':'launch-key-0001'};
 const first=await app.post('/api/workers',spec,headers);assert.equal(first.status,201);const worker=await first.json();
 const retry=await app.post('/api/workers',spec,headers);assert.equal(retry.status,200);assert.equal((await retry.json()).id,worker.id);
 assert.equal(app.snapshot().workers.length,1);
 const changed=await app.post('/api/workers',{...spec,minutes:10},headers);assert.equal(changed.status,400);assert.match((await changed.json()).error,/reused/);
 assert.equal((await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0002'})).status,201);
 assert.equal(app.snapshot().workers.length,2);
});

test('pages on another local port cannot call the API but may link to the dashboard',async t=>{
 const app=await start(t);const host=new URL(app.base).host;
 for(const path of ['/api/session','/api/snapshot','/api/events'])assert.equal((await app.raw(path,{Host:host,'Sec-Fetch-Site':'same-site'})).status,403);
 const own=await app.raw('/api/session',{Host:host,'Sec-Fetch-Site':'same-origin',Origin:app.base});assert.equal(own.status,200);assert.equal(JSON.parse(own.body).token,app.token);
 assert.equal((await app.raw('/api/session',{Host:host,'Sec-Fetch-Site':'none'})).status,200);
 assert.equal((await app.raw('/api/session',{Host:host,'Sec-Fetch-Site':'cross-site'})).status,403);
 assert.equal((await app.raw('/missing-page',{Host:host,'Sec-Fetch-Site':'cross-site'})).status,403);
 assert.equal((await app.raw('/missing-page',{Host:host,'Sec-Fetch-Site':'same-site'})).status,404);
 assert.equal(own.headers['access-control-allow-origin'],undefined);
});

test('a request target that is not a valid URL is refused without stopping the server',async t=>{
 const app=await start(t);const {port}=app.server.address();
 // fetch and node:http both normalise the target, so the request line is written by hand.
 for(const target of ['http://[','http://a:b/api/session']){
  const line=await new Promise((done,reject)=>{const socket=connect(port,'127.0.0.1');let text='';socket.on('data',c=>{text+=c;if(text.includes('\r\n\r\n')){socket.destroy();done(text.split('\r\n')[0]);}});socket.on('error',reject);socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);});
  assert.match(line,/^HTTP\/1\.1 400 /,target);
 }
 assert.equal((await app.get('/api/snapshot')).status,200);
});

test('read routes report missing records and simulated readiness',async t=>{
 const app=await start(t);
 assert.equal((await app.get('/api/unknown')).status,404);
 assert.equal((await app.get('/api/workers/none/readiness')).status,404);
 assert.equal((await app.get('/api/artifacts/none')).status,404);
 const worker=await(await app.post('/api/workers',spec)).json();
 assert.deepEqual(await(await app.get(`/api/workers/${worker.id}/readiness`)).json(),{ready:true,state:'running'});
 await app.post(`/api/workers/${worker.id}/stop`);
 assert.deepEqual(await(await app.get(`/api/workers/${worker.id}/readiness`)).json(),{ready:false,state:'stopped'});
 const snapshot=await(await app.get('/api/snapshot')).json();
 assert.equal(snapshot.mode,'simulation');assert.equal(snapshot.maxWorkers,5);assert.deepEqual(snapshot.templates,['node','python','general']);assert.equal(snapshot.accountId,undefined);
});

test('mutations need JSON, a known route and an existing worker',async t=>{
 const app=await start(t);
 const plain=await fetch(app.base+'/api/workers',{method:'POST',headers:{'Content-Type':'text/plain','X-Skidbladnir-Token':app.token},body:'{}'});assert.equal(plain.status,415);
 const wrong=await fetch(app.base+'/api/workers',{method:'POST',headers:{'Content-Type':'application/json','X-Skidbladnir-Token':'0'.repeat(64)},body:'{}'});assert.equal(wrong.status,403);
 assert.equal((await app.post('/api/unknown')).status,404);
 assert.equal((await app.post('/api/workers/none/terminate')).status,404);
 assert.equal((await app.post('/api/workers/none/explode')).status,404);
 assert.equal((await app.post('/api/workers','not json')).status,400);
 assert.equal((await app.post('/api/workers','null')).status,400);
 const deleted=await fetch(app.base+'/api/workers',{method:'DELETE',headers:{'Content-Type':'application/json','X-Skidbladnir-Token':app.token}});assert.equal(deleted.status,404);
 assert.equal(app.snapshot().workers.length,0);
});

test('simulation refuses terminals, artifacts and remote commands',async t=>{
 const app=await start(t);const worker=await(await app.post('/api/workers',spec)).json();
 for(const [path,message] of [[`/api/workers/${worker.id}/terminals`,/Terminals require AWS/],[`/api/workers/${worker.id}/artifacts`,/requires AWS/],[`/api/workers/${worker.id}/commands`,/requires an AWS provider/],['/api/commands/none/refresh',/No confirmed remote command identity/]]){
  const response=await app.post(path,{path:'a',command:'true'},{'Idempotency-Key':'command-key-1'});assert.equal(response.status,400);assert.match((await response.json()).error,message);
 }
 assert.deepEqual(app.snapshot().commands,[]);assert.deepEqual(app.snapshot().terminals,[]);
});

test('static files are served only from the built dashboard',async t=>{
 const dist=join(project,'dist'),created=!existsSync(dist);mkdirSync(dist,{recursive:true});
 const stamp='skidbladnir-test-'+process.pid,files=[stamp+'.html',stamp+'.bin'];
 for(const file of files)writeFileSync(join(dist,file),'probe '+file);
 t.after(()=>{for(const file of files)rmSync(join(dist,file),{force:true});if(created)rmSync(dist,{recursive:true,force:true});});
 const app=await start(t);
 const page=await app.get('/'+files[0]);assert.equal(page.status,200);assert.equal(page.headers.get('content-type'),'text/html');assert.equal(await page.text(),'probe '+files[0]);
 assert.equal(page.headers.get('x-content-type-options'),'nosniff');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 const binary=await app.get('/'+files[1]);assert.equal(binary.headers.get('content-type'),'application/octet-stream');
 const head=await fetch(app.base+'/'+files[0],{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 assert.equal((await app.get('/'+stamp+'-absent.js')).status,404);
 assert.equal((await fetch(app.base+'/',{method:'POST'})).status,405);
 assert.equal((await app.raw('/%E0%A4%A')).status,400);
 const escape=await app.raw('/..%2f..%2fpackage.json');assert.equal(escape.status,403);assert.doesNotMatch(escape.body,/skidbladnir/);
 const index=await app.get('/');assert.ok([200,404].includes(index.status));
 if(index.status===404)assert.match((await index.json()).error,/npm run build/);
});

test('the simulator timer expires workers and keeps event streams alive',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const app=await start(t);
 app.store.save({id:'sim-due',...spec,state:'running',createdAt:new Date(0).toISOString(),expiresAt:new Date(0).toISOString()},'Created in the past');
 const live=await(await app.post('/api/workers',spec)).json();
 const controller=new AbortController(),response=await fetch(app.base+'/api/events',{signal:controller.signal}),reader=response.body.getReader();
 await readUntil(reader,/event: snapshot/);
 // Two ticks in one turn: the second must be skipped while the first pass is still running.
 t.mock.timers.tick(1000);t.mock.timers.tick(1000);
 await until(()=>app.store.get('sim-due').state==='terminated');
 assert.equal(app.store.events().filter(e=>e.workerId==='sim-due'&&/expired/.test(e.message)).length,1);
 assert.equal(app.store.get(live.id).state,'running');
 assert.match(await readUntil(reader,/"state":"terminated"/),/sim-due/);
 await settle();t.mock.timers.tick(1000);await app.expire();
 assert.equal(app.store.events().filter(e=>e.workerId==='sim-due').length,2);
 t.mock.timers.tick(15000);assert.match(await readUntil(reader,/: heartbeat/),/: heartbeat\n\n/);
 controller.abort();await reader.cancel().catch(()=>{});
});

test('a failing simulated expiry pass does not stop later timer passes',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const app=await start(t),past=new Date(0).toISOString();
 // The simulator cannot terminate a worker in a state it never produces, so this pass rejects.
 app.store.save({id:'sim-stuck',...spec,state:'failed',createdAt:past,expiresAt:past},'Synthetic stuck worker');
 await assert.rejects(app.expire(),/unavailable in the current state/);
 t.mock.timers.tick(1000);await settle();await settle();
 app.store.save({id:'sim-stuck',...spec,state:'running',createdAt:past,expiresAt:past},'Synthetic recovery');
 t.mock.timers.tick(1000);
 await until(()=>app.store.get('sim-stuck').state==='terminated');
});

test('AWS workers are launched, reconciled, controlled and evidenced through the API',async t=>{
 const {state,provider}=cloud();const app=await start(t,{provider});
 assert.equal((await app.post('/api/workers',spec)).status,400);
 assert.equal((await app.post('/api/workers',{...spec,template:'node'},{'Idempotency-Key':'template-key-1'})).status,400);
 assert.equal(app.snapshot().workers.length,0);
 const launched=await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0001'});assert.equal(launched.status,201);
 const worker=await launched.json();assert.equal(worker.state,'starting');assert.equal(worker.instanceId,'i-1');assert.equal(worker.requestKey,'launch-key-0001');
 assert.equal((await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0001'})).status,200);
 assert.equal(state.calls.filter(c=>c.key==='ec2/run-instances').length,1);
 const snapshot=await(await app.get('/api/snapshot')).json();
 assert.equal(snapshot.mode,'aws');assert.equal(snapshot.accountId,config.accountId);assert.equal(snapshot.region,config.region);assert.deepEqual(snapshot.templates,['general']);assert.equal(snapshot.maxWorkers,2);
 assert.deepEqual(await(await app.get(`/api/workers/${worker.id}/readiness`)).json(),{ready:false,state:'starting'});
 state.instances[0].State.Name='running';
 assert.deepEqual(await(await app.get(`/api/workers/${worker.id}/readiness`)).json(),{ready:true,state:'running'});
 await app.expire();assert.equal(app.store.get(worker.id).state,'running');assert.equal(app.store.events()[0].message,'AWS state reconciled.');
 const before=app.store.events().length;await app.expire();assert.equal(app.store.events().length,before);

 const commands=`/api/workers/${worker.id}/commands`;
 assert.equal((await app.post(commands,{command:'printf hi'})).status,400);
 assert.equal((await app.post('/api/workers/none/commands',{command:'printf hi'},{'Idempotency-Key':'command-key-1'})).status,404);
 const sent=await app.post(commands,{command:'printf hi'},{'Idempotency-Key':'command-key-1'});assert.equal(sent.status,202);
 const record=await sent.json();assert.equal(record.commandId,'command-123');assert.equal(record.status,'Pending');
 assert.equal((await app.post(commands,{command:'printf hi'},{'Idempotency-Key':'command-key-1'})).status,200);
 assert.equal((await app.post(commands,{command:'printf other'},{'Idempotency-Key':'command-key-1'})).status,400);
 assert.equal(state.calls.filter(c=>c.key==='ssm/send-command').length,1);
 const refreshed=await(await app.post('/api/commands/command-key-1/refresh')).json();assert.equal(refreshed.status,'Success');assert.equal(refreshed.stdout,'done');
 const cancelled=await(await app.post('/api/commands/command-key-1/cancel')).json();assert.equal(cancelled.status,'Cancelling');
 assert.deepEqual(state.calls.at(-1).input,{CommandId:'command-123',InstanceIds:['i-1']});
 assert.equal((await app.post('/api/commands/unknown-key-1/refresh')).status,400);

 const terminals=`/api/workers/${worker.id}/terminals`;
 assert.equal((await app.post('/api/workers/none/terminals')).status,400);
 const opened=await(await app.post(terminals)).json();assert.equal(opened.connection.TokenValue,'secret-stream-token');assert.equal(opened.region,'us-west-2');
 state.sessions=[{SessionId:opened.record.sessionId,Target:'i-1'}];
 const resumed=await(await app.post(`${terminals}/${opened.record.id}/resume`)).json();assert.equal(resumed.record.id,opened.record.id);assert.equal(resumed.record.previousSessionId,opened.record.sessionId);
 assert.equal((await app.post(`${terminals}/unknown/resume`)).status,400);
 state.sessions=[];
 const closed=await(await app.post(`${terminals}/${opened.record.id}/close`)).json();assert.equal(closed.record.status,'closed');
 assert.equal(app.snapshot().terminals.length,1);assert.equal(app.snapshot().terminals[0].status,'closed');
 assert.equal(JSON.stringify(app.snapshot()).includes('secret-stream-token'),false);

 const bytes=Buffer.from('evidence');
 state.invocation={Status:'Success',ResponseCode:0,StandardOutputContent:JSON.stringify({data:bytes.toString('base64'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})};
 assert.equal((await app.post('/api/workers/none/artifacts',{path:'out.txt'})).status,400);
 const collected=await app.post(`/api/workers/${worker.id}/artifacts`,{path:'out.txt'});assert.equal(collected.status,201);
 const metadata=await collected.json();assert.equal(metadata.data,undefined);assert.equal(metadata.bytes,8);
 assert.equal(await(await app.get('/api/artifacts/'+metadata.id)).text(),'evidence');

 for(const [action,next] of [['stop','stopping'],['terminate','terminating']]){const response=await app.post(`/api/workers/${worker.id}/${action}`);assert.equal(response.status,200);assert.equal((await response.json()).state,next);}
 assert.match(app.store.events()[0].message,/^AWS terminate requested/);
 state.instances[0].State.Name='terminated';await app.expire();assert.equal(app.store.get(worker.id).state,'terminated');
});

test('AWS launch failures are recorded as failed or unknown and capacity stays bounded',async t=>{
 const {state,provider}=cloud();const app=await start(t,{provider});
 state.fail['events/describe-rule']=Error('rule lookup failed');
 assert.equal((await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0001'})).status,400);
 assert.equal(app.snapshot().workers[0].state,'failed');assert.match(app.snapshot().events[0].message,/preflight failed/);
 assert.equal(state.calls.some(c=>c.key==='ec2/run-instances'),false);
 delete state.fail['events/describe-rule'];state.fail['ec2/run-instances']=Error('response lost');
 assert.equal((await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0002'})).status,400);
 assert.equal(app.snapshot().workers[0].state,'unknown');assert.match(app.snapshot().events[0].message,/outcome unknown/);
 delete state.fail['ec2/run-instances'];
 assert.equal((await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0003'})).status,201);
 const full=await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0004'});assert.equal(full.status,409);
 assert.equal(state.calls.filter(c=>c.key==='ec2/run-instances').length,2);
});

test('a failed command submission is recorded as unknown and never resent',async t=>{
 const {state,provider}=cloud();const app=await start(t,{provider});
 const worker=await(await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0001'})).json();state.instances[0].State.Name='running';
 state.fail['ssm/send-command']=Error('response lost');
 const failed=await app.post(`/api/workers/${worker.id}/commands`,{command:'printf hi'},{'Idempotency-Key':'command-key-1'});assert.equal(failed.status,400);
 assert.equal(app.snapshot().commands[0].status,'Unknown');assert.match(app.snapshot().events[0].message,/outcome unknown/);
 delete state.fail['ssm/send-command'];
 const retry=await app.post(`/api/workers/${worker.id}/commands`,{command:'printf hi'},{'Idempotency-Key':'command-key-1'});assert.equal(retry.status,200);assert.equal((await retry.json()).status,'Unknown');
 assert.equal(state.calls.filter(c=>c.key==='ssm/send-command').length,1);
 assert.equal((await app.post('/api/commands/command-key-1/refresh')).status,400);
});

test('AWS reconciliation runs on the timer and surfaces then clears provider errors',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const {state,provider}=cloud();const app=await start(t,{provider});
 await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0001'});state.instances[0].State.Name='running';
 t.mock.timers.tick(15000);await until(()=>app.snapshot().workers[0].state==='running');
 state.fail['sts/get-caller-identity']=Error('credentials expired');
 const failed=await(await app.get('/api/snapshot')).json();assert.equal(failed.providerError,'credentials expired');assert.equal(failed.workers[0].state,'running');
 delete state.fail['sts/get-caller-identity'];
 const recovered=await(await app.get('/api/snapshot')).json();assert.equal(recovered.providerError,null);
 const readiness=await app.get('/api/workers/none/readiness');assert.equal(readiness.status,404);
 state.fail['sts/get-caller-identity']=Error('credentials expired');
 const refused=await app.get(`/api/workers/${app.snapshot().workers[0].id}/readiness`);assert.equal(refused.status,400);assert.deepEqual(await refused.json(),{error:'credentials expired'});
});

test('an event stream whose first snapshot fails still receives later updates',async t=>{
 const {provider}=cloud();let broken=false,thrown=0;const templates=provider.config.templates;
 Object.defineProperty(provider.config,'templates',{get(){if(broken){thrown++;throw Error('snapshot unavailable');}return templates;}});
 const app=await start(t,{provider});broken=true;
 const controller=new AbortController(),pending=fetch(app.base+'/api/events',{signal:controller.signal});
 await until(()=>thrown===1);
 const failed=await app.get('/api/snapshot');assert.equal(failed.status,400);assert.deepEqual(await failed.json(),{error:'snapshot unavailable'});
 broken=false;assert.equal((await app.post('/api/workers',spec,{'Idempotency-Key':'launch-key-0001'})).status,201);
 const response=await pending;assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);
 const reader=response.body.getReader();assert.match(await readUntil(reader,/Api worker/),/event: snapshot/);
 controller.abort();await reader.cancel().catch(()=>{});
});

test('a database bound to one provider refuses another',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'skid-bind-')),database=join(dir,'db.sqlite');
 try{const app=createApp({database});await app.close();
  assert.throws(()=>createApp({database,provider:cloud().provider}),/another provider/);
  const again=createApp({database});assert.equal(again.snapshot().mode,'simulation');await again.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

// The command-line entry point is run as a child so its port and data directory stay isolated.
async function launch(t,env){
 const dir=mkdtempSync(join(tmpdir(),'skid-main-'));
 const child=spawn(process.execPath,[join(project,'apps/api/server.mjs')],{env:{...process.env,PORT:'0',SKIDBLADNIR_DATA_DIR:join(dir,'data'),...env},stdio:['ignore','pipe','pipe']});
 const exited=new Promise(done=>child.on('exit',(code,signal)=>done({code,signal})));
 t.after(async()=>{child.kill('SIGKILL');await exited;rmSync(dir,{recursive:true,force:true});});
 let output='';const line=await new Promise((done,reject)=>{child.stdout.on('data',c=>{output+=c;if(output.includes('\n'))done(output.trim());});child.on('exit',()=>reject(Error('Server exited before listening.')));});
 return {child,exited,line,data:join(dir,'data')};
}
test('the server entry point serves a private simulation database and stops on SIGTERM',async t=>{
 const {child,exited,line,data}=await launch(t,{SKIDBLADNIR_AWS_CONFIG:''});
 const origin=line.match(/^Skidbladnir simulation: (http:\/\/127\.0\.0\.1:\d+)$/)[1];
 assert.equal(typeof (await(await fetch(origin+'/api/session')).json()).token,'string');
 assert.equal(statSync(data).mode&0o777,0o700);assert.ok(existsSync(join(data,'skidbladnir.sqlite')));
 child.kill('SIGTERM');assert.deepEqual(await exited,{code:0,signal:null});
});
test('the server entry point keeps each AWS fleet in its own database',async t=>{
 const {child,exited,line,data}=await launch(t,{SKIDBLADNIR_AWS_CONFIG:join(project,'docs/aws.example.json')});
 assert.match(line,/^Skidbladnir aws: http:\/\/127\.0\.0\.1:\d+$/);
 assert.ok(existsSync(join(data,'aws-your-isolated-fleet.sqlite')));assert.equal(existsSync(join(data,'skidbladnir.sqlite')),false);
 child.kill('SIGINT');assert.deepEqual(await exited,{code:0,signal:null});
});
