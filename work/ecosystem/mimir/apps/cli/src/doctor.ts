import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dataDir } from "./env.js";

export type CheckStatus = "ok" | "fail" | "warn";
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  required: boolean;
}
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function versionAtLeast(
  v: [number, number, number],
  min: [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== min[i]!) return v[i]! > min[i]!;
  }
  return true;
}

function tryRun(cmd: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync(cmd, args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

function versioned(
  name: string,
  cmd: string,
  args: string[],
  min: [number, number, number] | null,
  required: boolean,
  env: NodeJS.ProcessEnv,
): DoctorCheck {
  const out = tryRun(cmd, args, env);
  const missing = required ? "fail" : "warn";
  if (out === null) return { name, status: missing, detail: `${cmd} not found on PATH`, required };
  const v = parseVersion(out);
  const shown = out.trim().split("\n")[0] ?? "";
  if (min === null) return { name, status: "ok", detail: shown, required };
  if (!v)
    return { name, status: missing, detail: `cannot parse version from "${shown}"`, required };
  const minText = min.join(".");
  return versionAtLeast(v, min)
    ? { name, status: "ok", detail: `${v.join(".")} (>= ${minText})`, required }
    : {
        name,
        status: missing,
        detail: `${v.join(".")} is older than required ${minText}`,
        required,
      };
}

export function doctor(env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const checks: DoctorCheck[] = [];
  const nodeV = parseVersion(process.versions.node) ?? [0, 0, 0];
  checks.push({
    name: "node",
    status: nodeV[0] >= 25 ? "ok" : "fail",
    detail: `${process.versions.node} (>= 25)`,
    required: true,
  });
  checks.push(versioned("pnpm", "pnpm", ["--version"], null, true, env));
  checks.push(versioned("git", "git", ["--version"], [2, 38, 0], true, env));
  checks.push(versioned("herdr", "herdr", ["--version"], [0, 9, 0], true, env));

  const sock = join(env["HOME"] || homedir(), ".config/herdr/sessions/mimir/herdr.sock");
  checks.push({
    name: "herdr-socket",
    status: existsSync(sock) ? "ok" : "warn",
    detail: existsSync(sock)
      ? `session "mimir" socket file present (existence only, not connected): ${sock}`
      : `session "mimir" not running (${sock} absent)`,
    required: false,
  });

  checks.push(versioned("gh", "gh", ["--version"], null, false, env));
  checks.push(versioned("claude", "claude", ["--version"], null, false, env));
  checks.push(versioned("codex", "codex", ["--version"], null, false, env));

  const dir = dataDir(env);
  let writable: boolean;
  try {
    let probe = dir;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    accessSync(probe, constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  checks.push({
    name: "data-dir",
    status: writable ? "ok" : "fail",
    detail: writable ? `${dir} writable` : `${dir} not writable`,
    required: true,
  });

  return { ok: checks.every((c) => !c.required || c.status === "ok"), checks };
}
