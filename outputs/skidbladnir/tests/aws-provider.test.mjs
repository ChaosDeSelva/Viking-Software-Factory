import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {AwsProvider,awsConfig,cliTransport} from '../packages/providers/aws.mjs';
const config={profile:'test',region:'us-west-2',accountId:'123456789012',fleetId:'test-fleet-123',cleanupStack:'test-cleanup',subnetId:'subnet-123',securityGroupIds:['sg-123'],maxWorkers:2,templates:{general:{imageId:'ami-123',instanceType:'t3.small',diskGiB:20}}};
const stackOutputs=values=>Object.entries(values).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}));
const goodOutputs={FleetId:config.fleetId,InstanceProfileName:'profile',ExpiryRuleName:'rule',ExpiryFunctionName:'expiry'};
const image={State:'available',Architecture:'x86_64',RootDeviceType:'ebs',RootDeviceName:'/dev/xvda',BlockDeviceMappings:[{DeviceName:'/dev/xvda',Ebs:{VolumeSize:8}}]};
const tagged=(id,worker,state='running',extra={})=>({InstanceId:id,State:{Name:state},Tags:[{Key:'skidbladnir:fleet',Value:config.fleetId},{Key:'skidbladnir:worker',Value:worker}],...extra});
function fixture(overrides={}){
 const calls=[];
 const defaults={
  'sts/get-caller-identity':{Account:config.accountId},
  'cloudformation/describe-stacks':{Stacks:[{StackStatus:'CREATE_COMPLETE',Outputs:stackOutputs(goodOutputs)}]},
  'events/describe-rule':{State:'ENABLED'},
  'lambda/get-function-configuration':{State:'Active',FunctionArn:'arn:test:expiry'},
  'events/list-targets-by-rule':{Targets:[{Arn:'arn:test:expiry'}]},
  'ec2/describe-instances':{Reservations:[]},
  'ec2/describe-images':{Images:[image]},
  'ec2/describe-instance-types':{InstanceTypes:[{ProcessorInfo:{SupportedArchitectures:['x86_64']}}]},
  'ec2/run-instances':{Instances:[{InstanceId:'i-123',State:{Name:'pending'}}]},
  'ssm/describe-instance-information':{InstanceInformationList:[{PingStatus:'Online'}]},
  'ssm/send-command':{Command:{CommandId:'command-123'}},
  'ssm/get-command-invocation':{Status:'Success',ResponseCode:0},
 };
 const request=async(service,operation,input)=>{const key=service+'/'+operation;calls.push({key,input});const value=overrides[key]??defaults[key]??{};if(value instanceof Error)throw value;return structuredClone(value);};
 return {provider:new AwsProvider(config,request),calls};
}
const inventory=(...instances)=>({'ec2/describe-instances':{Reservations:[{Instances:instances}]}});
const worker={id:'worker',instanceId:'i-123',requestId:'request-1',fleetId:config.fleetId,accountId:config.accountId,region:config.region,state:'running',expiresAt:new Date(Date.now()+3600000).toISOString()};
const spec={name:'x',template:'general',minutes:5};

