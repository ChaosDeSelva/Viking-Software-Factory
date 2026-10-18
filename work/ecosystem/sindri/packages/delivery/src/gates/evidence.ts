import { createHash } from "node:crypto";
import type {
  ArtifactContentReader,
  ExecutionEventView,
  MimirActions,
  MimirArtifactView,
} from "./ports.js";

export interface RecordedArtifact {
  /** Mimir event id of the `artifact.recorded` event. */
  eventId: string;
  artifactId: string;
  taskId: string;
  kind: string;
  uri: string;
  hash: string;
  occurredAt: string;
}

export interface TestRun {
  eventId: string;
  taskId: string | null;
  command: string;
  passed: boolean;
  /** Only when Mimir records one; protocol 0.0.0 carries `passed`, not an exit code. */
  exitCode: number | null;
  durationMs: number | null;
  occurredAt: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Envelope sources whose events count as evidence (Mimir's own server; T12 `SERVER_SOURCE`). */
export const DEFAULT_TRUSTED_SOURCES: readonly string[] = ["mimir.server"];

/** Which envelopes count as evidence. Agents and summaries never do. */
export interface EvidenceTrust {
  sources: ReadonlySet<string>;
}

export const evidenceTrust = (
  sources: readonly string[] = DEFAULT_TRUSTED_SOURCES,
): EvidenceTrust => ({
  sources: new Set(sources),
});

/** From a trusted Mimir source and not a summary. */
export const isTrusted = (e: ExecutionEventView, trust: EvidenceTrust): boolean =>
  e.source !== null &&
  trust.sources.has(e.source) &&
  e.provenance !== null &&
  e.provenance !== "summarized";

/**
 * Artifacts from `artifact.recorded` events. The envelope task must equal the payload task
 * (attribution is by envelope); with `trust`, only trusted envelopes count.
 */
export function recordedArtifacts(
  events: ExecutionEventView[],
  trust?: EvidenceTrust,
): RecordedArtifact[] {
  const out: RecordedArtifact[] = [];
  for (const e of events) {
    if (e.type !== "artifact.recorded" || !isRecord(e.payload)) continue;
    if (trust && !isTrusted(e, trust)) continue;
    if (e.mimirTaskId === null || e.payload.taskId !== e.mimirTaskId) continue;
    const p = e.payload;
    if (
      typeof p.artifactId !== "string" ||
      typeof p.taskId !== "string" ||
      typeof p.kind !== "string" ||
      typeof p.uri !== "string" ||
      typeof p.hash !== "string"
    ) {
      continue;
    }
    out.push({
      eventId: e.mimirEventId,
      artifactId: p.artifactId,
      taskId: p.taskId,
      kind: p.kind,
      uri: p.uri,
      hash: p.hash,
      occurredAt: e.occurredAt,
    });
  }
  return out;
}

/**
 * `test.run_completed` events. Attribution comes from the envelope task id only; with `trust`,
 * only trusted envelopes with provenance `observed` count.
 */
export function testRuns(events: ExecutionEventView[], trust?: EvidenceTrust): TestRun[] {
  const out: TestRun[] = [];
  for (const e of events) {
    if (e.type !== "test.run_completed" || !isRecord(e.payload)) continue;
    if (trust && (!isTrusted(e, trust) || e.provenance !== "observed")) continue;
    const p = e.payload;
    if (typeof p.command !== "string" || typeof p.passed !== "boolean") continue;
    out.push({
      eventId: e.mimirEventId,
      taskId: e.mimirTaskId,
      command: p.command,
      passed: p.passed,
      exitCode: typeof p.exitCode === "number" ? p.exitCode : null,
      durationMs: typeof p.durationMs === "number" ? p.durationMs : null,
      occurredAt: e.occurredAt,
    });
  }
  return out;
}

/** Latest session Mimir reported for a task (envelope `sessionId`). */
export function latestSession(events: ExecutionEventView[], mimirTaskId: string): string | null {
  let session: string | null = null;
  for (const e of events) {
    if (e.mimirTaskId === mimirTaskId && e.sessionId) session = e.sessionId;
  }
  return session;
}

const SHA256 = /^(?:sha256:)?([0-9a-f]{64})$/i;

/** The hex digest of a `sha256:<hex>` or bare-hex hash, or `null` when it is not SHA-256. */
export function sha256Hex(hash: string): string | null {
  const m = SHA256.exec(hash.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex");

export type ArtifactRead =
  | { ok: true; artifact: MimirArtifactView; text: string }
  | {
      ok: false;
      reason: "artifact_unavailable" | "artifact_mismatch" | "evidence_integrity_mismatch";
      detail: string;
    };

/** Artifact kind of the manifest Mimir's server records for a task's worktree before verifying. */
export const CHANGED_FILES_ARTIFACT_KIND = "changed-files";

/**
 * The trusted `changed-files` manifest Mimir recorded for `taskId` in the verifying step that
 * ended with `beforeEventId` (the report's `artifact.recorded` event): the latest manifest after
 * that task's last `task.verifying`. `null` when there is none.
 */
export function manifestOfVerifyingStep(
  events: ExecutionEventView[],
  taskId: string,
  beforeEventId: string,
  trust: EvidenceTrust,
): RecordedArtifact | null {
  let manifest: RecordedArtifact | null = null;
  for (const e of events) {
    if (e.mimirEventId === beforeEventId) break;
    if (e.mimirTaskId !== taskId || !isTrusted(e, trust)) continue;
    if (e.type === "task.verifying") manifest = null;
    if (e.type !== "artifact.recorded") continue;
    const [a] = recordedArtifacts([e], trust);
    if (a && a.taskId === taskId && a.kind === CHANGED_FILES_ARTIFACT_KIND) manifest = a;
  }
  return manifest;
}

/** `headSha` from a `changed-files` manifest (`ChangedFilesManifest`), or `null` if malformed. */
export function manifestHead(text: string): string | null {
  try {
    const raw: unknown = JSON.parse(text);
    const head = isRecord(raw) ? raw.headSha : undefined;
    return typeof head === "string" && /^[0-9a-f]{7,64}$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * Fetches an artifact's metadata from Mimir, then its bytes, and checks the bytes against the
 * hash Mimir recorded. Anything unreadable or altered is rejected, never trusted.
 */
export async function readVerifiedArtifact(
  mimir: Pick<MimirActions, "getArtifact">,
  content: ArtifactContentReader,
  artifactId: string,
  expect?: { taskId: string; kind: string },
): Promise<ArtifactRead> {
  const unavailable = (e: unknown): ArtifactRead => ({
    ok: false,
    reason: "artifact_unavailable",
    detail: e instanceof Error ? e.message : String(e),
  });
  let artifact: MimirArtifactView;
  try {
    artifact = await mimir.getArtifact(artifactId);
  } catch (e) {
    return unavailable(e);
  }
  if (expect && (artifact.taskId !== expect.taskId || artifact.kind !== expect.kind)) {
    return {
      ok: false,
      reason: "artifact_mismatch",
      detail: `Mimir records artifact ${artifactId} for another task or kind`,
    };
  }
  let text: string;
  try {
    text = await content.read(artifact);
  } catch (e) {
    return unavailable(e);
  }
  const expected = sha256Hex(artifact.hash);
  if (!expected || expected !== sha256Of(text)) {
    return {
      ok: false,
      reason: "evidence_integrity_mismatch",
      detail: `artifact ${artifactId} does not match its recorded hash`,
    };
  }
  return { ok: true, artifact, text };
}
