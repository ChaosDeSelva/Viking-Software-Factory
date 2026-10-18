import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT_CONFIG, EXIT_INFRA, dataDir, tokenPath } from "./env.js";

export interface InitResult {
  dataDir: string;
  tokenPath: string;
  tokenCreated: boolean;
}

export function init(env: NodeJS.ProcessEnv = process.env): InitResult {
  const dir = dataDir(env);
  const path = tokenPath(dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cfg = join(dir, "config.json");
    if (!existsSync(cfg)) {
      const config = { host: "127.0.0.1", port: 7700, dataDir: dir, herdrSession: "mimir" };
      writeFileSync(cfg, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    }
    if (existsSync(path)) {
      chmodSync(path, 0o600);
      return { dataDir: dir, tokenPath: path, tokenCreated: false };
    }
    writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    return { dataDir: dir, tokenPath: path, tokenCreated: true };
  } catch (e) {
    throw new CliError(`cannot initialise ${dir}: ${(e as Error).message}`, EXIT_INFRA);
  }
}

export function showToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["MIMIR_AUTH_TOKEN"];
  if (fromEnv) return fromEnv;
  const path = tokenPath(dataDir(env));
  if (!existsSync(path)) {
    throw new CliError(`no auth token at ${path}; run \`mimir init\``, EXIT_CONFIG);
  }
  return readFileSync(path, "utf8").trim();
}
