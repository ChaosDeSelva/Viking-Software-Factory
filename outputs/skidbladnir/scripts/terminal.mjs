#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {configuration} from '../packages/integration/mcp.mjs';
const [workerId,terminalId]=process.argv.slice(2);
if(!/^[A-Za-z0-9-]{1,100}$/.test(workerId??'') || (terminalId&&!/^[A-Za-z0-9-]{1,100}$/.test(terminalId)))throw Error('Usage: node scripts/terminal.mjs WORKER_ID [TERMINAL_ID_TO_RESUME]');
if(!process.stdin.isTTY || !process.stdout.isTTY)throw Error('Open this command in a local interactive terminal.');
const {origin}=configuration();
async function json(path,body){const session=await fetch(origin+'/api/session',{redirect:'error',signal:AbortSignal.timeout(10000)});if(!session.ok)throw Error('Local API unavailable.');const {token}=await session.json();const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Skidbladnir-Token':token},body:JSON.stringify(body??{}),redirect:'error',signal:AbortSignal.timeout(120000)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;}
const result=await json(`/api/workers/${workerId}/terminals${terminalId?'/'+terminalId+'/resume':''}`);
console.log('Terminal identity: '+result.record.id+'\nReconnect using the same command followed by this identity. Reconnect opens a fresh shell; shell variables and foreground processes do not survive. Factory jobs run separately. Type exit to end the remote shell.');
const tokenVariable='AWS_SSM_START_SESSION_RESPONSE_SKIDBLADNIR';
const args=[tokenVariable,result.region,'StartSession',result.profile,JSON.stringify({Target:result.record.instanceId}),'https://ssm.'+result.region+(result.region.startsWith('cn-')?'.amazonaws.com.cn':'.amazonaws.com')];
const child=spawn(process.env.SKIDBLADNIR_SESSION_PLUGIN??'session-manager-plugin',args,{stdio:'inherit',shell:false,env:{...process.env,[tokenVariable]:JSON.stringify(result.connection)}});
child.on('error',async()=>{console.error('Install the official AWS Session Manager plugin, or configure SKIDBLADNIR_SESSION_PLUGIN.');try{await json(`/api/workers/${workerId}/terminals/${result.record.id}/close`);}catch{console.error('Close the recorded session from the dashboard.');}process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
