/**
 * Which model an agent CLI actually ran, read from what it reports: Claude Code's stream names
 * its model (`system` init and each `assistant` message); Codex's JSON stream does not, but it
 * names its thread, and Codex records the thread's model in its own session log.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OutputModel {
  /** The model the agent reported, when this output names it. */
  model?: string;
  /** A Codex thread id, when this output starts one (its model is in Codex's session log). */
  codexThread?: string;
}

const MODEL = /^[\w.:@/-]{1,200}$/;

/** Reads one chunk of a session's output (JSON lines, possibly with other text between). */
export function modelFromOutput(text: string): OutputModel {
  const out: OutputModel = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = o.message as Record<string, unknown> | undefined;
    const model =
      (o.type === "system" && typeof o.model === "string" && o.model) ||
      (o.type === "assistant" && typeof message?.model === "string" && message.model) ||
      undefined;
    if (model && MODEL.test(model) && !out.model) out.model = model;
    if (o.type === "thread.started" && typeof o.thread_id === "string" && !out.codexThread)
      out.codexThread = o.thread_id;
  }
  return out;
}

/** Codex's session folders for today and yesterday (a session can start just before midnight). */
function recentDayDirs(root: string, now: Date): string[] {
  const days = [now, new Date(now.getTime() - 86_400_000)];
  return days.map((d) =>
    join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ),
  );
}

/**
 * The model of a Codex thread from Codex's session log (`$CODEX_HOME/sessions/YYYY/MM/DD/
 * rollout-*-<thread>.jsonl`), or null while the log does not name it yet.
 */
export function codexThreadModel(
  threadId: string,
  { codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"), now = new Date() } = {},
): string | null {
  if (!/^[\w-]{8,100}$/.test(threadId)) return null;
  for (const dir of recentDayDirs(join(codexHome, "sessions"), now)) {
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find((f) => f.endsWith(`-${threadId}.jsonl`));
    if (!file) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      return null;
    }
    const m = /"model":"([\w.:@/-]{1,200})"/.exec(text);
    return m ? m[1]! : null;
  }
  return null;
}

/** Why an agent CLI could not work: its plan's usage limit, or its login or key. */
export interface AgentUnavailable {
  kind: "usage_limit" | "auth";
  /** When the limit resets, when the agent says (ISO). */
  until?: string;
  /** The agent's own words, for the operator. */
  message: string;
}

const LIMIT_TEXT =
  /usage[_ ]limit|hit your (?:weekly|daily|monthly|5-hour|session )?(?:usage )?limit|rate[_ ]limit(?:ed)?.{0,40}(?:reset|try again)|quota (?:exceeded|exhausted)|insufficient[_ ]quota/i;
const AUTH_TEXT =
  /not logged in|please (?:run )?(?:\/login|log ?in)|invalid (?:api )?key|authentication[_ ](?:error|failed)|unauthori[sz]ed|401\b/i;

/**
 * Whether this output says the agent cannot work for reasons outside the task: Claude Code's
 * `usage_limit_reached` (with its reset time), a rate-limit event that rejected the request, or a
 * login or key failure; Codex's error events in the same words.
 */
export function agentUnavailableFromOutput(text: string): AgentUnavailable | null {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: Record<string, unknown> | null = null;
    if (t.startsWith("{"))
      try {
        o = JSON.parse(t) as Record<string, unknown>;
      } catch {
        o = null;
      }
    if (o) {
      const info = (o.rate_limit_info ??
        (o.api_error_params as Record<string, unknown> | undefined)?.rate_limit_info) as
        { status?: string; resetsAt?: number } | undefined;
      const until =
        typeof info?.resetsAt === "number"
          ? new Date(info.resetsAt * 1000).toISOString()
          : undefined;
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      const words =
        str(o.result) ||
        str(o.message) ||
        str((o.error as Record<string, unknown> | undefined)?.message) ||
        str(o.error);
      if (
        o.api_error === "usage_limit_reached" ||
        (o.type === "rate_limit_event" && info?.status === "rejected")
      )
        return {
          kind: "usage_limit",
          ...(until ? { until } : {}),
          message: words || "usage limit reached",
        };
      if (o.api_error === "authentication_error" || o.api_error_status === 401)
        return { kind: "auth", message: words || "authentication failed" };
      const isError = o.type === "error" || o.type === "turn.failed" || o.is_error === true;
      if (isError && LIMIT_TEXT.test(JSON.stringify(o)))
        return {
          kind: "usage_limit",
          ...(until ? { until } : {}),
          message: words || "usage limit reached",
        };
      if (isError && AUTH_TEXT.test(JSON.stringify(o)))
        return { kind: "auth", message: words || "authentication failed" };
      continue;
    }
    // Plain stderr from a CLI that failed before its JSON stream started.
    if (/^(?:error|fatal)\b/i.test(t) && LIMIT_TEXT.test(t))
      return { kind: "usage_limit", message: t };
    if (/^(?:error|fatal)\b/i.test(t) && AUTH_TEXT.test(t)) return { kind: "auth", message: t };
  }
  return null;
}
