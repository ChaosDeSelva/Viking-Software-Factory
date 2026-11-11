import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {terminal,artifact,artifactCommand} from '../packages/providers/session.mjs';
const worker={id:'w',instanceId:'i-1'};
const record={id:'local',workerId:'w',instanceId:'i-1',sessionId:'remote-1',status:'active',createdAt:'2026-01-01T00:00:00.000Z'};
const connection={SessionId:'remote-2',TokenValue:'private-token',StreamUrl:'wss://example.test'};
function provider({state='running',owned=true,sessions=[],start=async()=>connection}={}){
 const calls=[];
 return {calls,config:{region:'us-west-2',profile:'test'},inspect:async w=>({...w,ownershipConfirmed:owned,state}),request:async(service,operation,input)=>{calls.push({operation,input});if(operation==='describe-sessions')return sessions===null?{}:{Sessions:sessions};if(operation==='start-session')return start(calls.filter(c=>c.operation==='start-session').length);return {};}};
}
// Waits are on a mocked clock, so no test depends on how busy the machine is.
async function drive(t,promise,step){
 let settled=false;const done=promise.finally(()=>{settled=true;});done.catch(()=>{});
 while(!settled){await new Promise(r=>setImmediate(r));if(!settled)t.mock.timers.tick(step);}
 return done;
}
const notConnected=()=>Error('AWS ssm start-session failed',{cause:{name:'TargetNotConnected'}});
const payload=text=>{const bytes=Buffer.from(text);return {data:bytes.toString('base64'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};};
const collector=results=>{let polls=0;return {polls:()=>polls,execute:async(w,command)=>({commandId:'c',instanceId:'i-1',command}),command:async()=>{const next=results[Math.min(polls++,results.length-1)];if(next instanceof Error)throw next;return next;}};};

test('terminals require a confirmed running worker, except that a stopped worker may be closed',async()=>{
 for(const action of ['start','resume','close']){const p=provider({owned:false});await assert.rejects(terminal(p,worker,record,action),/running owned worker/);assert.equal(p.calls.length,0);}
 for(const action of ['start','resume'])await assert.rejects(terminal(provider({state:'stopped'}),worker,record,action),/running owned worker/);
 const stopped=provider({state:'stopped',sessions:[{SessionId:'remote-1',Target:'i-1'}]});
 assert.deepEqual(await terminal(stopped,worker,record,'close'),{record:{...record,status:'closed'}});
 assert.deepEqual(stopped.calls.map(c=>c.operation),['describe-sessions','terminate-session']);assert.deepEqual(stopped.calls[1].input,{SessionId:'remote-1'});
 assert.deepEqual(stopped.calls[0].input,{State:'Active',Filters:[{key:'SessionId',value:'remote-1'}]});
});

test('resume and close refuse records of another worker, instance or session target',async()=>{
 for(const action of ['resume','close']){
  for(const bad of [undefined,{...record,workerId:'other'},{...record,instanceId:'i-other'}]){const p=provider();await assert.rejects(terminal(p,worker,bad,action),/ownership mismatch/);assert.equal(p.calls.length,0);}
  const foreign=provider({sessions:[{SessionId:'remote-1',Target:'i-other'}]});
  await assert.rejects(terminal(foreign,worker,record,action),/ownership mismatch/);assert.deepEqual(foreign.calls.map(c=>c.operation),['describe-sessions']);
 }
});

test('resume opens a fresh session and ends the old one only while it is still active',async()=>{
 for(const sessions of [[],null,[{SessionId:'unrelated',Target:'i-other'}]]){
  const p=provider({sessions});const result=await terminal(p,worker,record,'resume');
  assert.deepEqual(p.calls.map(c=>c.operation),['describe-sessions','start-session']);
  assert.equal(result.record.id,'local');assert.equal(result.record.sessionId,'remote-2');assert.equal(result.record.previousSessionId,'remote-1');assert.equal(result.record.createdAt,record.createdAt);assert.equal(result.record.status,'active');
  assert.deepEqual(result.connection,connection);assert.equal(result.region,'us-west-2');assert.equal(result.profile,'test');
 }
 const fresh=await terminal(provider(),worker);assert.match(fresh.record.id,/^[0-9a-f-]{36}$/);assert.equal(fresh.record.previousSessionId,undefined);assert.equal(fresh.record.reconnectedAt,undefined);assert.equal(fresh.record.instanceId,'i-1');
});

test('an incomplete connection is refused',async()=>{
 for(const missing of ['SessionId','TokenValue','StreamUrl'])await assert.rejects(terminal(provider({start:async()=>({...connection,[missing]:''})}),worker),/incomplete terminal connection/);
});

test('a terminal waits for the agent to connect but gives up at its deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-01-01T00:00:00Z')});
 const eventually=provider({start:async attempt=>{if(attempt<3)throw notConnected();return connection;}});
 const opened=await drive(t,terminal(eventually,worker),2000);
 assert.equal(opened.record.sessionId,'remote-2');assert.equal(eventually.calls.length,3);assert.equal(Date.now(),Date.parse('2026-01-01T00:00:04Z'));
 const never=provider({start:async()=>{throw notConnected();}}),began=Date.now();
 await assert.rejects(drive(t,terminal(never,worker),2000),/start-session failed/);
 assert.equal(never.calls.length,31);assert.equal(Date.now()-began,60000);
 const ambiguous=provider({start:async()=>{throw Error('socket hang up');}});
 await assert.rejects(terminal(ambiguous,worker),/socket hang up/);assert.equal(ambiguous.calls.length,1);
});

