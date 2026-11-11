import test from 'node:test';
import assert from 'node:assert/strict';
import {workerInput,actions} from '../packages/contracts/worker.mjs';
import {Simulator} from '../packages/providers/simulator.mjs';
import {Store} from '../apps/api/store.mjs';

test('worker specifications are trimmed, bounded and stripped of unknown fields',()=>{
 assert.deepEqual(workerInput({name:'  Build box ',template:'python',minutes:240,state:'running',id:'chosen'}),{name:'Build box',template:'python',minutes:240});
 assert.deepEqual(workerInput({name:'a',template:'general',minutes:5}),{name:'a',template:'general',minutes:5});
 assert.equal(workerInput({name:'a'.repeat(64),template:'node',minutes:5}).name.length,64);
 for(const input of [undefined,null,'worker',7,[]])assert.throws(()=>workerInput(input),/Expected a worker specification/);
 for(const name of [undefined,7,'','   ','-leading','a'.repeat(65),'semi;colon','new\nline'])assert.throws(()=>workerInput({name,template:'node',minutes:5}),/Use a name/,JSON.stringify(name));
 for(const template of [undefined,'shell','Node'])assert.throws(()=>workerInput({name:'a',template,minutes:5}),/supported template/);
 for(const minutes of [undefined,'5',4,241,5.5,NaN])assert.throws(()=>workerInput({name:'a',template:'node',minutes}),/Lifetime must be/,String(minutes));
 assert.deepEqual([...actions],['start','stop','reboot','terminate']);
});

test('the simulator follows the lifecycle and refuses unknown actions',async()=>{
 const simulator=new Simulator(),before=Date.now();
 const worker=await simulator.create({name:'a',template:'node',minutes:5});
 assert.match(worker.id,/^sim-[0-9a-f-]{36}$/);assert.equal(worker.state,'running');
 assert.ok(Date.parse(worker.expiresAt)-Date.parse(worker.createdAt)===300000&&Date.parse(worker.createdAt)>=before);
 assert.equal((await simulator.transition(worker,'reboot')).state,'running');
 const stopped=await simulator.transition(worker,'stop');assert.equal(stopped.state,'stopped');assert.equal(worker.state,'running');
 await assert.rejects(simulator.transition(stopped,'stop'),/unavailable in the current state/);
 await assert.rejects(simulator.transition(stopped,'reboot'),/unavailable in the current state/);
 const terminated=await simulator.transition(stopped,'terminate');assert.equal(terminated.state,'terminated');
 for(const action of ['start','terminate','destroy',undefined])await assert.rejects(simulator.transition(terminated,action),/unavailable in the current state/);
});

test('the store keeps records in order, replaces by identity and rolls back a failed save',()=>{
 const store=new Store(':memory:');
 try{
  store.bind({mode:'simulation'});store.bind({mode:'simulation'});
  assert.throws(()=>store.bind({mode:'aws'}),/another provider/);
  assert.equal(store.get('missing'),undefined);assert.equal(store.command('missing'),undefined);assert.equal(store.terminal('missing'),undefined);assert.equal(store.artifact('missing'),undefined);
  store.save({id:'a',state:'running'},'created a');store.save({id:'b',state:'running'},'created b');store.save({id:'a',state:'stopped'},'stopped a');
  assert.deepEqual(store.list().map(w=>w.id+':'+w.state).sort(),['a:stopped','b:running']);assert.deepEqual(store.get('a'),{id:'a',state:'stopped'});
  assert.deepEqual(store.events().map(e=>e.message),['stopped a','created b','created a']);assert.equal(store.events()[0].workerId,'a');assert.ok(!Number.isNaN(Date.parse(store.events()[0].at)));
  // The event insert fails after the worker insert; neither may remain.
  assert.throws(()=>store.save({id:'c',state:'running'},null));
  assert.equal(store.get('c'),undefined);assert.equal(store.events().length,3);
  store.save({id:'c',state:'running'},'created c');assert.equal(store.list().length,3);
  store.saveCommand({id:'k1',status:'Unknown'});store.saveCommand({id:'k2',status:'Pending'});store.saveCommand({id:'k1',status:'Success'});
  assert.deepEqual(store.command('k1'),{id:'k1',status:'Success'});assert.deepEqual(store.commands().map(c=>c.id).sort(),['k1','k2']);
  store.saveTerminal({id:'t1',status:'active'});store.saveTerminal({id:'t1',status:'closed'});
  assert.deepEqual(store.terminal('t1'),{id:'t1',status:'closed'});assert.equal(store.terminals().length,1);
  store.saveArtifact({id:'f1',data:'AA=='});assert.deepEqual(store.artifact('f1'),{id:'f1',data:'AA=='});assert.equal(store.artifacts().length,1);
  assert.throws(()=>store.saveArtifact({id:'f1',data:'BB=='}));assert.equal(store.artifact('f1').data,'AA==');
 }finally{store.close();}
});
