import {randomUUID,createHash} from 'node:crypto';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function terminal(provider,worker,record,action='start'){
 const current=await provider.inspect(worker);
 if(!current.ownershipConfirmed || (action!=='close' && current.state!=='running'))throw Error('A running owned worker is required.');
 if(action!=='start'){
  if(!record || record.workerId!==worker.id || record.instanceId!==current.instanceId)throw Error('Terminal ownership mismatch.');
  const result=await provider.request('ssm','describe-sessions',{State:'Active',Filters:[{key:'SessionId',value:record.sessionId}]});
  const active=result.Sessions?.find(s=>s.SessionId===record.sessionId);
  if(active && active.Target!==current.instanceId)throw Error('Terminal ownership mismatch.');
  if(!active && action==='close')return {record:{...record,status:'closed'}};
  if(active && action==='resume')await provider.request('ssm','terminate-session',{SessionId:record.sessionId});
 }
 if(action==='close'){await provider.request('ssm','terminate-session',{SessionId:record.sessionId});return {record:{...record,status:'closed'}};}
 let connection;
 const deadline=Date.now()+60000;
 while(true){
  try{connection=await provider.request('ssm','start-session',{Target:current.instanceId,DocumentName:'AWS-StartInteractiveCommand',Parameters:{command:['/bin/sh']}});break;}
  catch(error){
   // An explicit TargetNotConnected response confirms no session was created.
   // Never retry a timeout or other ambiguous session creation result.
   if(error.cause?.name!=='TargetNotConnected'||Date.now()>=deadline)throw error;
   await delay(2000);
  }
 }
 if(!connection.SessionId || !connection.TokenValue || !connection.StreamUrl)throw Error('SSM returned an incomplete terminal connection.');
 return {record:{id:record?.id??randomUUID(),workerId:worker.id,instanceId:current.instanceId,sessionId:connection.SessionId,status:'active',createdAt:record?.createdAt??new Date().toISOString(),...(record?{previousSessionId:record.sessionId,reconnectedAt:new Date().toISOString()}: {})},connection,region:provider.config.region,profile:provider.config.profile};
}
export function artifactCommand(path){
 if(typeof path!=='string'||path.length>512||path.startsWith('/')||path.split('/').some(x=>!x||x==='.'||x==='..')||/[\x00-\x1f]/.test(path))throw Error('Use a relative artifact path within /tmp/skidbladnir-workspace.');
 const encoded=Buffer.from(path).toString('base64');
 const script=`import base64,json,pathlib,hashlib\nr=pathlib.Path('/tmp/skidbladnir-workspace').resolve()\np=(r/base64.b64decode('${encoded}').decode()).resolve()\nassert p.is_relative_to(r) and p!=r, 'Artifact escapes workspace'\nwith p.open('rb') as f: data=f.read(12289)\nassert len(data)<=12288, 'Artifact exceeds 12 KiB transfer limit'\nprint(json.dumps({'data':base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}))`;
 return "python3 -c '"+script.replaceAll("'", "'\\''")+"'";
}
export async function artifact(provider,worker,path){
 const command=await provider.execute(worker,artifactCommand(path));
 const deadline=Date.now()+120000;
 while(Date.now()<deadline){
  let result;try{result=await provider.command(worker,command);}catch(error){if(!error.cause?.stderr?.includes('InvocationDoesNotExist'))throw error;await delay(1000);continue;}
  if(result.status==='Success'){
   if(result.exitCode!==0)throw Error('Artifact command failed.');const value=JSON.parse(result.stdout);
   if(!value || typeof value.data!=='string' || typeof value.sha256!=='string' || !Number.isInteger(value.bytes))throw Error('Invalid artifact response.');
   const bytes=Buffer.from(value.data,'base64');
   if(bytes.toString('base64')!==value.data)throw Error('Invalid artifact encoding.');
   if(bytes.length>12288||bytes.length!==value.bytes||createHash('sha256').update(bytes).digest('hex')!==value.sha256)throw Error('Artifact integrity check failed.');
   return {id:randomUUID(),workerId:worker.id,path,createdAt:new Date().toISOString(),data:value.data,sha256:value.sha256,bytes:value.bytes};
  }
  if(['Failed','TimedOut','Cancelled','Cancelling'].includes(result.status))throw Error('Artifact collection failed. Check the path, size and Python runtime.');
  await delay(1000);
 }
 throw Error('Artifact collection timed out.');
}
