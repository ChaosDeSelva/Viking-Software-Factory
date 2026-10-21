import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { terminal, artifact } from '../../packages/providers/session.mjs';
import { AwsProvider } from '../../packages/providers/aws.mjs';
import { Simulator } from '../../packages/providers/simulator.mjs';
import { workerInput, actions } from '../../packages/contracts/worker.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function createApp({ database = ':memory:', provider = new Simulator() } = {}) {
  const store = new Store(database), streams = new Set();
  store.bind(provider.mode==='aws'?{mode:'aws',accountId:provider.config.accountId,region:provider.config.region,fleetId:provider.config.fleetId}:{mode:'simulation'});
  let providerError=null;
  const maxWorkers=provider.maxWorkers??5;
  const token = randomBytes(32).toString('hex');
  const snapshot = () => ({ mode: provider.mode, workers: store.list(), events: store.events(), maxWorkers, commands:store.commands(), terminals:store.terminals(), artifacts:store.artifacts().map(({data,...record})=>record), providerError, templates:provider.mode==='aws'?Object.keys(provider.config.templates):['node','python','general'], ...(provider.mode==='aws'?{accountId:provider.config.accountId,region:provider.config.region}: {}) });
  const broadcast = () => { for (const res of streams) res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`); };
  let queue = Promise.resolve();
  const serial = task => { const pending = queue.then(task); queue = pending.catch(()=>{}); return pending; };
  const expire = () => serial(async () => {
    let changed = false;
    if(provider.mode==='aws') {
      try {
        for(const worker of store.list().filter(w=>!['terminated','failed'].includes(w.state))) {
          const updated=await provider.inspect(worker);
          if(JSON.stringify(updated)!==JSON.stringify(worker)){store.save(updated,'AWS state reconciled.');changed=true;}
        }
        if(providerError){providerError=null;changed=true;}
      } catch(error){providerError=error.message;changed=true;}
      if(changed)broadcast();return;
    }
    for (const worker of store.list()) if (worker.state !== 'terminated' && Date.parse(worker.expiresAt) <= Date.now()) {
      store.save(await provider.transition(worker, 'terminate'), 'Simulated lifetime expired; worker terminated.'); changed = true;
    }
    if (changed) broadcast();
  });
  let polling=false;
  const timer = setInterval(()=>{if(polling)return;polling=true;expire().catch(()=>{}).finally(()=>{polling=false;});}, provider.mode==='aws'?15000:1000); timer.unref();
  const heartbeat = setInterval(()=>{ for (const res of streams) res.write(': heartbeat\n\n'); },15000); heartbeat.unref();
  const server = createServer(async (req,res) => {
    const reply = (code, data) => { res.writeHead(code, { 'Content-Type':'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) || req.headers['sec-fetch-site'] === 'cross-site') return reply(403,{error:'Local same-origin access only.'});
    const url = new URL(req.url, `http://${expectedHost}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname === '/api/session') return reply(200,{token});
      if (req.method !== 'GET') {
        const received = Buffer.from(String(req.headers['x-skidbladnir-token'] || ''));
        const secret = Buffer.from(token);
        if (received.length !== secret.length || !timingSafeEqual(received, secret)) return reply(403,{error:'Refresh the page to restore your local session.'});
        if (!String(req.headers['content-type']).startsWith('application/json')) return reply(415,{error:'JSON required.'});
      }
      try {
        if (req.method === 'GET' && url.pathname === '/api/snapshot') { await expire(); return reply(200,snapshot()); }
        if (req.method === 'GET' && url.pathname === '/api/events') {
          res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});
          streams.add(res); res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`); req.on('close',()=>streams.delete(res)); return;
        }
        const readiness=url.pathname.match(/^\/api\/workers\/([^/]+)\/readiness$/);
        if(req.method==='GET' && readiness){const worker=store.get(readiness[1]);if(!worker)return reply(404,{error:'Worker not found.'});return reply(200,provider.ready?await provider.ready(worker):{ready:worker.state==='running',state:worker.state});}
        const download=url.pathname.match(/^\/api\/artifacts\/([^/]+)$/);
        if(req.method==='GET' && download){const saved=store.artifact(download[1]);if(!saved)return reply(404,{error:'Artifact not found.'});res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition','attachment; filename="artifact.bin"');res.end(Buffer.from(saved.data,'base64'));return;}
        if (req.method !== 'POST') return reply(404,{error:'Route not found.'});
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body)>8192) return reply(413,{error:'Request too large.'}); }
        const input = JSON.parse(body);
        await serial(async () => {
          if (url.pathname === '/api/workers') {
            const spec=workerInput(input);
            const key=String(req.headers['idempotency-key']??'');
            if(provider.mode==='aws'&&!/^[a-zA-Z0-9-]{8,100}$/.test(key))throw Error('A stable idempotency key is required for AWS launch.');
            const fingerprint=createHash('sha256').update(JSON.stringify(spec)).digest('hex');
            const prior=key&&store.list().find(w=>w.requestKey===key);
            if(prior){if(prior.fingerprint!==fingerprint)throw Error('Launch key reused with different input.');return reply(200,prior);}
            if(store.list().filter(w=>!['terminated','failed'].includes(w.state)).length>=maxWorkers)return reply(409,{error:'Worker limit reached. Terminate a worker first.'});
            let worker=provider.prepare?.(spec);
            if(worker){worker={...worker,requestKey:key,fingerprint};store.save(worker,'AWS launch reserved. Reconcile uncertain outcomes before retrying.');broadcast();}
            try {worker=await provider.create(spec,worker);}
            catch(error){if(worker){store.save({...worker,state:error.notSubmitted?'failed':'unknown'},error.notSubmitted?'AWS preflight failed before launch.':'AWS launch outcome unknown. Reconcile before launching again.');broadcast();}throw error;}
            store.save(worker,provider.mode==='aws'?'AWS launch accepted. Independent expiration applies.':'Simulated worker created. No cloud resources or commands were started.'); broadcast(); return reply(201,worker);
          }
          const sessionRoute=url.pathname.match(/^\/api\/workers\/([^/]+)\/terminals(?:\/([^/]+)\/(resume|close))?$/);
          if(sessionRoute){if(provider.mode!=='aws')throw Error('Terminals require AWS.');const worker=store.get(sessionRoute[1]);if(!worker)throw Error('Worker not found.');const result=await terminal(provider,worker,sessionRoute[2]?store.terminal(sessionRoute[2]):undefined,sessionRoute[3]??'start');store.saveTerminal(result.record);store.save(worker,'SSM terminal '+(sessionRoute[3]??'start')+' accepted.');broadcast();return reply(200,result);}
          const artifactRoute=url.pathname.match(/^\/api\/workers\/([^/]+)\/artifacts$/);
          if(artifactRoute){if(provider.mode!=='aws')throw Error('Artifact collection requires AWS.');const worker=store.get(artifactRoute[1]);if(!worker)throw Error('Worker not found.');const collected=await artifact(provider,worker,input.path);store.saveArtifact(collected);store.save(worker,'Artifact collected and verified: '+collected.path);broadcast();const {data,...metadata}=collected;return reply(201,metadata);}
          const execution=url.pathname.match(/^\/api\/workers\/([^/]+)\/commands$/);
          if(execution){
            if(!provider.execute)throw Error('Remote execution requires an AWS provider.');
            const worker=store.get(execution[1]);if(!worker)return reply(404,{error:'Worker not found.'});
            const key=String(req.headers['idempotency-key']??'');if(!/^[a-zA-Z0-9-]{8,100}$/.test(key))throw Error('Stable command request key required.');
            const prior=store.command(key),fingerprint=createHash('sha256').update(JSON.stringify([worker.id,input.command])).digest('hex');
            if(prior){if(prior.fingerprint!==fingerprint)throw Error('Command request key reused.');return reply(200,prior);}
            let record={id:key,workerId:worker.id,fingerprint,status:'Unknown',createdAt:new Date().toISOString()};store.saveCommand(record);
            try {record={...record,...await provider.execute(worker,input.command)};store.saveCommand(record);store.save(worker,'SSM command submitted.');broadcast();return reply(202,record);}
            catch(error){store.save(worker,'SSM command outcome unknown. It will not be automatically resent.');broadcast();throw error;}
          }
          const commandAction=url.pathname.match(/^\/api\/commands\/([^/]+)\/(refresh|cancel)$/);
          if(commandAction){
            const record=store.command(commandAction[1]);if(!record?.commandId)throw Error('No confirmed remote command identity. Inspect AWS before retrying.');
            const worker=store.get(record.workerId);const updated={...record,...await provider.command(worker,record,commandAction[2]==='cancel')};
            store.saveCommand(updated);broadcast();return reply(200,updated);
          }
          const match = url.pathname.match(/^\/api\/workers\/([^/]+)\/(start|stop|reboot|terminate)$/);
          if (!match || !actions.has(match[2])) return reply(404,{error:'Route not found.'});
          const worker = store.get(match[1]); if (!worker) return reply(404,{error:'Worker not found.'});
          const updated = await provider.transition(worker,match[2]); store.save(updated,`${provider.mode==='aws'?'AWS':'Simulated'} ${match[2]} requested.`); broadcast(); return reply(200,updated);
        });
      } catch (error) { if (!res.headersSent) reply(400,{error:error.message}); }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405,{error:'Method not allowed.'});
    let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { return reply(400,{error:'Invalid path.'}); }
    const base = resolve(root,'dist'); const path = resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(base+'/')) return reply(403,{error:'Invalid path.'});
    try {
      const content = readFileSync(path);
      res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(path)] || 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { reply(404,{error:'File not found. Run npm run build before starting.'}); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  const close = async () => { clearInterval(timer); clearInterval(heartbeat); for(const res of streams) res.end(); await queue; await new Promise(r=>server.close(r)); store.close(); };
  return { server, close, snapshot, store, expire };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.env.SKIDBLADNIR_DATA_DIR || resolve(root,'.data')); mkdirSync(dir,{recursive:true,mode:0o700}); chmodSync(dir,0o700);
  const configPath=process.env.SKIDBLADNIR_AWS_CONFIG;
  const provider=configPath?new AwsProvider(JSON.parse(readFileSync(resolve(configPath),'utf8'))):new Simulator();
  const app = createApp({database:resolve(dir,provider.mode==='aws'?'aws-'+provider.config.fleetId+'.sqlite':'skidbladnir.sqlite'),provider});
  app.server.listen(Number(process.env.PORT || 4380),'127.0.0.1',()=>console.log(`Skidbladnir ${provider.mode}: http://127.0.0.1:${app.server.address().port}`));
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>app.close().then(()=>process.exit(0)));
}
