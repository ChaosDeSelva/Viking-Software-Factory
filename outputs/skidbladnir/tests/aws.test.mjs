import test from 'node:test';
import assert from 'node:assert/strict';
import {AwsProvider,awsConfig} from '../packages/providers/aws.mjs';
const config={profile:'test',region:'us-west-2',accountId:'123456789012',fleetId:'test-fleet-123',cleanupStack:'test-cleanup',subnetId:'subnet-123',securityGroupIds:['sg-123'],maxWorkers:2,templates:{general:{imageId:'ami-123',instanceType:'t3.small',diskGiB:20}}};
function fixture(overrides={}) {
 const calls=[];const owned={InstanceId:'i-123',State:{Name:'running'},Tags:[{Key:'skidbladnir:fleet',Value:config.fleetId},{Key:'skidbladnir:worker',Value:'worker'}]};
 const defaults={
 'sts/get-caller-identity':{Account:config.accountId},
 'cloudformation/describe-stacks':{Stacks:[{StackStatus:'CREATE_COMPLETE',Outputs:Object.entries({FleetId:config.fleetId,InstanceProfileName:'profile',ExpiryRuleName:'rule',ExpiryFunctionName:'expiry'}).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]},
 'events/describe-rule':{State:'ENABLED'},
 'lambda/get-function-configuration':{State:'Active',FunctionArn:'arn:test:expiry'},
 'events/list-targets-by-rule':{Targets:[{Arn:'arn:test:expiry'}]},
 'ec2/describe-instances':{Reservations:[]},
 'ec2/describe-images':{Images:[{State:'available',Architecture:'x86_64',RootDeviceType:'ebs',RootDeviceName:'/dev/xvda',BlockDeviceMappings:[{DeviceName:'/dev/xvda',Ebs:{VolumeSize:8}}]}]},
 'ec2/describe-instance-types':{InstanceTypes:[{ProcessorInfo:{SupportedArchitectures:['x86_64']}}]},
 'ec2/run-instances':{Instances:[{InstanceId:'i-123',State:{Name:'pending'}}]},
 'ssm/describe-instance-information':{InstanceInformationList:[{PingStatus:'Online'}]},
 'ssm/send-command':{Command:{CommandId:'command-123'}},
 'ssm/get-command-invocation':{Status:'Success',ResponseCode:0,StandardOutputContent:'ok',StandardErrorContent:''}
 };
 const request=async(service,op,input)=>{const key=service+'/'+op;calls.push({key,input});const value=overrides[key]??defaults[key]??{};if(value instanceof Error)throw value;return structuredClone(value);};
 return {provider:new AwsProvider(config,request),calls,owned};
}
test('AWS launch pins ownership, expiry, idempotency, encrypted disposable disk and private networking',async()=>{
 const {provider,calls}=fixture();const spec={name:'test',template:'general',minutes:5};const reserved=provider.prepare(spec);const result=await provider.create(spec,reserved);
 assert.equal(result.instanceId,'i-123');assert.equal(result.state,'starting');
 const request=calls.find(x=>x.key==='ec2/run-instances').input;
 assert.equal(request.ClientToken,reserved.requestId);assert.equal(request.MetadataOptions.HttpTokens,'required');
 assert.equal(request.NetworkInterfaces[0].AssociatePublicIpAddress,false);
 assert.deepEqual(request.BlockDeviceMappings[0].Ebs,{VolumeSize:20,VolumeType:'gp3',Encrypted:true,DeleteOnTermination:true});
 assert.equal(request.TagSpecifications[0].Tags.find(t=>t.Key==='skidbladnir:expires').Value,reserved.expiresAt);
});
test('rejects account mismatch, disabled expiration and architecture mismatch before submitting',async()=>{
 for(const overrides of [
 {'sts/get-caller-identity':{Account:'000000000000'}},
 {'events/describe-rule':{State:'DISABLED'}},
 {'events/list-targets-by-rule':{Targets:[]}},
 {'lambda/get-function-configuration':{State:'Failed'}},
 {'ec2/describe-instance-types':{InstanceTypes:[{ProcessorInfo:{SupportedArchitectures:['arm64']}}]}}
 ]) {
 const {provider,calls}=fixture(overrides);await assert.rejects(provider.create({name:'x',template:'general',minutes:5}),e=>e.notSubmitted===true);
 assert.equal(calls.some(c=>c.key==='ec2/run-instances'),false);
 }
});
test('ambiguous submission remains unknown and is never retried by the provider',async()=>{
 const {provider,calls}=fixture({'ec2/run-instances':new Error('connection lost')});
 await assert.rejects(provider.create({name:'x',template:'general',minutes:5}),e=>!e.notSubmitted);
 assert.equal(calls.filter(x=>x.key==='ec2/run-instances').length,1);
});
test('does not mutate instances owned by a different worker',async()=>{
 const f=fixture();const {provider,calls}=fixture({'ec2/describe-instances':{Reservations:[{Instances:[f.owned]}]}});
 await assert.rejects(provider.transition({id:'different',instanceId:'i-123',fleetId:config.fleetId,accountId:config.accountId,region:config.region},'terminate'),/ownership/);
 assert.equal(calls.some(x=>x.key==='ec2/terminate-instances'),false);
});
test('SSM readiness, output and cancellation are bound to the owned instance',async()=>{
 const f=fixture();const {provider,calls}=fixture({'ec2/describe-instances':{Reservations:[{Instances:[f.owned]}]}});
 const worker={id:'worker',instanceId:'i-123',fleetId:config.fleetId,accountId:config.accountId,region:config.region};
 const command=await provider.execute(worker,'printf hello');assert.equal(command.commandId,'command-123');
 assert.equal((await provider.command(worker,command)).stdout,'ok');
 await provider.command(worker,command,true);assert.deepEqual(calls.at(-1).input.InstanceIds,['i-123']);
 await assert.rejects(provider.command(worker,{...command,instanceId:'i-other'}),/another worker/);
});
test('config refuses unknown templates and unbounded capacity',()=>{
 assert.throws(()=>awsConfig({...config,maxWorkers:100}));assert.throws(()=>awsConfig({...config,templates:{arbitrary:config.templates.general}}));
 assert.throws(()=>awsConfig({...config,fleetId:'a'.repeat(41)}));
});
test('missing ownership refuses termination and command access despite a previously confirmed saved record',async()=>{
 const {provider,calls}=fixture();
 const worker={id:'worker',instanceId:'i-123',ownershipConfirmed:true,fleetId:config.fleetId,accountId:config.accountId,region:config.region};
 await assert.rejects(provider.transition(worker,'terminate'),/ownership/);
 for(const cancel of [false,true])await assert.rejects(provider.command(worker,{instanceId:'i-123',commandId:'command-123'},cancel),/ownership/);
 assert.equal(calls.some(x=>['ec2/terminate-instances','ssm/cancel-command','ssm/get-command-invocation'].includes(x.key)),false);
});
