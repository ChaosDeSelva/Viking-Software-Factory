import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@sindri/knowledge";
import type { LlmUsage } from "./provider.js";

/**
 * USD per million tokens (input, output). Estimates only; unknown models get `null`.
 * Source: Anthropic first-party list prices as cached in the claude-api skill reference
 * ("Current Models", cached 2026-09-25). Verify against https://www.anthropic.com/pricing.
 */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function estimateCost(model: string, usage: LlmUsage | null): number | null {
  const p = MODEL_PRICES[model];
  if (!p || !usage) return null;
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}

export interface DirectorRun {
  id: string;
  projectId: string | null;
  purpose: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costEstimate: number | null;
  source: "measured" | "unavailable";
  /** `ok`, or the ProviderError code of a failed call (e.g. `invalid_output`, `refused`). */
  outcome: string;
  createdAt: string;
}

interface RunRow {
  id: string;
  project_id: string | null;
  purpose: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_estimate: number | null;
  source: "measured" | "unavailable";
  outcome: string;
  created_at: string;
}

const toRun = (r: RunRow): DirectorRun => ({
  id: r.id,
  projectId: r.project_id,
  purpose: r.purpose,
  model: r.model,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  costEstimate: r.cost_estimate,
  source: r.source,
  outcome: r.outcome,
  createdAt: r.created_at,
});

export function recordRun(
  db: SqliteDatabase,
  input: {
    projectId: string | null;
    purpose: string;
    model: string;
    usage: LlmUsage | null;
    outcome?: string;
  },
  createdAt: string,
): DirectorRun {
  const row: RunRow = {
    id: randomUUID(),
    project_id: input.projectId,
    purpose: input.purpose,
    model: input.model,
    input_tokens: input.usage?.inputTokens ?? null,
    output_tokens: input.usage?.outputTokens ?? null,
    cost_estimate: estimateCost(input.model, input.usage),
    source: input.usage ? "measured" : "unavailable",
    outcome: input.outcome ?? "ok",
    created_at: createdAt,
  };
  db.prepare(
    `INSERT INTO director_runs (id, project_id, purpose, model, input_tokens, output_tokens,
       cost_estimate, source, outcome, created_at)
     VALUES (@id, @project_id, @purpose, @model, @input_tokens, @output_tokens,
       @cost_estimate, @source, @outcome, @created_at)`,
  ).run(row);
  return toRun(row);
}

export function listRuns(db: SqliteDatabase, projectId?: string): DirectorRun[] {
  const rows = (
    projectId === undefined
      ? db.prepare("SELECT * FROM director_runs ORDER BY created_at, rowid").all()
      : db
          .prepare("SELECT * FROM director_runs WHERE project_id = ? ORDER BY created_at, rowid")
          .all(projectId)
  ) as RunRow[];
  return rows.map(toRun);
}
