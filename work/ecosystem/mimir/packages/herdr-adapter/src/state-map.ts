import type { RuntimeSessionState } from "@mimir/protocol";

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

const STATUS_MAP: Record<HerdrAgentStatus, RuntimeSessionState> = {
  idle: "idle",
  working: "running",
  blocked: "blocked",
  done: "completed",
  unknown: "unknown",
};

/** Maps a HerdR `agent_status` to a Mimir session state; anything unrecognised is `unknown`. */
export function mapAgentStatus(status: unknown): RuntimeSessionState {
  return typeof status === "string" && status in STATUS_MAP
    ? STATUS_MAP[status as HerdrAgentStatus]
    : "unknown";
}

/** Fact 6: `pane_agent_detected{released:true, final_status}` ends the session. */
export function releaseState(finalStatus: unknown): RuntimeSessionState {
  return finalStatus === "idle" || finalStatus === "done" ? "completed" : "failed";
}

/** States after which nothing from the runtime may move the session again (except `lost`). */
export const TERMINAL_STATES: ReadonlySet<RuntimeSessionState> = new Set([
  "stopped",
  "completed",
  "failed",
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shape of the per-session sentinel nonce (8 random bytes, hex). */
export const SENTINEL_NONCE_PATTERN = "[0-9a-f]{16}";

/**
 * Sentinel printed after a shell-kind command: `MIMIR_DONE:<sessionId>:<nonce>:<exitCode>`.
 *
 * This is the single, brief-mandated (T8 fact 5) exception to "terminal text
 * never sets state": it applies to `agentKind:"shell"` only (tests/demos).
 * The nonce is minted and typed only after `pane.process_info` shows the shell
 * as the sole foreground process again (audit H4), so the command itself never
 * sees it. Without `nonce` the regex matches any nonce (for subscriptions);
 * `parseSentinel` always requires the exact nonce.
 */
export function sentinelRegex(sessionId: string, nonce?: string): string {
  const n = nonce ? escapeRe(nonce) : SENTINEL_NONCE_PATTERN;
  return `^MIMIR_DONE:${escapeRe(sessionId)}:${n}:(\\d+)\\s*$`;
}

export function parseSentinel(
  sessionId: string,
  nonce: string | undefined,
  text: string,
): number | undefined {
  if (!nonce) return undefined; // no nonce minted yet: nothing can be a valid sentinel
  const re = new RegExp(sentinelRegex(sessionId, nonce));
  for (const line of text.split("\n")) {
    const m = re.exec(line.trimEnd());
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Fact 9: Claude Code's folder-trust dialog on the visible screen. */
export function isTrustPrompt(visibleText: string): boolean {
  return /trust this folder|one you trust|do you trust/i.test(visibleText);
}
