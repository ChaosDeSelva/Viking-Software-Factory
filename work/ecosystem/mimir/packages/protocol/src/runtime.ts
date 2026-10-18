import { z } from "zod";
import { RuntimeSessionStateSchema, type RuntimeSessionState } from "./enums.js";
import { MimirError } from "./errors.js";
import { RuntimeRefSchema } from "./events.js";
import { TimestampSchema } from "./ids.js";

export const RUNTIME_FEATURES = [
  "createSession",
  "sendInput",
  "sendKeys",
  "softStop",
  "forceStop",
  "pause",
  "subscribe",
  "terminalRead",
  "processInfo",
  "multiHost",
  "notify",
] as const;
export type RuntimeFeature = (typeof RUNTIME_FEATURES)[number];

export interface RuntimeCapabilities {
  runtime: string;
  version: string;
  features: {
    createSession: boolean;
    sendInput: boolean;
    sendKeys: boolean;
    softStop: boolean;
    forceStop: boolean;
    pause: boolean;
    subscribe: boolean;
    terminalRead: boolean;
    processInfo: boolean;
    multiHost: boolean;
    notify: boolean;
  };
  agentKinds: string[];
}

export interface RuntimeSessionSpec {
  sessionId: string;
  idempotencyKey: string;
  crewId: string;
  taskId: string;
  agentKind: string;
  argv: string[];
  timeoutMs?: number;
  cwd: string;
  env: Record<string, string>;
  workspaceLabel: string;
}

export interface RuntimeSession {
  sessionId: string;
  runtimeRef: {
    paneId?: string;
    terminalId?: string;
    workspaceId?: string;
    agentSessionId?: string;
  };
  state: RuntimeSessionState;
  agentKind?: string;
  cwd?: string;
  lastObservedAt: string;
}

export type RuntimeEvent =
  | {
      kind: "session.state_changed";
      sessionId: string;
      state: RuntimeSessionState;
      runtimeStatus?: string;
      observedAt: string;
      sourceEventId?: string;
    }
  | { kind: "session.output"; sessionId: string; text: string; observedAt: string }
  | {
      kind: "session.exited";
      sessionId: string;
      exitCode?: number;
      observedAt: string;
      usage?: { tokens: number; estimatedCost: number | null };
    }
  | { kind: "session.lost"; sessionId: string; reason: string; observedAt: string }
  | { kind: "runtime.gap"; reason: "events_lost" | "reconnect" | "restart"; observedAt: string };

/**
 * The contract the HerdR adapter and the fake runtime implement.
 * Operations the runtime does not support throw `MimirError('capability_unavailable')`.
 */
export interface RuntimeAdapter {
  capabilities(): Promise<RuntimeCapabilities>;
  health(): Promise<{ ok: boolean; detail?: string }>;
  createSession(spec: RuntimeSessionSpec): Promise<RuntimeSession>;
  listSessions(): Promise<RuntimeSession[]>;
  getSession(sessionId: string): Promise<RuntimeSession | null>;
  sendInput(sessionId: string, input: { text?: string; keys?: string[] }): Promise<void>;
  subscribe(handler: (e: RuntimeEvent) => void): Promise<{ close(): void }>;
  requestStop(sessionId: string, mode: "soft" | "force"): Promise<void>;
  reconcile(): Promise<{ sessions: RuntimeSession[]; lost: string[] }>;
  dispose(): Promise<void>;
}

export const RuntimeCapabilitiesSchema = z
  .object({
    runtime: z.string(),
    version: z.string(),
    features: z.object({
      createSession: z.boolean(),
      sendInput: z.boolean(),
      sendKeys: z.boolean(),
      softStop: z.boolean(),
      forceStop: z.boolean(),
      pause: z.boolean(),
      subscribe: z.boolean(),
      terminalRead: z.boolean(),
      processInfo: z.boolean(),
      multiHost: z.boolean(),
      notify: z.boolean(),
    }),
    agentKinds: z.array(z.string()),
  })
  .meta({ id: "RuntimeCapabilities" });

export const RuntimeSessionSpecSchema = z.object({
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  crewId: z.string().min(1),
  taskId: z.string().min(1),
  agentKind: z.string().min(1),
  argv: z.array(z.string()),
  timeoutMs: z.number().int().positive().exactOptional(),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  workspaceLabel: z.string(),
});

export const RuntimeSessionSchema = z.object({
  sessionId: z.string().min(1),
  runtimeRef: RuntimeRefSchema,
  state: RuntimeSessionStateSchema,
  agentKind: z.string().exactOptional(),
  cwd: z.string().exactOptional(),
  lastObservedAt: TimestampSchema,
});

export const RuntimeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session.state_changed"),
    sessionId: z.string(),
    state: RuntimeSessionStateSchema,
    runtimeStatus: z.string().exactOptional(),
    observedAt: TimestampSchema,
    sourceEventId: z.string().exactOptional(),
  }),
  z.object({
    kind: z.literal("session.output"),
    sessionId: z.string(),
    text: z.string(),
    observedAt: TimestampSchema,
  }),
  z.object({
    kind: z.literal("session.exited"),
    sessionId: z.string(),
    exitCode: z.number().int().exactOptional(),
    usage: z
      .object({
        tokens: z.number().nonnegative(),
        estimatedCost: z.number().nonnegative().nullable(),
      })
      .exactOptional(),
    observedAt: TimestampSchema,
  }),
  z.object({
    kind: z.literal("session.lost"),
    sessionId: z.string(),
    reason: z.string(),
    observedAt: TimestampSchema,
  }),
  z.object({
    kind: z.literal("runtime.gap"),
    reason: z.enum(["events_lost", "reconnect", "restart"]),
    observedAt: TimestampSchema,
  }),
]);

/** Throw `MimirError('capability_unavailable')` unless the runtime advertises `feature`. */
export function requireCapability(caps: RuntimeCapabilities, feature: RuntimeFeature): void {
  if (!caps.features[feature]) {
    throw new MimirError(
      "capability_unavailable",
      `runtime ${caps.runtime} does not support ${feature}`,
      { runtime: caps.runtime, feature },
    );
  }
}
