import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimeSessionState } from "@mimir/protocol";

/**
 * What Mimir knows about a session it started in HerdR. Bind on `paneId` +
 * `cwd` + the `MIMIR_SESSION_ID` env marker + agent session id when reported;
 * `terminalId` changes on every HerdR stop/start, so it is display-only
 * (`launchTerminalId` remembers the terminal the process was launched in, to
 * detect restarts).
 */
export interface SessionBinding {
  sessionId: string;
  idempotencyKey: string;
  paneId: string;
  workspaceId: string;
  cwd: string;
  agentKind: string;
  agentSessionId?: string;
  launchTerminalId?: string;
  /** Random per-session nonce in the shell sentinel `MIMIR_DONE:<id>:<nonce>:<exit>`. */
  sentinelNonce?: string;
  /** Persisted terminal state (stopped/completed/failed) once reached. */
  finalState?: RuntimeSessionState;
  exitCode?: number;
  lost?: boolean;
  createdAt: string;
}

export interface BindingStore {
  get(idempotencyKey: string): Promise<SessionBinding | undefined>;
  getBySessionId(sessionId: string): Promise<SessionBinding | undefined>;
  list(): Promise<SessionBinding[]>;
  /** Insert or replace, keyed by `idempotencyKey`. */
  put(binding: SessionBinding): Promise<void>;
}

export class MemoryBindingStore implements BindingStore {
  protected readonly byKey = new Map<string, SessionBinding>();

  get(idempotencyKey: string): Promise<SessionBinding | undefined> {
    const b = this.byKey.get(idempotencyKey);
    return Promise.resolve(b ? { ...b } : undefined);
  }

  getBySessionId(sessionId: string): Promise<SessionBinding | undefined> {
    for (const b of this.byKey.values())
      if (b.sessionId === sessionId) return Promise.resolve({ ...b });
    return Promise.resolve(undefined);
  }

  list(): Promise<SessionBinding[]> {
    return Promise.resolve([...this.byKey.values()].map((b) => ({ ...b })));
  }

  put(binding: SessionBinding): Promise<void> {
    this.byKey.set(binding.idempotencyKey, { ...binding });
    return Promise.resolve();
  }
}

/** JSON file store (`{bindings: {[idempotencyKey]: SessionBinding}}`), written atomically. */
export class JsonFileBindingStore implements BindingStore {
  private cache: Map<string, SessionBinding> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  private async load(): Promise<Map<string, SessionBinding>> {
    if (this.cache) return this.cache;
    let parsed: { bindings?: Record<string, SessionBinding> } = {};
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as typeof parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.cache = new Map(Object.entries(parsed.bindings ?? {}));
    return this.cache;
  }

  async get(idempotencyKey: string): Promise<SessionBinding | undefined> {
    const b = (await this.load()).get(idempotencyKey);
    return b ? { ...b } : undefined;
  }

  async getBySessionId(sessionId: string): Promise<SessionBinding | undefined> {
    for (const b of (await this.load()).values()) if (b.sessionId === sessionId) return { ...b };
    return undefined;
  }

  async list(): Promise<SessionBinding[]> {
    return [...(await this.load()).values()].map((b) => ({ ...b }));
  }

  async put(binding: SessionBinding): Promise<void> {
    const map = await this.load();
    map.set(binding.idempotencyKey, { ...binding });
    const body = JSON.stringify({ bindings: Object.fromEntries(map) }, null, 2) + "\n";
    this.writing = this.writing.then(async () => {
      // The data dir also holds the operator token: never create it world-readable (audit L6).
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body, { mode: 0o600 });
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, this.filePath);
    });
    await this.writing;
  }
}

/** `MIMIR_DATA_DIR/herdr-bindings.json`, with `MIMIR_DATA_DIR` defaulting to `~/.mimir`. */
export function defaultBindingsPath(env: Record<string, string | undefined> = process.env): string {
  const dataDir = env.MIMIR_DATA_DIR || path.join(os.homedir(), ".mimir");
  return path.join(dataDir, "herdr-bindings.json");
}
