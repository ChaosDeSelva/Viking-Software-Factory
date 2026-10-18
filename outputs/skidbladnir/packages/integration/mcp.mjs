#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const id={type:'string',pattern:'^[A-Za-z0-9-]{1,100}$'};
const definitions=[
 ['workers','Inspect worker state, command evidence and fleet limits.',{},[]],
 ['launch','Create a worker from an approved template. AWS mode incurs charges.',{name:{type:'string'},template:{type:'string',enum:['node','python','general']},minutes:{type:'integer',minimum:5,maximum:240},requestKey:id},['name','template','minutes','requestKey']],
 ['control','Start, stop, reboot or terminate an owned worker.',{workerId:id,action:{type:'string',enum:['start','stop','reboot','terminate']}},['workerId','action']],
 ['execute','Run a reviewed shell command on an owned AWS worker through SSM.',{workerId:id,command:{type:'string',maxLength:7000},requestKey:id},['workerId','command','requestKey']],
 ['collect_artifact','Collect a file of at most 12 KiB from the owned worker workspace and retain it locally.',{workerId:id,path:{type:'string',maxLength:512}},['workerId','path']],
 ['command','Refresh or cancel a previously recorded SSM command.',{commandId:id,action:{type:'string',enum:['refresh','cancel']}},['commandId','action']],
];
export function configuration(env=process.env){
 const url=new URL(env.SKIDBLADNIR_URL??'http://127.0.0.1:4380');
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Skidbladnir requires a local IPv4 HTTP origin.');
 return {origin:url.origin,controls:env.SKIDBLADNIR_ALLOW_CONTROLS==='1'};
}
export function toolList(env=process.env){const {controls}=configuration(env);return definitions.filter(([name])=>controls||name==='workers').map(([name,description,properties,required])=>({name:'skidbladnir_'+name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:name==='workers',destructiveHint:name!=='workers',openWorldHint:name!=='workers'}}));}
async function json(response){if(!response.ok)throw Error(`Skidbladnir returned HTTP ${response.status}`);let size=0;const parts=[];for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)throw Error('Result exceeds context limit');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString());}
export async function callTool(name,args={},env=process.env,request=fetch){
 const config=configuration(env),tool=toolList(env).find(t=>t.name===name);if(!tool)throw Error('Unknown tool or controls are disabled.');
 for(const key of tool.inputSchema.required)if(args[key]===undefined)throw Error('Missing '+key);
 for(const key of Object.keys(args))if(!Object.hasOwn(tool.inputSchema.properties,key))throw Error('Unexpected argument '+key);
 for(const key of ['workerId','commandId','requestKey'])if(args[key]!==undefined&&!/^[A-Za-z0-9-]{1,100}$/.test(args[key]))throw Error('Invalid identity');
 let path='/api/snapshot',body={},method='GET';
 if(name==='skidbladnir_launch'){path='/api/workers';body={name:args.name,template:args.template,minutes:args.minutes};method='POST';}
 if(name==='skidbladnir_control'){if(!['start','stop','reboot','terminate'].includes(args.action))throw Error('Invalid action');path=`/api/workers/${args.workerId}/${args.action}`;method='POST';}
 if(name==='skidbladnir_execute'){path=`/api/workers/${args.workerId}/commands`;body={command:args.command};method='POST';}
 if(name==='skidbladnir_collect_artifact'){path=`/api/workers/${args.workerId}/artifacts`;body={path:args.path};method='POST';}
 if(name==='skidbladnir_command'){if(!['refresh','cancel'].includes(args.action))throw Error('Invalid action');path=`/api/commands/${args.commandId}/${args.action}`;method='POST';}
 const headers={};if(method==='POST'){const session=await json(await request(config.origin+'/api/session',{redirect:'error',signal:AbortSignal.timeout(10000)}));headers['Content-Type']='application/json';headers['X-Skidbladnir-Token']=session.token;if(args.requestKey)headers['Idempotency-Key']=args.requestKey;}
 const result=await json(await request(config.origin+path,{method,headers,...(method==='POST'?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(120000)}));
 return {content:[{type:'text',text:JSON.stringify(result)}]};
}
export async function dispatch(message,env=process.env){
 if(message.method==='initialize')return {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'skidbladnir',version:'0.1.0'}};
 if(message.method==='ping')return {};
 if(message.method==='tools/list')return {tools:toolList(env)};
 if(message.method==='tools/call'){try{return await callTool(message.params?.name,message.params?.arguments,env);}catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}}
 throw Error('Unsupported method');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){let message;try{if(Buffer.byteLength(line)>65536)throw Error('Request too large');message=JSON.parse(line);if(message.id===undefined)continue;const result=await dispatch(message);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');}catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:-32600,message:error.message}})+'\n');}}
}
