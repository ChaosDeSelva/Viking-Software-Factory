import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { run } from "../src/run.js";

export const FIXTURES = resolve(import.meta.dirname, "fixtures");
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: <T = Record<string, unknown>>() => T;
}

export function tmp(prefix = "brokkr-cli-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** One Brokkr home per fixture repo, so runs written by `verify` are found by `report`/`runs`. */
const HOMES = new Map<string, string>();

export function homeFor(repo: string): string {
  let home = HOMES.get(repo);
  if (!home) {
    home = tmp("brokkr-home-");
    HOMES.set(repo, home);
  }
  return home;
}

function homeFromArgs(args: readonly string[]): string | undefined {
  const i = args.indexOf("--cwd");
  const cwd = i >= 0 ? args[i + 1] : undefined;
  return cwd !== undefined ? HOMES.get(cwd) : undefined;
}

/** Copy the React fixture into a fresh temp repo. */
export function reactRepo(): string {
  const dir = join(tmp(), "app");
  cpSync(join(FIXTURES, "react-vite-app"), dir, { recursive: true });
  cpSync(join(FIXTURES, "task.json"), join(dir, "task.json"));
  return dir;
}

export function emptyRepo(): string {
  const dir = join(tmp(), "repo");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function cli(
  args: string[],
  options: {
    home?: string;
    stdinText?: string;
    isTTY?: boolean;
    signal?: AbortSignal;
    env?: Record<string, string>;
  } = {},
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const stdin = new PassThrough();
  if (options.stdinText !== undefined) stdin.end(options.stdinText);
  const code = await run(args, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {
      BROKKR_HOME: options.home ?? homeFromArgs(args) ?? tmp("brokkr-home-"),
      BROKKR_LOG_LEVEL: "silent",
      ...options.env,
    },
    stdin,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    code,
    stdout,
    stderr,
    json: <T>() => JSON.parse(stdout) as T,
  };
}