test('configuration is copied, defaulted and every field is validated',()=>{
 const {maxWorkers,...withoutLimit}=config;const parsed=awsConfig(withoutLimit);
 assert.equal(parsed.maxWorkers,2);assert.notEqual(parsed.templates,config.templates);assert.equal(withoutLimit.maxWorkers,undefined);
 assert.equal(awsConfig({...config,region:'us-gov-west-1'}).region,'us-gov-west-1');
 const identity=/profile, region, account ID and fleet ID/,network=/cleanup stack, subnet and security groups/,limit=/between one and five/,template=/Invalid approved AWS template/;
 for(const [change,message] of [
  [null,identity],[{profile:undefined},identity],[{profile:'bad profile'},identity],[{region:'mars'},identity],[{region:undefined},identity],[{accountId:'123'},identity],[{accountId:undefined},identity],[{fleetId:'short'},identity],[{fleetId:undefined},identity],
  [{cleanupStack:'1bad'},network],[{cleanupStack:undefined},network],[{subnetId:'subnet-XYZ'},network],[{subnetId:undefined},network],[{securityGroupIds:'sg-123'},network],[{securityGroupIds:[]},network],[{securityGroupIds:['sg-123','bad']},network],
  [{maxWorkers:0},limit],[{maxWorkers:6},limit],[{maxWorkers:1.5},limit],
  [{templates:undefined},/At least one approved AWS template/],[{templates:'general'},/At least one approved AWS template/],[{templates:{}},/At least one approved AWS template/],
  [{templates:{shell:config.templates.general}},template],[{templates:{general:{...config.templates.general,imageId:'img-1'}}},template],[{templates:{general:{instanceType:'t3.small',diskGiB:20}}},template],
  [{templates:{general:{...config.templates.general,instanceType:'huge'}}},template],[{templates:{general:{imageId:'ami-123',diskGiB:20}}},template],
  [{templates:{general:{...config.templates.general,diskGiB:7}}},template],[{templates:{general:{...config.templates.general,diskGiB:101}}},template],[{templates:{general:{...config.templates.general,diskGiB:'20'}}},template],
 ])assert.throws(()=>awsConfig(change&&{...config,...change}),message,JSON.stringify(change));
 assert.throws(()=>new AwsProvider({...config,maxWorkers:9},async()=>({})),limit);
});

test('the CLI transport passes structured arguments and hides provider error text',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'skid-cli-')),log=join(dir,'args.txt'),saved={PATH:process.env.PATH,FAKE_AWS_MODE:process.env.FAKE_AWS_MODE,FAKE_AWS_LOG:process.env.FAKE_AWS_LOG};
 // A stand-in named aws, first on PATH: the real AWS CLI is never started.
 writeFileSync(join(dir,'aws'),`#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_AWS_LOG"\nprintf '%s %s %s' "$AWS_PAGER|" "$AWS_CLI_AUTO_PROMPT" "$AWS_MAX_ATTEMPTS" >> "$FAKE_AWS_LOG"\ncase "$FAKE_AWS_MODE" in\n fail) echo 'account 123456789012 denied: rm -rf' >&2; exit 254;;\n empty) exit 0;;\n *) printf '{"Account":"123456789012"}';;\nesac\n`);chmodSync(join(dir,'aws'),0o700);
 process.env.PATH=dir+delimiter+saved.PATH;process.env.FAKE_AWS_LOG=log;
 t.after(()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;rmSync(dir,{recursive:true,force:true});});
 const provider=new AwsProvider(config);
 process.env.FAKE_AWS_MODE='json';assert.deepEqual(await provider.identity(),{Account:'123456789012'});
 assert.deepEqual(readFileSync(log,'utf8').split('\n'),['sts','get-caller-identity','--profile','test','--region','us-west-2','--output','json','--no-cli-pager','--cli-connect-timeout','10','--cli-read-timeout','30','--cli-input-json','{}','| off 1']);
 const request=cliTransport(config);
 process.env.FAKE_AWS_MODE='empty';assert.deepEqual(await request('ec2','reboot-instances',{InstanceIds:['i-1; echo injected']}),{});
 assert.equal(readFileSync(log,'utf8').split('\n')[14],'{"InstanceIds":["i-1; echo injected"]}');
 process.env.FAKE_AWS_MODE='fail';
 await assert.rejects(request('ec2','describe-instances',{}),error=>{assert.equal(error.message,'AWS ec2 describe-instances failed or its outcome is unknown. Check your profile and reconcile before retrying.');assert.match(error.cause.stderr,/denied/);return true;});
});

