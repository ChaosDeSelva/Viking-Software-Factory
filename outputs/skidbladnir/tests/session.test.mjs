import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {terminal,artifact,artifactCommand} from '../packages/providers/session.mjs';
test('terminal resume and close require recorded instance ownership and never return tokens in records',async()=>{
 const calls=[];const p={config:{region:'us-west-2',profile:'test'},inspect:async w=>({...w,ownershipConfirmed:true,state:'running'}),request:async(op,verb,input)=>{calls.push([verb,input]);if(verb==='describe-sessions')return {Sessions:[{SessionId:'s-1',Target:'i-1'}]};return {SessionId:'s-1',TokenValue:'private-token',StreamUrl:'wss://example.test'};}};
 const w={id:'worker',instanceId:'i-1'},s=await terminal(p,w);assert.equal(calls[0][1].DocumentName,'AWS-StartInteractiveCommand');assert.deepEqual(calls[0][1].Parameters,{command:['/bin/sh']});assert.equal(JSON.stringify(s.record).includes('private-token'),false);
 assert.equal((await terminal(p,w,s.record,'resume')).record.previousSessionId,'s-1');
 assert.deepEqual(calls.map(c=>c[0]),['start-session','describe-sessions','terminate-session','start-session']);
 await assert.rejects(terminal(p,{...w,instanceId:'i-other'},s.record,'close'),/mismatch/);
 assert.equal((await terminal(p,w,s.record,'close')).record.status,'closed');
 assert.equal(calls.at(-1)[0],'terminate-session');
});
test('artifact transfer rejects traversal and corrupted content',async()=>{
 for(const path of ['../secret','/etc/passwd','a/../secret','a\nfoo'])assert.throws(()=>artifactCommand(path));
 const bytes=Buffer.from('synthetic file'),value={data:bytes.toString('base64'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const p={execute:async()=>({commandId:'c'}),command:async()=>({status:'Success',exitCode:0,stdout:JSON.stringify(value)})};
 assert.equal((await artifact(p,{id:'w'},'result.txt')).sha256,value.sha256);
 value.sha256='bad';await assert.rejects(artifact(p,{id:'w'},'result.txt'),/integrity/);
});
test('terminal creation never retries ambiguous failures',async()=>{
 let calls=0;const p={inspect:async w=>({...w,ownershipConfirmed:true,state:'running'}),request:async()=>{calls++;throw Error('unknown',{cause:{name:'TimeoutError'}});}};
 await assert.rejects(terminal(p,{id:'w',instanceId:'i'}),/unknown/);assert.equal(calls,1);
});
test('closing an expired terminal reconciles its local record without another mutation',async()=>{
 const calls=[];const p={inspect:async w=>({...w,ownershipConfirmed:true,state:'terminated'}),request:async(service,operation)=>{calls.push(operation);return {Sessions:[]};}};
 const record={id:'local',workerId:'w',instanceId:'i',sessionId:'remote',status:'active'};
 assert.equal((await terminal(p,{id:'w',instanceId:'i'},record,'close')).record.status,'closed');assert.deepEqual(calls,['describe-sessions']);
});
