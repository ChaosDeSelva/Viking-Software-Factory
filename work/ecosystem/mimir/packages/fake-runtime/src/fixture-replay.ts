import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MimirError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionSpec,
} from "@mimir/protocol";

/** Maps one recorded NDJSON line to a RuntimeEvent, or null to skip it. */
export type Normalizer = (line: string) => RuntimeEvent | null;

export function herdrFixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/herdr/${name}`, import.meta.url));
}

export interface FixtureReplayOptions {
  lines: readonly string[];
  normalize: Normalizer;
  /** 0 = instant; 1 = recorded pace (by `t_ms`); 2 = twice as fast. */
  speed?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tMs(line: string): number | undefined {
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v === "object" && v !== null && "t_ms" in v && typeof v.t_ms === "number")
      return v.t_ms;
  } catch {
    // not JSON; no timing information
  }
  return undefined;
}

/**
 * Replays recorded runtime event lines to subscribers. It only emits events;
 * session operations are unsupported.
 */
export class FixtureReplayRuntime implements RuntimeAdapter {
  private readonly lines: string[];
  private readonly normalize: Normalizer;
  private readonly speed: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private handlers = new Set<(e: RuntimeEvent) => void>();

  constructor(options: FixtureReplayOptions) {
    this.lines = options.lines.filter((l) => l.trim() !== "");
    this.normalize = options.normalize;
    this.speed = options.speed ?? 0;
    this.sleep = options.sleep ?? realSleep;
  }

  static fromFile(path: string, normalize: Normalizer, speed = 0): FixtureReplayRuntime {
    return new FixtureReplayRuntime({
      lines: readFileSync(path, "utf8").split("\n"),
      normalize,
      speed,
    });
  }

  /** Delivers every normalized line to subscribers, in file order. */
  async play(): Promise<void> {
    let prev: number | undefined;
    for (const line of this.lines) {
      const t = tMs(line);
      if (this.speed > 0 && t !== undefined && prev !== undefined && t > prev) {
        await this.sleep((t - prev) / this.speed);
      }
      if (t !== undefined) prev = t;
      const event = this.normalize(line);
      if (event) for (const h of [...this.handlers]) h(event);
    }
  }

  capabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve({
      runtime: "fixture-replay",
      version: "0.0.0",
      features: {
        createSession: false,
        sendInput: false,
        sendKeys: false,
        softStop: false,
        forceStop: false,
        pause: false,
        subscribe: true,
        terminalRead: false,
        processInfo: false,
        multiHost: false,
        notify: false,
      },
      agentKinds: [],
    });
  }

  health(): Promise<{ ok: boolean; detail?: string }> {
    return Promise.resolve({ ok: true });
  }

  createSession(spec: RuntimeSessionSpec): Promise<RuntimeSession> {
    void spec;
    return this.unsupported("createSession");
  }

  listSessions(): Promise<RuntimeSession[]> {
    return Promise.resolve([]);
  }

  getSession(): Promise<RuntimeSession | null> {
    return Promise.resolve(null);
  }

  sendInput(): Promise<void> {
    return this.unsupported("sendInput");
  }

  subscribe(handler: (e: RuntimeEvent) => void): Promise<{ close(): void }> {
    this.handlers.add(handler);
    return Promise.resolve({
      close: () => {
        this.handlers.delete(handler);
      },
    });
  }

  requestStop(): Promise<void> {
    return this.unsupported("requestStop");
  }

  reconcile(): Promise<{ sessions: RuntimeSession[]; lost: string[] }> {
    return Promise.resolve({ sessions: [], lost: [] });
  }

  dispose(): Promise<void> {
    this.handlers.clear();
    return Promise.resolve();
  }

  private unsupported(feature: string): Promise<never> {
    return Promise.reject(
      new MimirError("capability_unavailable", `${feature} is not supported by fixture replay`, {
        runtime: "fixture-replay",
        feature,
      }),
    );
  }
}
