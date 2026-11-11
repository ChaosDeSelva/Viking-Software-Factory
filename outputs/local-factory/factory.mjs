import { readFileSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const ecosystem = process.env.FACTORY_ECOSYSTEM_ROOT || fileURLToPath(new URL('../../work/ecosystem/', import.meta.url));
const { startMimir } = await import(pathToFileURL(join(ecosystem,'mimir/apps/server/dist/start.js')).href);
const { startServer, secretStoreFor } = await import(pathToFileURL(join(ecosystem,'sindri/apps/server/dist/boot.js')).href);
const { SettingsStore } = await import(pathToFileURL(join(ecosystem,'sindri/apps/server/dist/settings.js')).href);
const { startHeimdall } = await import('../heimdall/apps/server/main.mjs');
const root = process.env.FACTORY_DATA_DIR ? resolve(process.env.FACTORY_DATA_DIR) : fileURLToPath(new URL('../../work/local-factory/daily/', import.meta.url));
const runtimeChoice = process.env.MIMIR_RUNTIME || 'fleet';
mkdirSync(root, {recursive:true,mode:0o700});
const fleetConfig = process.env.MIMIR_FLEET_CONFIG || join(root,'fleet.json');
if(runtimeChoice === 'fleet' && !existsSync(fleetConfig)) writeFileSync(fleetConfig,JSON.stringify({version:1,workers:[{id:'local-mac',runtime:'cli',capacity:2,agentKinds:['codex','claude','opencode','gemini','pi']}]},null,2),{mode:0o600});
let mimir, sindri, heimdall, stopping = false;
async function close() {
 if(process.env.FACTORY_ACCESS_FILE && existsSync(process.env.FACTORY_ACCESS_FILE)) unlinkSync(process.env.FACTORY_ACCESS_FILE);
 if(stopping)return; stopping=true;
 // One service failing to close must not leave the others (and Mimir's agent processes) running.
 for(const service of [heimdall,sindri,mimir]){ try{ await service?.close(); }catch(error){ console.error('Shutdown error: '+error.message); } }
}
// SIGHUP: closing the Terminal window must stop the services too.
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>void close().then(()=>process.exit(0)));
try {
 const bundled='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
 const codex=process.env.MIMIR_CODEX_BIN || (existsSync(bundled)?bundled:'codex');
 const claude=process.env.MIMIR_CLAUDE_BIN || 'claude';
 // A slow CLI on a busy machine is not a signed-out CLI: say which it was.
 const slow=error=>error?.code==='ETIMEDOUT'||error?.signal==='SIGTERM';
 try { if(runtimeChoice !== 'ssh') execFileSync(codex,['login','status'],{stdio:'pipe',timeout:30000}); }
 catch(error) { throw new Error(slow(error)?'Codex did not answer its login check within 30 seconds. Try starting the factory again.':'Codex is unavailable or signed out. Open Codex and sign in, then restart the factory.'); }
 try { if(!JSON.parse(execFileSync(claude,['auth','status'],{encoding:'utf8',stdio:'pipe',timeout:30000})).loggedIn)throw Error(); }
 catch(error) { throw new Error(slow(error)?'Claude Code did not answer its login check within 30 seconds. Try starting the factory again.':'Claude Code is unavailable or signed out. Run claude auth login in Terminal, then restart the factory.'); }
 console.log('Planner login and applicable local agent login checks passed. Runtime: '+runtimeChoice);
 mimir = await startMimir({...process.env,MIMIR_CODEX_BIN:codex,MIMIR_CLAUDE_BIN:claude,MIMIR_HOST:'127.0.0.1',MIMIR_PORT:process.env.MIMIR_PORT || '7700',MIMIR_RUNTIME:runtimeChoice,MIMIR_FLEET_CONFIG:fleetConfig,MIMIR_DATA_DIR:join(root,'mimir'),MIMIR_WORKTREE_ROOT:join(root,'worktrees'),MIMIR_LOG_LEVEL:'warn'});
 const mtoken=mimir.auth.token;
 let pairing;
 // Connector credentials (Linear, Jira) stay in the operator's own store: Keychain on macOS, or SINDRI_SECRET_* with SINDRI_SECRET_STORE=env.
 const operatorSecrets=secretStoreFor(process.env);
 sindri=await startServer({...process.env,SINDRI_HOST:'127.0.0.1',SINDRI_PORT:process.env.SINDRI_PORT || '4310',SINDRI_DATA_DIR:join(root,'sindri')},{webDist:join(ecosystem,'sindri/apps/web/dist'),logLevel:'warn',overrides:{secrets:{get:async name=>name==='local.mimir.token'?mtoken:operatorSecrets.get(name)},approval:{onPairingCode:code=>{pairing=code;}}}});
 const settings=new SettingsStore(sindri.db,()=>new Date());
 const saved=settings.get();
 settings.put({...saved,...(saved.provider==='null'?{provider:'claude-cli',model:'default',localOnly:false,workerAgent:'codex',reviewerAgent:'claude',brokkrEnabled:true}:{}),mimirUrl:`http://127.0.0.1:${process.env.MIMIR_PORT || '7700'}`,mimirTokenSecret:'local.mimir.token'});
 console.log('Local Software Factory: '+sindri.url);
 console.log('Codex implements; Claude Code plans and reviews. Change agents in Settings.');
 if(!process.env.FACTORY_QUIET_AUTH)console.log('Access token (paste into the browser): '+readFileSync(sindri.tokenPath,'utf8').trim());
 if(!process.env.FACTORY_QUIET_AUTH)console.log('Approval pairing code (for approving your plans): '+pairing);
 heimdall = await startHeimdall({env:{HEIMDALL_PORT:process.env.HEIMDALL_PORT || '4320',HEIMDALL_DATA_DIR:join(root,'heimdall'),MIMIR_URL:`http://127.0.0.1:${process.env.MIMIR_PORT || '7700'}`,MIMIR_TOKEN:mtoken,SINDRI_URL:sindri.url,SINDRI_TOKEN:readFileSync(sindri.tokenPath,'utf8').trim()}});
 if(process.env.FACTORY_ACCESS_FILE) writeFileSync(process.env.FACTORY_ACCESS_FILE,JSON.stringify({heimdallToken:heimdall.token,operatorCode:heimdall.operatorCode,sindriPairingCode:pairing}),{mode:0o600});
 console.log('Heimdall command center: '+heimdall.url);
 if(!process.env.FACTORY_QUIET_AUTH)console.log('Heimdall access token: '+heimdall.token+'\nHeimdall operator code: '+heimdall.operatorCode);
 console.log('Keep this terminal open. Press Ctrl+C to stop all three services.');
 if(!process.env.FACTORY_NO_OPEN)spawn('open',[heimdall.url],{stdio:'ignore'});
} catch(error) { console.error(error.message); await close(); process.exitCode=1; }