test('artifact paths stay relative to the workspace and are passed as data, not shell text',()=>{
 for(const path of [undefined,7,'','a//b','a/','./a','a/./b','..','a\tb','a\u0000b','x'.repeat(513)])assert.throws(()=>artifactCommand(path),/relative artifact path/,JSON.stringify(path));
 const tricky="it's; rm -rf $(HOME)/x.txt",command=artifactCommand(tricky);
 assert.ok(command.startsWith("python3 -c '"));assert.ok(command.endsWith("'"));
 assert.ok(command.includes(Buffer.from(tricky).toString('base64')));assert.equal(command.includes('rm -rf'),false);
 // Every quote inside the script is closed, escaped and reopened, so the shell sees one argument.
 const inner=command.slice("python3 -c '".length,-1);assert.equal(inner.replaceAll("'\\''",'').includes("'"),false);
 assert.ok(artifactCommand('x'.repeat(512)).length<16000);
});

test('artifact collection polls until the command settles and verifies what it received',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-01-01T00:00:00Z')});
 const good={status:'Success',exitCode:0,stdout:JSON.stringify(payload('synthetic file'))};
 const racing=Error('AWS ssm get-command-invocation failed',{cause:{stderr:'An error occurred (InvocationDoesNotExist)'}});
 const slow=collector([racing,{status:'Pending'},{status:'InProgress'},good]);
 const saved=await drive(t,artifact(slow,worker,'out/result.txt'),1000);
 assert.equal(slow.polls(),4);assert.equal(Date.now(),Date.parse('2026-01-01T00:00:03Z'));
 assert.equal(Buffer.from(saved.data,'base64').toString(),'synthetic file');assert.equal(saved.workerId,'w');assert.equal(saved.path,'out/result.txt');assert.equal(saved.bytes,14);assert.match(saved.id,/^[0-9a-f-]{36}$/);assert.equal(saved.createdAt,'2026-01-01T00:00:03.000Z');
 await assert.rejects(artifact(collector([Error('denied',{cause:{stderr:'AccessDenied'}})]),worker,'a'),/denied/);
 await assert.rejects(artifact(collector([Error('no cause')]),worker,'a'),/no cause/);
 for(const status of ['Failed','TimedOut','Cancelled','Cancelling'])await assert.rejects(artifact(collector([{status}]),worker,'a'),/Artifact collection failed/);
 await assert.rejects(artifact(collector([{status:'Success',exitCode:1,stdout:''}]),worker,'a'),/Artifact command failed/);
 const big=Buffer.alloc(12289,1),oversized={data:big.toString('base64'),bytes:big.length,sha256:createHash('sha256').update(big).digest('hex')};
 for(const [value,message] of [
  [null,/Invalid artifact response/],[{...payload('x'),data:5},/Invalid artifact response/],[{...payload('x'),sha256:undefined},/Invalid artifact response/],[{...payload('x'),bytes:'1'},/Invalid artifact response/],
  [{...payload('x'),data:'not base64!'},/Invalid artifact encoding/],
  [oversized,/integrity check failed/],[{...payload('x'),bytes:2},/integrity check failed/],[{...payload('x'),sha256:'0'.repeat(64)},/integrity check failed/],
 ])await assert.rejects(artifact(collector([{status:'Success',exitCode:0,stdout:JSON.stringify(value)}]),worker,'a'),message,JSON.stringify(value)?.slice(0,80));
 await assert.rejects(artifact(collector([{status:'Success',exitCode:0,stdout:'not json'}]),worker,'a'),SyntaxError);
 await assert.rejects(artifact({execute:async()=>{throw Error('Worker must be running.');}},worker,'a'),/must be running/);
 await assert.rejects(artifact(collector([good]),worker,'../escape'),/relative artifact path/);
 const stuck=collector([{status:'InProgress'}]),began=Date.now();
 await assert.rejects(drive(t,artifact(stuck,worker,'a'),1000),/Artifact collection timed out/);
 assert.equal(stuck.polls(),120);assert.equal(Date.now()-began,120000);
});