test('terminal sessions are opened through the SDK against the configured profile only',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'skid-sdk-')),requests=[];let reply={status:200,body:{SessionId:'session-1',TokenValue:'stream-token',StreamUrl:'wss://example.test/stream',Unrelated:'dropped'}};
 // Loopback stand-in for the SSM endpoint with synthetic credentials: nothing leaves this machine.
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push({target:req.headers['x-amz-target'],authorization:req.headers.authorization,body:JSON.parse(body)});res.writeHead(reply.status,{'Content-Type':'application/x-amz-json-1.1'});res.end(JSON.stringify(reply.body));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 writeFileSync(join(dir,'credentials'),'[test]\naws_access_key_id = AKIASYNTHETICTESTKEY\naws_secret_access_key = synthetic-secret-for-loopback-tests\n');writeFileSync(join(dir,'config'),'[profile test]\nregion = us-west-2\n');
 const names=['AWS_SHARED_CREDENTIALS_FILE','AWS_CONFIG_FILE','AWS_ENDPOINT_URL','AWS_ENDPOINT_URL_SSM','AWS_EC2_METADATA_DISABLED','AWS_PROFILE','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN'],saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 for(const name of names)delete process.env[name];
 const endpoint=`http://127.0.0.1:${server.address().port}`;
 Object.assign(process.env,{AWS_SHARED_CREDENTIALS_FILE:join(dir,'credentials'),AWS_CONFIG_FILE:join(dir,'config'),AWS_ENDPOINT_URL:endpoint,AWS_ENDPOINT_URL_SSM:endpoint,AWS_EC2_METADATA_DISABLED:'true'});
 t.after(async()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 const request=cliTransport(config),input={Target:'i-123',DocumentName:'AWS-StartInteractiveCommand',Parameters:{command:['/bin/sh']}};
 assert.deepEqual(await request('ssm','start-session',input),{SessionId:'session-1',TokenValue:'stream-token',StreamUrl:'wss://example.test/stream'});
 assert.equal(requests.length,1);assert.equal(requests[0].target,'AmazonSSM.StartSession');assert.deepEqual(requests[0].body,input);assert.match(requests[0].authorization,/Credential=AKIASYNTHETICTESTKEY\/\d{8}\/us-west-2\/ssm\//);
 reply={status:400,body:{__type:'TargetNotConnected',message:'i-123 is not connected.'}};
 await assert.rejects(request('ssm','start-session',input),error=>{assert.match(error.message,/^AWS ssm start-session failed or its outcome is unknown/);assert.equal(error.cause.name,'TargetNotConnected');return true;});
 assert.equal(requests.length,2);
});

test('cleanup readiness refuses every incomplete expiration arrangement',async()=>{
 assert.deepEqual(await fixture().provider.cleanupReady(),goodOutputs);
 assert.deepEqual(await fixture({'cloudformation/describe-stacks':{Stacks:[{StackStatus:'UPDATE_COMPLETE',Outputs:stackOutputs(goodOutputs)}]}}).provider.cleanupReady(),goodOutputs);
 for(const [overrides,message] of [
  [{'sts/get-caller-identity':{Account:'000000000000'}},/account does not match/],
  [{'cloudformation/describe-stacks':{}},/cleanup stack is not ready/],
  [{'cloudformation/describe-stacks':{Stacks:[{StackStatus:'ROLLBACK_COMPLETE'}]}},/cleanup stack is not ready/],
  [{'cloudformation/describe-stacks':{Stacks:[{StackStatus:'CREATE_COMPLETE'}]}},/ownership or outputs/],
  [{'cloudformation/describe-stacks':{Stacks:[{StackStatus:'CREATE_COMPLETE',Outputs:stackOutputs({...goodOutputs,FleetId:'another-fleet'})}]}},/ownership or outputs/],
  ...['InstanceProfileName','ExpiryRuleName','ExpiryFunctionName'].map(missing=>[{'cloudformation/describe-stacks':{Stacks:[{StackStatus:'CREATE_COMPLETE',Outputs:stackOutputs({...goodOutputs,[missing]:''})}]}},/ownership or outputs/]),
  [{'events/describe-rule':{State:'DISABLED'}},/expiration is disabled/],
  [{'lambda/get-function-configuration':{State:'Pending',FunctionArn:'arn:test:expiry'}},/function or schedule target/],
  [{'events/list-targets-by-rule':{}},/function or schedule target/],
  [{'events/list-targets-by-rule':{Targets:[{Arn:'arn:test:other'}]}},/function or schedule target/],
 ])await assert.rejects(fixture(overrides).provider.cleanupReady(),message,JSON.stringify(overrides));
});

