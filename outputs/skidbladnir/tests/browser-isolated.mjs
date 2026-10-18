import {chromium} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createApp} from '../apps/api/server.mjs';
import {Simulator} from '../packages/providers/simulator.mjs';
class Fixture extends Simulator {
 mode='aws';maxWorkers=1;config={accountId:'123456789012',region:'us-west-2',fleetId:'fixture-only',templates:{general:{}}};
 prepare(input){return {id:'aws-fixture',...input,state:'provisioning',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()};}
 async create(input,worker){return {...worker,instanceId:'i-fixture',state:'running'};}
 async inspect(worker){return worker;}
 async execute(worker,command){return {commandId:'fixture-command',instanceId:'i-fixture',status:'Pending',artifact:command.startsWith('python3')};}
 async command(worker,record){return {...record,status:'Success',exitCode:0,stdout:record.artifact?JSON.stringify({data:Buffer.from('file evidence').toString('base64'),bytes:13,sha256:createHash('sha256').update('file evidence').digest('hex')}):'synthetic browser result\n'};}
}
const browser=await chromium.launch({headless:true});
try {for(const aws of [false,true]){
 const app=createApp({provider:aws?new Fixture():new Simulator()});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
 await page.goto(`http://127.0.0.1:${app.server.address().port}`);await page.getByText('Live connection',{exact:true}).waitFor();
 await page.getByLabel('Worker name').fill('Synthetic browser test');
 if(aws){assert.equal(await page.getByRole('button',{name:'Launch AWS worker'}).isDisabled(),true);await page.getByLabel('I approve creating a billable worker').check();}
 await page.getByRole('button',{name:aws?'Launch AWS worker':'Launch simulated worker'}).click();
 await page.getByRole('heading',{name:'Synthetic browser test',exact:true}).waitFor();
 if(aws){await page.getByLabel('Shell command').fill('printf synthetic');await page.getByRole('button',{name:'Run command'}).click();await page.getByRole('button',{name:'Refresh result'}).click();await page.getByText('synthetic browser result',{exact:true}).waitFor();assert.equal(await page.getByText('$0',{exact:true}).count(),0);await page.getByLabel('Artifact path').fill('result.txt');await page.getByRole('button',{name:'Collect artifact'}).click();await page.getByRole('link',{name:'result.txt'}).waitFor();const href=await page.getByRole('link',{name:'result.txt'}).getAttribute('href');const download=await context.request.get(new URL(href,page.url()).href);assert.equal(await download.text(),'file evidence');}
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))console.log(await page.evaluate(()=>({width:innerWidth,overflow:[...document.querySelectorAll('*')].filter(x=>x.getBoundingClientRect().right>innerWidth+1).map(x=>[x.tagName,x.className,x.textContent?.slice(0,50)])})));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const result=await new AxeBuilder({page}).analyze();assert.deepEqual(result.violations.map(v=>v.id),[]);}
 await page.screenshot({path:`docs/${aws?'aws-fixture':'simulation'}-acceptance.png`,fullPage:true});
 await page.getByRole('button',{name:'Terminate',exact:true}).click();await page.getByRole('button',{name:'Confirm termination',exact:true}).click();await page.getByText(aws?'AWS terminate requested.':'Simulated terminate requested.',{exact:true}).waitFor();assert.deepEqual(errors,[]);
 console.log(JSON.stringify({mode:aws?'AWS fixture, no cloud resources':'simulation',viewports:3,axeViolations:0,errors}));
 }finally{await context.close();await app.close();}
 }}finally{await browser.close();}
