import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAuthToken } from "@sindri/server";
import { CliError, EXIT_CONFIG, EXIT_INFRA, dataDir, tokenPath } from "./env.js";

export interface InitResult {
  dataDir: string;
  configPath: string;
  tokenPath: string;
  tokenCreated: boolean;
}

export function init(env: NodeJS.ProcessEnv = process.env): InitResult {
  const dir = dataDir(env);
  const path = tokenPath(dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Read by the server and `sindri start`; environment variables override each key.
    const cfg = join(dir, "config.json");
    if (!existsSync(cfg)) {
      const config = { host: "127.0.0.1", port: 7800 };
      writeFileSync(cfg, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    }
    const before = existsSync(path) ? readFileSync(path, "utf8").trim() : null;
    // Same rules as the server: tightens modes, replaces a missing or too-short token.
    const { token } = ensureAuthToken(dir);
    return { dataDir: dir, configPath: cfg, tokenPath: path, tokenCreated: before !== token };
  } catch (e) {
    throw new CliError(`cannot initialise ${dir}: ${(e as Error).message}`, EXIT_INFRA);
  }
}

export function showToken(env: NodeJS.ProcessEnv = process.env): string {
  const path = tokenPath(dataDir(env));
  if (!existsSync(path)) {
    throw new CliError(`no auth token at ${path}; run \`sindri init\``, EXIT_CONFIG);
  }
  return readFileSync(path, "utf8").trim();
}