test('launch refuses unapproved templates, exhausted capacity and unsuitable images before submitting',async()=>{
 assert.throws(()=>fixture().provider.prepare({...spec,template:'node'}),/not approved for AWS/);
 assert.throws(()=>fixture().provider.prepare({...spec,minutes:1}),/Lifetime/);
 const twoVolumes={...image,BlockDeviceMappings:[...image.BlockDeviceMappings,{DeviceName:'/dev/sdb',Ebs:{VolumeSize:1}}]};
 for(const [overrides,message] of [
  [inventory(tagged('i-1','a'),tagged('i-2','b','pending')),/capacity is exhausted/],
  [{'ec2/describe-images':{}},/incompatible/],
  [{'ec2/describe-images':{Images:[{...image,State:'pending'}]}},/incompatible/],
  [{'ec2/describe-images':{Images:[{...image,RootDeviceType:'instance-store'}]}},/incompatible/],
  [{'ec2/describe-instance-types':{}},/incompatible/],
  [{'ec2/describe-instance-types':{InstanceTypes:[{}]}},/incompatible/],
  [{'ec2/describe-images':{Images:[{...image,BlockDeviceMappings:undefined}]}},/single EBS root disk/],
  [{'ec2/describe-images':{Images:[twoVolumes]}},/single EBS root disk/],
  [{'ec2/describe-images':{Images:[{...image,RootDeviceName:'/dev/sda1'}]}},/single EBS root disk/],
  [{'ec2/describe-images':{Images:[{...image,BlockDeviceMappings:[{DeviceName:'/dev/xvda',Ebs:{VolumeSize:21}}]}]}},/single EBS root disk/],
 ]){
  const {provider,calls}=fixture(overrides);
  await assert.rejects(provider.create(spec),error=>{assert.match(error.message,message);return error.notSubmitted===true;},JSON.stringify(overrides));
  assert.equal(calls.some(c=>c.key==='ec2/run-instances'),false);
 }
});

test('a reserved worker expires exactly its lifetime after creation, matching its expiry tag',()=>{
 const {provider}=fixture();
 // Two separate clock reads drift by a millisecond under load (about one reservation in a few hundred).
 for(let i=0;i<2000;i++){const reserved=provider.prepare({...spec,minutes:7});assert.equal(Date.parse(reserved.expiresAt)-Date.parse(reserved.createdAt),420000);}
});

