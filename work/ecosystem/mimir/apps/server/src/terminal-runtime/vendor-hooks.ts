import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
export type ManagedPlugin = { path: string; key: string; digest: string; created: boolean };
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Vendor configuration must be an object");
  return value as Record<string, unknown>;
}
export function wireRovo(
  argv: string[],
  node: string,
  helper: string,
  file: string,
  source = process.env.MIMIR_ROVO_CONFIG ?? join(homedir(), ".rovodev/config.yml"),
) {
  const raw = existsSync(source) ? readFileSync(source, "utf8") : "{}";
  if (Buffer.byteLength(raw) > 1024 * 1024) throw Error("Rovo configuration exceeds 1 MiB");
  const settings = object(parse(raw, { maxAliasCount: 100 }));
  const hookSettings = settings.eventHooks === undefined ? {} : object(settings.eventHooks);
  const previous = hookSettings.events ?? [];
  if (!Array.isArray(previous)) throw Error("Rovo eventHooks.events must be an array");
  const names = ["on_complete", "on_error", "on_tool_permission"];
  const events = previous.map((entry) => ({ ...object(entry) }));
  for (const name of names) {
    let entry = events.find((value) => value.name === name);
    if (!entry) {
      entry = { name, commands: [] };
      events.push(entry);
    }
    const commands = entry.commands ?? [];
    if (!Array.isArray(commands)) throw Error("Rovo event hook commands must be an array");
    entry.commands = [
      ...commands,
      { command: [node, helper, file, "rovo", name].map(quote).join(" ") },
    ];
  }
  const destination = file + ".rovo.yml";
  if (
    existsSync(destination) &&
    (!lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink())
  )
    throw Error("Refusing redirected Rovo session configuration");
  const temporary = destination + "." + randomUUID();
  writeFileSync(temporary, stringify({ ...settings, eventHooks: { ...hookSettings, events } }), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    renameSync(temporary, destination);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  // Insert after 'acli rovodev run', retaining existing permission and account settings.
  argv.splice(3, 0, "--config-file", destination);
}
export function wireAgy(
  workspace: string,
  node: string,
  helper: string,
  file: string,
): ManagedPlugin {
  const key = "mimir-" + digest(file).slice(0, 20);
  const directory = join(workspace, ".agents");
  if (
    existsSync(directory) &&
    (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
  )
    throw Error("Refusing redirected AGY hook directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "hooks.json");
  const created = !existsSync(path);
  if (!created && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw Error("Refusing redirected AGY hook file");
  const raw = created ? "{}" : readFileSync(path, "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024) throw Error("AGY hooks exceed 1 MiB");
  const settings = object(JSON.parse(raw));
  if (key in settings) throw Error("AGY session hooks already exist; reconcile before relaunch");
  const hooks: Record<string, unknown> = {};
  for (const event of ["SessionStart", "PreInvocation", "Stop"])
    hooks[event] = [
      {
        type: "command",
        command: [node, helper, file, "agy", event].map(quote).join(" "),
        timeout: 5,
      },
    ];
  if (created) {
    const exclude = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { cwd: workspace, encoding: "utf8", timeout: 5000 },
    ).trim();
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.split("\n").includes("/.agents/hooks.json")) {
      mkdirSync(dirname(exclude), { recursive: true });
      writeFileSync(exclude, current + "\n/.agents/hooks.json\n");
    }
  }
  const temporary = path + "." + key;
  writeFileSync(temporary, JSON.stringify({ ...settings, [key]: hooks }, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
  return { path, key, digest: digest(JSON.stringify(hooks)), created };
}
/** Preserve operator changes and other sessions when removing instrumentation. */
export function cleanupPlugin(plugin: ManagedPlugin) {
  if (
    !existsSync(plugin.path) ||
    !lstatSync(plugin.path).isFile() ||
    lstatSync(plugin.path).isSymbolicLink() ||
    lstatSync(dirname(plugin.path)).isSymbolicLink()
  )
    return;
  let settings: Record<string, unknown>;
  try {
    settings = object(JSON.parse(readFileSync(plugin.path, "utf8")));
  } catch {
    return;
  } // An operator may be editing the file; preserve it untouched.
  if (!(plugin.key in settings) || digest(JSON.stringify(settings[plugin.key])) !== plugin.digest)
    return;
  delete settings[plugin.key];
  if (plugin.created && Object.keys(settings).length === 0) unlinkSync(plugin.path);
  else {
    const temporary = plugin.path + "." + plugin.key;
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, plugin.path);
  }
}
export function vendorEvent(
  kind: string,
  name: string,
  payload: Record<string, unknown>,
): string | null {
  if (kind === "agy") {
    if (name === "Stop")
      return payload.fullyIdle === true
        ? "turn.end"
        : payload.fullyIdle === false
          ? "turn.start"
          : null;
    return ["SessionStart", "PreInvocation"].includes(name) ? "turn.start" : null;
  }
  if (kind === "rovo") {
    if (["on_complete", "on_session_end"].includes(name)) return "turn.end";
    if (name === "on_error") return "agent.error";
    if (name === "on_tool_permission") return "PermissionRequest";
    if (["on_user_prompt", "on_tool_start", "on_tool_end", "on_session_start"].includes(name))
      return "turn.start";
  }
  return null;
}
