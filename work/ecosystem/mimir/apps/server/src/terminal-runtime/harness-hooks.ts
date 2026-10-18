import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { claudeHookSettings } from "./hooks.js";
/** Lifecycle contracts adapted from Firstmate fm-spawn.sh at a24f4cb.
 * MIT, Copyright (c) 2026 Kun Chen; see third_party/firstmate/LICENSE.
 * Generated files belong to the session, never overwrite project or global settings.
 */
export function wireHarnessHooks(
  kind: string,
  argv: string[],
  node: string,
  hook: string,
  file: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  if (kind === "claude")
    argv.splice(1, 0, "--settings", JSON.stringify(claudeHookSettings(node, hook, file)));
  if (kind === "codex") argv.splice(1, 0, "-c", `notify=${JSON.stringify([node, hook, file])}`);
  if (kind === "devin") {
    const source =
      process.env["MIMIR_DEVIN_CONFIG"] ?? join(homedir(), ".config/devin/config.json");
    const settings = existsSync(source) ? JSON.parse(readFileSync(source, "utf8")) : {};
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw Error("Devin configuration must be an object");
    const hooks = settings.hooks ?? {};
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
      throw Error("Devin hooks must be an object");
    for (const [event, type] of Object.entries({
      UserPromptSubmit: "turn.start",
      Stop: "turn.end",
      SessionEnd: "turn.end",
    })) {
      const existing = hooks[event] ?? [];
      if (!Array.isArray(existing)) throw Error(`Devin ${event} hooks must be an array`);
      const command = [node, hook, file, JSON.stringify({ type })].map(quote).join(" ");
      hooks[event] = [...existing, { hooks: [{ type: "command", command, timeout: 5 }] }];
    }
    const destination = file + ".devin.json";
    writeFileSync(
      destination,
      JSON.stringify({
        ...settings,
        hooks,
        read_config_from: { ...settings.read_config_from, claude: false },
      }),
      { mode: 0o600 },
    );
    argv.splice(1, 0, "--config", destination);
  }
  if (kind === "commandcode") {
    const extension = file + ".mod.mjs";
    writeFileSync(
      extension,
      `import {spawnSync} from 'node:child_process';\nconst emit=type=>spawnSync(${JSON.stringify(node)},[${JSON.stringify(hook)},${JSON.stringify(file)},JSON.stringify({type})],{stdio:'ignore',timeout:5000});\nexport default function(cmd){cmd.on('run_start',()=>emit('turn.start'));cmd.on('run_end',()=>emit('turn.end'));cmd.hooks({onSessionEnd:()=>emit('turn.end')});}\n`,
      { mode: 0o600 },
    );
    argv.splice(1, 0, "--mod", extension);
  }
  if (kind === "gemini") {
    const command = `${quote(node)} ${quote(hook)} ${quote(file)}; printf '{}'`;
    const entry = { hooks: [{ type: "command", command, timeout: 5000 }] };
    const settings = file + ".gemini.json";
    writeFileSync(
      settings,
      JSON.stringify({ hooks: { BeforeAgent: [entry], AfterAgent: [entry], SessionEnd: [entry] } }),
      { mode: 0o600 },
    );
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settings;
  }
  const emit = `import {execFile} from 'node:child_process';\nconst emit=(type)=>new Promise(resolve=>execFile(${JSON.stringify(node)},[${JSON.stringify(hook)},${JSON.stringify(file)},JSON.stringify({type})],()=>resolve()));\n`;
  if (["pi", "pi-signed", "omp"].includes(kind)) {
    const extension = file + ".extension.mjs";
    const end =
      kind === "omp"
        ? `api.on('agent_end',async(event)=>{if(!event?.willContinue)await emit('turn.end');});`
        : `api.on('agent_settled',async(event,ctx)=>{if(ctx?.isIdle?.())await emit('turn.end');});`;
    writeFileSync(
      extension,
      emit + `export default function(api){api.on('agent_start',()=>emit('turn.start'));${end}}`,
      { mode: 0o600 },
    );
    argv.splice(1, 0, "-e", extension);
  }
  if (kind === "opencode") {
    const plugin = file + ".plugin.mjs";
    writeFileSync(
      plugin,
      emit +
        `export const MimirLifecycle=async()=>{let active=null;return {event:async({event})=>{const id=event.properties?.sessionID;const state=event.properties?.status?.type;if(event.type==='session.status'&&['busy','retry'].includes(state)){if(active===null)active=id;if(active===id)await emit('turn.start');}else if(id===active&&active!==null&&((event.type==='session.status'&&state==='idle')||event.type==='session.idle')){active=null;await emit('turn.end');}}};};`,
      { mode: 0o600 },
    );
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [pathToFileURL(plugin).href] });
  }
  return env;
}