test('launch ignores retired instances, skips ephemeral image volumes and reports the observed state',async()=>{
 const mixed={...image,BlockDeviceMappings:[{DeviceName:'/dev/sdb',VirtualName:'ephemeral0'},...image.BlockDeviceMappings]};
 const {provider,calls}=fixture({...inventory(tagged('i-1','a','terminated'),tagged('i-2','b','shutting-down'),tagged('i-3','c'),{...tagged('i-4','d'),State:undefined}),'ec2/describe-images':{Images:[mixed]},'ec2/run-instances':{Instances:[{InstanceId:'i-9',State:{Name:'running'}}]}});
 await assert.rejects(provider.create(spec),/capacity is exhausted/);
 const roomy=fixture({...inventory(tagged('i-1','a','terminated'),tagged('i-3','c')),'ec2/describe-images':{Images:[mixed]},'ec2/run-instances':{Instances:[{InstanceId:'i-9',State:{Name:'running'}}]}});
 const created=await roomy.provider.create(spec);assert.equal(created.state,'running');assert.equal(created.instanceId,'i-9');assert.match(created.id,/^aws-/);
 const submitted=roomy.calls.find(c=>c.key==='ec2/run-instances').input;
 assert.deepEqual(submitted.NetworkInterfaces,[{DeviceIndex:0,SubnetId:'subnet-123',Groups:['sg-123'],AssociatePublicIpAddress:false,DeleteOnTermination:true}]);
 assert.deepEqual(submitted.IamInstanceProfile,{Name:'profile'});assert.equal(submitted.MinCount,1);assert.equal(submitted.MaxCount,1);
 assert.deepEqual(submitted.TagSpecifications.map(x=>x.ResourceType),['instance','volume']);
 for(const tags of submitted.TagSpecifications)assert.deepEqual(tags.Tags.filter(x=>x.Key!=='skidbladnir:expires'),[{Key:'skidbladnir:fleet',Value:config.fleetId},{Key:'skidbladnir:worker',Value:created.id},{Key:'Name',Value:'x'}]);
 assert.equal(calls.some(c=>c.key==='ec2/run-instances'),false);
 for(const response of [{},{Instances:[]},{Instances:[{State:{Name:'pending'}}]}]){
  await assert.rejects(fixture({'ec2/run-instances':response}).provider.create(spec),error=>{assert.match(error.message,/outcome is unknown/);return error.notSubmitted===undefined;});
 }
 const stateless=await fixture({'ec2/run-instances':{Instances:[{InstanceId:'i-5'}]}}).provider.create(spec);assert.equal(stateless.state,'starting');
});

test('inventory refuses instances that do not carry this fleet tag',async()=>{
 await assert.rejects(fixture(inventory({InstanceId:'i-foreign',State:{Name:'running'}})).provider.inventory(),/ownership does not match/);
 await assert.rejects(fixture(inventory({InstanceId:'i-foreign',Tags:[{Key:'skidbladnir:fleet',Value:'another-fleet'}]})).provider.inventory(),/ownership does not match/);
 assert.deepEqual(await fixture({'ec2/describe-instances':{}}).provider.inventory(),[]);
 assert.deepEqual(await fixture({'ec2/describe-instances':{Reservations:[{}]}}).provider.inventory(),[]);
 assert.equal((await fixture(inventory(tagged('i-1','a'))).provider.inventory())[0].InstanceId,'i-1');
});

test('inspection is bound to the configuration and maps AWS states',async()=>{
 for(const change of [{fleetId:'another-fleet'},{accountId:'000000000000'},{region:'eu-west-1'}]){
  const {provider,calls}=fixture(inventory(tagged('i-123','worker')));
  await assert.rejects(provider.inspect({...worker,...change}),/another AWS configuration/);assert.equal(calls.length,0);
 }
 for(const [aws,state] of [['pending','starting'],['shutting-down','terminating'],['running','running'],['stopped','stopped'],['terminated','terminated']]){
  const seen=await fixture(inventory(tagged('i-123','worker',aws))).provider.inspect(worker);assert.equal(seen.state,state);assert.equal(seen.ownershipConfirmed,true);
 }
 const stateless=await fixture(inventory({...tagged('i-123','worker'),State:undefined})).provider.inspect(worker);assert.equal(stateless.state,'unknown');assert.equal(stateless.ownershipConfirmed,true);
 const byToken=await fixture(inventory(tagged('i-777','worker','running',{ClientToken:'request-1'}))).provider.inspect({...worker,instanceId:undefined});assert.equal(byToken.instanceId,'i-777');
 const byTag=await fixture(inventory(tagged('i-888','worker'))).provider.inspect({...worker,instanceId:undefined,requestId:'other'});assert.equal(byTag.instanceId,'i-888');
 const missing=await fixture().provider.inspect(worker);assert.equal(missing.ownershipConfirmed,false);assert.equal(missing.state,'unknown');assert.equal(missing.instanceId,'i-123');
 const gone=await fixture().provider.inspect({...worker,state:'terminated'});assert.equal(gone.state,'terminated');assert.equal(gone.ownershipConfirmed,false);
});

