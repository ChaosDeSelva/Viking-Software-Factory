import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@sindri/knowledge";

/** A reviewer's request to change a delivered execution, and the spec lineage drafted for it. */
export interface ReworkRequest {
  id: string;
  projectId: string;
  sourceExecutionId: string;
  specLineageId: string;
  /** Verified result commits of the delivered execution; the rework starts from these. */
  baseCommits: string[];
  feedback: string;
  createdAt: string;
}

interface Row {
  id: string;
  project_id: string;
  source_execution_id: string;
  spec_lineage_id: string;
  base_commits_json: string;
  feedback: string;
  created_at: string;
}

const toRework = (r: Row): ReworkRequest => ({
  id: r.id,
  projectId: r.project_id,
  sourceExecutionId: r.source_execution_id,
  specLineageId: r.spec_lineage_id,
  baseCommits: JSON.parse(r.base_commits_json) as string[],
  feedback: r.feedback,
  createdAt: r.created_at,
});

export class ReworkStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date,
  ) {}

  create(input: Omit<ReworkRequest, "id" | "createdAt">): ReworkRequest {
    const rework: ReworkRequest = {
      ...input,
      id: `rwk_${randomUUID()}`,
      createdAt: this.now().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO rework_requests (id, project_id, source_execution_id, spec_lineage_id,
           base_commits_json, feedback, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rework.id,
        rework.projectId,
        rework.sourceExecutionId,
        rework.specLineageId,
        JSON.stringify(rework.baseCommits),
        rework.feedback,
        rework.createdAt,
      );
    return rework;
  }

  forLineage(specLineageId: string): ReworkRequest | undefined {
    const row = this.db
      .prepare("SELECT * FROM rework_requests WHERE spec_lineage_id = ?")
      .get(specLineageId) as Row | undefined;
    return row ? toRework(row) : undefined;
  }

  /** Reworks requested on a delivered execution, oldest first. */
  forExecution(sourceExecutionId: string): ReworkRequest[] {
    return (
      this.db
        .prepare("SELECT * FROM rework_requests WHERE source_execution_id = ? ORDER BY created_at")
        .all(sourceExecutionId) as Row[]
    ).map(toRework);
  }
}

/**
 * The request a rework spec is drafted from. The reviewer's words are the work; the rest tells
 * the drafter that the delivered change exists and must be kept.
 */
export function reworkRequestText(input: {
  originalTitle: string;
  feedback: string;
  baseCommits: readonly string[];
  changedFiles: readonly string[];
}): string {
  const files = [...new Set(input.changedFiles)].slice(0, 60);
  return [
    `Rework of a delivered change: ${input.originalTitle}`,
    "",
    "A reviewer has read the delivered change and asks for the following. This feedback is the work to specify:",
    "",
    input.feedback.trim(),
    "",
    `The delivered change is already built and verified. New work starts from it (commit ${input.baseCommits.map((c) => c.slice(0, 12)).join(", ")}), not from the default branch. Specify only what the feedback asks for, and keep everything else the delivered change does.`,
    ...(files.length
      ? ["", "Files the delivered change touched:", ...files.map((f) => `- ${f}`)]
      : []),
  ].join("\n");
}
