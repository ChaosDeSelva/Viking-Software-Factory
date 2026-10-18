import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../apps/api/server.mjs';
import {AwsProvider} from '../packages/providers/aws.mjs';
const config={profile:'test',region:'us-west-2',accountId:'123456789012',fleetId:'api-test-fleet',cleanupStack:'test-cleanup',subnetId:'subnet-123',securityGroupIds:['sg-123'],maxWorkers:1,templates:{general:{imageId:'ami-123',instanceType:'t3.micro',diskGiB:8}}};
async function start(database,provider){const app=createApp({database,provider});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;const {token}=await(await fetch(base+'/api/session')).json();return {...app,post:(body,key)=>fetch(base+'/api/workers',{method:'POST',headers:{'Content-Type':'application/json','X-Skidbladnir-Token':token,'Idempotency-Key':key},body:JSON.stringify(body)})};}
test('uncertain AWS launch is durably reserved across restart and cannot be duplicated by retries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'skid-aws-')),database=join(dir,'db.sqlite'),provider=new AwsProvider(config,async()=>{throw Error('No real AWS calls allowed');});let calls=0;
 provider.create=async()=>{calls++;throw Error('Response lost after submit');};provider.inspect=async worker=>worker;
 let app;const spec={name:'Synthetic test',template:'general',minutes:5};
 try{
 app=await start(database,provider);assert.equal((await app.post(spec,'stable-key-123')).status,400);assert.equal(app.snapshot().workers[0].state,'unknown');await app.close();app=null;
 app=await start(database,provider);const retry=await app.post(spec,'stable-key-123');assert.equal(retry.status,200);assert.equal((await retry.json()).state,'unknown');assert.equal(calls,1);
 assert.equal((await app.post({...spec,name:'Different'},'stable-key-123')).status,400);
 assert.equal((await app.post(spec,'different-key-123')).status,409);assert.equal(calls,1);
 }finally{if(app)await app.close();rmSync(dir,{recursive:true,force:true});}
});
