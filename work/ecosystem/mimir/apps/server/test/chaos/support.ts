import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EventEnvelope } from "@mimir/protocol";
import type { SpawnMimirOptions } from "@mimir/testing";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, "../..");
/** The real server entry point. */
export const MAIN = join(SERVER_ROOT, "src/main.ts");
export const fixture = (name: string) => join(here, "fixtures", name);

/** Runs the TypeScript sources directly in a plain `node` process (so SIGKILL hits the server). */
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
export const TS_NODE_ARGS = ["--import", tsxLoader] as const;

export function serverSpawn(
  entry: string,
  dataDir: string,
  env: Record<string, string> = {},
): SpawnMimirOptions {
  return { entry, dataDir, nodeArgs: TS_NODE_ARGS, cwd: SERVER_ROOT, env };
}

export function tempDataDir(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-chaos-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Every event via `GET /v1/events`, following `nextCursor` until the end. */
export async function readAllEvents(
  url: string,
  token: string,
  query: Record<string, string> = {},
): Promise<{ events: EventEnvelope[]; cursors: string[] }> {
  const events: EventEnvelope[] = [];
  const cursors: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const params = new URLSearchParams({ limit: "1000", ...query });
    if (cursor !== null) params.set("cursor", cursor);
    const res = await fetch(`${url}/v1/events?${params}`, { headers: bearer(token) });
    if (res.status !== 200) throw new Error(`GET /v1/events ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as {
      events: EventEnvelope[];
      nextCursor: string | null;
      lastCursor: string;
    };
    events.push(...page.events);
    cursors.push(page.lastCursor);
    if (page.nextCursor === null) return { events, cursors };
    cursor = page.nextCursor;
  }
}
