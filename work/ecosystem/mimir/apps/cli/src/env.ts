import { homedir } from "node:os";
import { join } from "node:path";

export const EXIT_OK = 0;
export const EXIT_CONFIG = 2;
export const EXIT_INFRA = 3;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["MIMIR_DATA_DIR"] || join(env["HOME"] || homedir(), ".mimir");
}

export const tokenPath = (dir: string): string => join(dir, "auth-token");
export const dbPath = (dir: string): string => join(dir, "mimir.db");
