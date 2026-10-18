import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { SSMClient, StartSessionCommand } from '@aws-sdk/client-ssm';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { workerInput } from '../contracts/worker.mjs';
const execute = promisify(execFile);
const OWN = 'skidbladnir:fleet';
export function awsConfig(value) {
  const c = structuredClone(value);
  if (!c || !/^[A-Za-z0-9_.-]{1,100}$/.test(c.profile ?? '') || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(c.region ?? '') || !/^\d{12}$/.test(c.accountId ?? '') || !/^[a-zA-Z0-9-]{8,40}$/.test(c.fleetId ?? '')) throw Error('AWS profile, region, account ID and fleet ID are required.');
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(c.cleanupStack ?? '') || !/^subnet-[a-f0-9]+$/.test(c.subnetId ?? '') || !Array.isArray(c.securityGroupIds) || !c.securityGroupIds.length || c.securityGroupIds.some(x=>!/^sg-[a-f0-9]+$/.test(x))) throw Error('Configure the cleanup stack, subnet and security groups.');
  c.maxWorkers ??= 2;
  if (!Number.isInteger(c.maxWorkers) || c.maxWorkers<1 || c.maxWorkers>5) throw Error('Worker limit must be between one and five.');
  if (!c.templates || typeof c.templates !== 'object' || !Object.keys(c.templates).length) throw Error('At least one approved AWS template is required.');
  for (const [name,t] of Object.entries(c.templates)) {
    if (!['node','python','general'].includes(name) || !/^ami-[a-f0-9]+$/.test(t.imageId??'') || !/^[a-z0-9]+\.[a-z0-9]+$/.test(t.instanceType??'') || !Number.isInteger(t.diskGiB) || t.diskGiB<8 || t.diskGiB>100) throw Error('Invalid approved AWS template.');
  }
  return c;
}
export function cliTransport(config) {
  return async (service, operation, input = {}) => {
    try {
      // The AWS CLI start-session command launches a plugin rather than returning JSON.
      if(service==='ssm' && operation==='start-session'){
        const client=new SSMClient({region:config.region,credentials:fromNodeProviderChain({profile:config.profile}),maxAttempts:1});
        try {const result=await client.send(new StartSessionCommand(input),{abortSignal:AbortSignal.timeout(45000)});return {SessionId:result.SessionId,TokenValue:result.TokenValue,StreamUrl:result.StreamUrl};}finally{client.destroy();}
      }
      const {stdout} = await execute('aws', [service,operation,'--profile',config.profile,'--region',config.region,'--output','json','--no-cli-pager','--cli-connect-timeout','10','--cli-read-timeout','30','--cli-input-json',JSON.stringify(input)], {timeout:45000,maxBuffer:4*1024*1024,env:{...process.env,AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off',AWS_MAX_ATTEMPTS:'1'}});
      return stdout.trim()?JSON.parse(stdout):{};
    } catch(error) {
      // Provider stderr can contain command text or account details. Keep it out of browser logs.
      throw Error(`AWS ${service} ${operation} failed or its outcome is unknown. Check your profile and reconcile before retrying.`,{cause:error});
    }
  };
}
export class AwsProvider {
  mode='aws';
  constructor(config, request) { this.config=awsConfig(config);this.request=request??cliTransport(this.config);this.maxWorkers=this.config.maxWorkers; }
  async identity() {
    const identity=await this.request('sts','get-caller-identity');
    if(identity.Account!==this.config.accountId)throw Error('AWS account does not match the approved configuration.');
    return identity;
  }
  async cleanupReady() {
    await this.identity();
    const {Stacks=[]}=await this.request('cloudformation','describe-stacks',{StackName:this.config.cleanupStack});
    const stack=Stacks[0];
    if(!stack || !['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus))throw Error('The independent cleanup stack is not ready.');
    const outputs=Object.fromEntries((stack.Outputs??[]).map(x=>[x.OutputKey,x.OutputValue]));
    if(outputs.FleetId!==this.config.fleetId || !outputs.InstanceProfileName || !outputs.ExpiryRuleName || !outputs.ExpiryFunctionName)throw Error('Cleanup stack ownership or outputs do not match.');
    const rule=await this.request('events','describe-rule',{Name:outputs.ExpiryRuleName});
    if(rule.State!=='ENABLED')throw Error('Independent expiration is disabled. Launch refused.');
    const fn=await this.request('lambda','get-function-configuration',{FunctionName:outputs.ExpiryFunctionName});
    const targets=await this.request('events','list-targets-by-rule',{Rule:outputs.ExpiryRuleName});
    if(fn.State!=='Active' || !targets.Targets?.some(t=>t.Arn===fn.FunctionArn))throw Error('Independent expiration function or schedule target is unavailable.');
    return outputs;
  }
  prepare(input) {
    input=workerInput(input);
    if(!this.config.templates[input.template])throw Error('This template is not approved for AWS.');
    const id=randomUUID();
    return {id:'aws-'+id,provider:'aws',requestId:id,...input,state:'provisioning',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+input.minutes*60000).toISOString(),accountId:this.config.accountId,region:this.config.region,fleetId:this.config.fleetId};
  }
  owned(instance,worker) {
    const tags=Object.fromEntries((instance.Tags??[]).map(t=>[t.Key,t.Value]));
    if(tags[OWN]!==this.config.fleetId || (worker && tags['skidbladnir:worker']!==worker.id))throw Error('Instance ownership does not match this fleet and worker.');
    return tags;
  }
  async inventory() {
    await this.identity();
    const data=await this.request('ec2','describe-instances',{Filters:[{Name:'tag:'+OWN,Values:[this.config.fleetId]}]});
    return (data.Reservations??[]).flatMap(r=>r.Instances??[]).filter(i=>{this.owned(i);return true;});
  }
  async create(input,worker=this.prepare(input)) {
    let submitted=false;
    try {
    const outputs=await this.cleanupReady(),template=this.config.templates[input.template];
    const active=(await this.inventory()).filter(i=>!['terminated','shutting-down'].includes(i.State?.Name));
    if(active.length>=this.maxWorkers)throw Error('Configured AWS capacity is exhausted.');
    const {Images=[]}=await this.request('ec2','describe-images',{ImageIds:[template.imageId]});
    const {InstanceTypes=[]}=await this.request('ec2','describe-instance-types',{InstanceTypes:[template.instanceType]});
    const image=Images[0],type=InstanceTypes[0];
    if(!image || image.State!=='available' || image.RootDeviceType!=='ebs' || !type?.ProcessorInfo?.SupportedArchitectures?.includes(image.Architecture))throw Error('AMI and instance architecture are incompatible.');
    const volumes=(image.BlockDeviceMappings??[]).filter(x=>x.Ebs);
    if(volumes.length!==1 || volumes[0].DeviceName!==image.RootDeviceName || volumes[0].Ebs.VolumeSize>template.diskGiB)throw Error('Template must use a single EBS root disk within the approved size.');
    const tags=[{Key:OWN,Value:this.config.fleetId},{Key:'skidbladnir:worker',Value:worker.id},{Key:'skidbladnir:expires',Value:worker.expiresAt},{Key:'Name',Value:worker.name}];
    submitted=true;
    const result=await this.request('ec2','run-instances',{
      ImageId:template.imageId,InstanceType:template.instanceType,MinCount:1,MaxCount:1,ClientToken:worker.requestId,
      IamInstanceProfile:{Name:outputs.InstanceProfileName},
      NetworkInterfaces:[{DeviceIndex:0,SubnetId:this.config.subnetId,Groups:this.config.securityGroupIds,AssociatePublicIpAddress:false,DeleteOnTermination:true}],
      MetadataOptions:{HttpTokens:'required',HttpEndpoint:'enabled'},
      BlockDeviceMappings:[{DeviceName:image.RootDeviceName,Ebs:{VolumeSize:template.diskGiB,VolumeType:'gp3',Encrypted:true,DeleteOnTermination:true}}],
      TagSpecifications:['instance','volume'].map(ResourceType=>({ResourceType,Tags:tags})),
    });
    const instance=result.Instances?.[0];if(!instance?.InstanceId)throw Error('AWS launch outcome is unknown. Reconcile this worker.');
    return {...worker,instanceId:instance.InstanceId,state:instance.State?.Name==='running'?'running':'starting'};
    } catch(error){if(!submitted)error.notSubmitted=true;throw error;}
  }
  async inspect(worker) {
    if(worker.fleetId!==this.config.fleetId || worker.accountId!==this.config.accountId || worker.region!==this.config.region)throw Error('Worker belongs to another AWS configuration.');
    const instances=await this.inventory();
    const instance=instances.find(i=>i.InstanceId===worker.instanceId || i.ClientToken===worker.requestId || (i.Tags??[]).some(t=>t.Key==='skidbladnir:worker'&&t.Value===worker.id));
    if(!instance)return {...worker,ownershipConfirmed:false,state:worker.state==='terminated'?'terminated':'unknown'};
    this.owned(instance,worker);
    const state=({'pending':'starting','shutting-down':'terminating'})[instance.State?.Name]??instance.State?.Name??'unknown';
    return {...worker,instanceId:instance.InstanceId,ownershipConfirmed:true,state};
  }
  async transition(worker,action) {
    const current=await this.inspect(worker);
    const allowed={start:['stopped'],stop:['running'],reboot:['running'],terminate:['starting','running','stopped','stopping','unknown']};
    if(!current.ownershipConfirmed || !current.instanceId || !allowed[action]?.includes(current.state))throw Error('Action is unavailable until ownership and state are confirmed.');
    const op={start:'start-instances',stop:'stop-instances',reboot:'reboot-instances',terminate:'terminate-instances'}[action];
    await this.request('ec2',op,{InstanceIds:[current.instanceId]});
    return {...current,state:{start:'starting',stop:'stopping',reboot:'running',terminate:'terminating'}[action]};
  }
  async ready(worker) {
    const current=await this.inspect(worker);
    if(!current.ownershipConfirmed || current.state!=='running')return {ready:false,state:current.state};
    const result=await this.request('ssm','describe-instance-information',{Filters:[{Key:'InstanceIds',Values:[current.instanceId]}]});
    return {ready:result.InstanceInformationList?.[0]?.PingStatus==='Online',state:current.state};
  }
  async execute(worker,command) {
    if(typeof command!=='string'||!command.trim()||Buffer.byteLength(command)>16000)throw Error('Command must contain at most 16000 bytes.');
    const current=await this.inspect(worker);if(current.state!=='running')throw Error('Worker must be running.');
    const info=await this.request('ssm','describe-instance-information',{Filters:[{Key:'InstanceIds',Values:[current.instanceId]}]});
    if(info.InstanceInformationList?.[0]?.PingStatus!=='Online')throw Error('SSM is not online. Check the instance profile and private network endpoints.');
    const result=await this.request('ssm','send-command',{InstanceIds:[current.instanceId],DocumentName:'AWS-RunShellScript',TimeoutSeconds:60,Parameters:{commands:[command],executionTimeout:['300']}});
    if(!result.Command?.CommandId)throw Error('Command outcome is unknown. Do not resend automatically.');
    return {commandId:result.Command.CommandId,instanceId:current.instanceId,status:'Pending'};
  }
  async command(worker,record,cancel=false) {
    const current=await this.inspect(worker);
    if(!current.ownershipConfirmed || current.instanceId!==record.instanceId)throw Error('Command belongs to another worker or ownership cannot be confirmed.');
    if(cancel){await this.request('ssm','cancel-command',{CommandId:record.commandId,InstanceIds:[record.instanceId]});return {...record,status:'Cancelling'};}
    const r=await this.request('ssm','get-command-invocation',{CommandId:record.commandId,InstanceId:record.instanceId});
    return {...record,status:r.Status,exitCode:r.ResponseCode,stdout:r.StandardOutputContent??'',stderr:r.StandardErrorContent??''};
  }
}
