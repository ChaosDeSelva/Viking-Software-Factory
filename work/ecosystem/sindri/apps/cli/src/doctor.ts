import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase } from "@sindri/knowledge";
import { readConfigFile, secretStoreFor } from "@sindri/server";
import { dataDir, dbPath } from "./env.js";

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

/** Mimir protocol major this Sindri build speaks (see docs/compatibility.md). */
export const SUPPORTED_MIMIR_PROTOCOL = 1;

export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

function versionAtLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (v[i]! !== min[i]!) return v[i]! > min[i]!;
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

interface StoredSettings {
  localOnly?: boolean;
  provider?: string;
  apiKeySecret?: string;
  mimirUrl?: string;
}

/** Read the persisted settings without writing anything; missing db or table means defaults. */
function readSettings(env: NodeJS.ProcessEnv): StoredSettings {
  const file = dbPath(dataDir(env));
  if (!existsSync(file)) return {};
  try {
    const db = openDatabase(file);
    try {
      const row = db.prepare("SELECT settings_json FROM server_settings WHERE id = 1").get() as
        { settings_json: string } | undefined;
      return row ? (JSON.parse(row.settings_json) as StoredSettings) : {};
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

/** Providers that run locally and need no key. */
const KEYLESS_PROVIDERS = new Set(["null", "fake", "codex-cli", "claude-cli"]);

/** The URL without userinfo, for display (review m6). */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "(invalid URL)";
  }
}

async function providerKeyCheck(
  settings: StoredSettings,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  const name = "provider-key";
  const provider = settings.provider ?? "null";
  if (KEYLESS_PROVIDERS.has(provider) && settings.provider !== undefined)
    return { name, status: "ok", detail: `provider ${provider} needs no key`, required: false };
  if (!settings.apiKeySecret)
    return {
      name,
      status: "warn",
      detail: `not configured (provider ${settings.provider ?? "null"}); set provider and a key handle in Settings`,
      required: false,
    };
  const handle = settings.apiKeySecret;
  let value: string | undefined;
  try {
    value = await secretStoreFor(env).get(handle);
  } catch {
    value = undefined;
  }
  // Only presence is reported; the value is never read into output.
  return value
    ? { name, status: "ok", detail: `key "${handle}" present in the secret store`, required: false }
    : {
        name,
        status: "warn",
        detail: `key "${handle}" absent from the secret store`,
        required: false,
      };
}

async function mimirCheck(settings: StoredSettings, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const name = "mimir";
  const raw = env["SINDRI_MIMIR_URL"] || settings.mimirUrl;
  if (!raw)
    return { name, status: "warn", detail: "not configured (no Mimir URL)", required: false };
  const url = displayUrl(raw);
  // Credentials never travel in the URL; the token goes in the Authorization header.
  const target = (() => {
    try {
      return new URL("/v1/capabilities", url);
    } catch {
      return null;
    }
  })();
  if (!target) return { name, status: "fail", detail: "invalid Mimir URL", required: true };
  if (
    settings.localOnly !== false &&
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  )
    return { name, status: "warn", detail: "Mimir target blocked by local-only", required: false };
  const headers: Record<string, string> = {};
  const token = env["MIMIR_AUTH_TOKEN"];
  if (token) headers["authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(target, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    return {
      name,
      status: "warn",
      detail: `unreachable at ${url}: ${(e as Error).message}`,
      required: false,
    };
  }
  if (res.status === 401 || res.status === 403)
    return {
      name,
      status: "warn",
      detail: `reachable at ${url} but capabilities needs a token (set MIMIR_AUTH_TOKEN)`,
      required: false,
    };
  let body: { serverVersion?: unknown; protocolVersion?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* handled below */
  }
  if (!res.ok || typeof body.protocolVersion !== "number")
    return {
      name,
      status: "fail",
      detail: `incompatible: ${url} did not return a valid capabilities response (HTTP ${res.status})`,
      required: true,
    };
  if (body.protocolVersion !== SUPPORTED_MIMIR_PROTOCOL)
    return {
      name,
      status: "fail",
      detail: `incompatible: server protocol ${body.protocolVersion}, Sindri supports ${SUPPORTED_MIMIR_PROTOCOL}`,
      required: true,
    };
  return {
    name,
    status: "ok",
    detail: `${url} protocol ${body.protocolVersion}, server ${String(body.serverVersion ?? "unknown")}`,
    required: false,
  };
}

export async function doctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeV = parseVersion(process.versions.node) ?? [0, 0, 0];
  checks.push({
    name: "node",
    status: nodeV[0] >= 25 ? "ok" : "fail",
    detail: `${process.versions.node} (>= 25)`,
    required: true,
  });
  const gitOut = tryRun("git", ["--version"], env);
  const gitV = gitOut ? parseVersion(gitOut) : null;
  checks.push(
    gitOut === null
      ? { name: "git", status: "fail", detail: "git not found on PATH", required: true }
      : gitV && versionAtLeast(gitV, [2, 38, 0])
        ? { name: "git", status: "ok", detail: `${gitV.join(".")} (>= 2.38.0)`, required: true }
        : {
            name: "git",
            status: "fail",
            detail: `git older than 2.38.0 or unparseable`,
            required: true,
          },
  );

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
    detail: `${dir} ${writable ? "writable" : "not writable"}`,
    required: true,
  });

  let configDetail = "config.json absent (defaults apply)";
  let configOk = true;
  try {
    const file = readConfigFile(dir);
    if (Object.keys(file).length > 0)
      configDetail = `config.json valid (${Object.keys(file).join(", ")})`;
  } catch (e) {
    configOk = false;
    configDetail = (e as Error).message;
  }
  checks.push({
    name: "config",
    status: configOk ? "ok" : "fail",
    detail: configDetail,
    required: true,
  });

  const settings = readSettings(env);
  checks.push(await providerKeyCheck(settings, env));
  checks.push(await mimirCheck(settings, env));
  return { ok: checks.every((c) => !c.required || c.status === "ok"), checks };
}