test('a worker without a launch token is matched by its own tag, not by the first untokened instance',async()=>{
 const {provider}=fixture(inventory(tagged('i-other','someone-else'),tagged('i-mine','worker')));
 const seen=await provider.inspect({...worker,instanceId:undefined,requestId:undefined});
 assert.equal(seen.instanceId,'i-mine');assert.equal(seen.ownershipConfirmed,true);
});

test('an expired worker whose instance is no longer listed is settled as terminated and frees its slot',async()=>{
 const expired={...worker,state:'unknown',expiresAt:new Date(Date.now()-60000).toISOString()};
 const settled=await fixture().provider.inspect(expired);assert.equal(settled.state,'terminated');assert.equal(settled.ownershipConfirmed,false);
 const pending=await fixture().provider.inspect({...expired,expiresAt:new Date(Date.now()+60000).toISOString()});assert.equal(pending.state,'unknown');
 const undated=await fixture().provider.inspect({...expired,expiresAt:undefined});assert.equal(undated.state,'unknown');
 const {provider,calls}=fixture();await assert.rejects(provider.transition(expired,'terminate'),/ownership/);assert.equal(calls.some(c=>c.key==='ec2/terminate-instances'),false);
});

test('an expired worker is settled as terminated only on positive evidence that its instance is gone',async()=>{
 const past=new Date(Date.now()-60000).toISOString();
 const unlaunched={...worker,instanceId:undefined,state:'unknown',expiresAt:past};
 // Answers the fleet (tag) listing and the launch-token listing separately.
 const split=(fleet,token)=>{const calls=[];const base=fixture();const request=async(service,operation,input)=>{if(operation==='describe-instances'){calls.push(input.Filters[0].Name);return structuredClone(input.Filters[0].Name==='client-token'?token:fleet);}return base.provider.request(service,operation,input);};return {provider:new AwsProvider(config,request),calls};};
 const gone=await fixture().provider.inspect({...worker,expiresAt:past});assert.equal(gone.state,'terminated');assert.equal(gone.attention,undefined);
 const reported=await fixture(inventory(tagged('i-123','worker','terminated'))).provider.inspect({...worker,expiresAt:past});assert.equal(reported.state,'terminated');assert.equal(reported.ownershipConfirmed,true);
 const neverLaunched=split({Reservations:[]},{Reservations:[]});const settled=await neverLaunched.provider.inspect(unlaunched);
 assert.equal(settled.state,'terminated');assert.deepEqual(neverLaunched.calls,['tag:skidbladnir:fleet','client-token']);
 const endedLaunch=await split({Reservations:[]},{Reservations:[{Instances:[{InstanceId:'i-5',State:{Name:'terminated'}}]}]}).provider.inspect(unlaunched);assert.equal(endedLaunch.state,'terminated');
 for(const [label,seen] of [
  ['untagged instance still running',await split({Reservations:[]},{Reservations:[{Instances:[{InstanceId:'i-5',State:{Name:'running'}}]}]}).provider.inspect(unlaunched)],
  ['no launch token to look up',await split({Reservations:[]},{Reservations:[]}).provider.inspect({...unlaunched,requestId:undefined})],
  ['incomplete launch-token listing',await split({Reservations:[]},{Reservations:[],NextToken:'more'}).provider.inspect(unlaunched)],
  ['incomplete fleet listing',await split({Reservations:[],NextToken:'more'},{Reservations:[]}).provider.inspect({...worker,expiresAt:past})],
 ]){assert.equal(seen.state,'unknown',label);assert.equal(seen.ownershipConfirmed,false,label);assert.match(seen.attention,/not confirmed the instance is gone/,label);}
 const found=await fixture(inventory(tagged('i-123','worker'))).provider.inspect({...worker,attention:'stale'});assert.equal(found.state,'running');assert.equal('attention' in found,false);
});

test('lifecycle actions use the confirmed instance and only from an allowed state',async()=>{
 for(const [action,from,operation,to] of [['start','stopped','start-instances','starting'],['stop','running','stop-instances','stopping'],['reboot','running','reboot-instances','running'],['terminate','stopped','terminate-instances','terminating'],['terminate','pending','terminate-instances','terminating']]){
  const {provider,calls}=fixture(inventory(tagged('i-other','someone-else'),tagged('i-123','worker',from)));
  const result=await provider.transition(worker,action);assert.equal(result.state,to);
  assert.deepEqual(calls.at(-1),{key:'ec2/'+operation,input:{InstanceIds:['i-123']}});
 }
 for(const [action,from] of [['start','running'],['stop','stopped'],['reboot','stopped'],['terminate','shutting-down'],['terminate','terminated'],['destroy','running']]){
  const {provider,calls}=fixture(inventory(tagged('i-123','worker',from)));
  await assert.rejects(provider.transition(worker,action),/unavailable until ownership and state are confirmed/);
  assert.equal(calls.filter(c=>c.key.startsWith('ec2/')&&c.key!=='ec2/describe-instances').length,0);
 }
});

test('readiness and command submission require a running instance that SSM reports online',async()=>{
 const running=inventory(tagged('i-123','worker'));
 assert.deepEqual(await fixture(running).provider.ready(worker),{ready:true,state:'running'});
 assert.deepEqual(await fixture({...running,'ssm/describe-instance-information':{InstanceInformationList:[{PingStatus:'ConnectionLost'}]}}).provider.ready(worker),{ready:false,state:'running'});
 assert.deepEqual(await fixture({...running,'ssm/describe-instance-information':{}}).provider.ready(worker),{ready:false,state:'running'});
 assert.deepEqual(await fixture(inventory(tagged('i-123','worker','stopped'))).provider.ready(worker),{ready:false,state:'stopped'});
 const absent=fixture();assert.deepEqual(await absent.provider.ready(worker),{ready:false,state:'unknown'});assert.equal(absent.calls.some(c=>c.key.startsWith('ssm/')),false);
 for(const command of [undefined,42,'','   ','x'.repeat(16001)]){const {provider,calls}=fixture(running);await assert.rejects(provider.execute(worker,command),/at most 16000 bytes/);assert.equal(calls.length,0);}
 await assert.rejects(fixture(inventory(tagged('i-123','worker','stopped'))).provider.execute(worker,'true'),/must be running/);
 for(const information of [{},{InstanceInformationList:[]},{InstanceInformationList:[{PingStatus:'Inactive'}]}]){
  const {provider,calls}=fixture({...running,'ssm/describe-instance-information':information});
  await assert.rejects(provider.execute(worker,'true'),/SSM is not online/);assert.equal(calls.some(c=>c.key==='ssm/send-command'),false);
 }
 for(const response of [{},{Command:{}}])await assert.rejects(fixture({...running,'ssm/send-command':response}).provider.execute(worker,'true'),/outcome is unknown/);
 const {provider,calls}=fixture(running);
 assert.deepEqual(await provider.execute(worker,'printf hello'),{commandId:'command-123',instanceId:'i-123',status:'Pending'});
 assert.deepEqual(calls.at(-1).input,{InstanceIds:['i-123'],DocumentName:'AWS-RunShellScript',TimeoutSeconds:60,Parameters:{commands:['printf hello'],executionTimeout:['300']}});
 const record={commandId:'command-123',instanceId:'i-123'};
 assert.deepEqual(await provider.command(worker,record),{...record,status:'Success',exitCode:0,stdout:'',stderr:''});
 assert.deepEqual(calls.at(-1).input,{CommandId:'command-123',InstanceId:'i-123'});
 const failed=await fixture({...running,'ssm/get-command-invocation':{Status:'Failed',ResponseCode:2,StandardOutputContent:'out',StandardErrorContent:'err'}}).provider.command(worker,record);
 assert.deepEqual(failed,{...record,status:'Failed',exitCode:2,stdout:'out',stderr:'err'});
});
