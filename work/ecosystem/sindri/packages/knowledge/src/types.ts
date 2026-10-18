import { z } from "zod";

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const SourceRefSchema = z.union([
  z
    .object({
      documentId: z.string().min(1),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
    })
    .strict()
    .refine((r) => r.endLine >= r.startLine, { message: "endLine must be >= startLine" }),
  z.object({ taskEvidenceId: z.string().min(1) }).strict(),
  z.object({ url: z.url({ protocol: /^https?$/ }) }).strict(),
]);
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const Validity = ["valid", "superseded", "retracted"] as const;
export type Validity = (typeof Validity)[number];

export const NewEntrySchema = z.object({
  claim: z.string().trim().min(1),
  sourceRefs: z.array(SourceRefSchema).min(1, "a knowledge entry requires at least one source ref"),
  confidence: z.number().min(0).max(1),
  createdBy: z.string().min(1),
});
export type NewEntry = z.input<typeof NewEntrySchema>;
export type AddEntryInput = NewEntry & { projectId: string };

export interface KnowledgeEntry {
  id: string;
  projectId: string;
  claim: string;
  sourceRefs: SourceRef[];
  validity: Validity;
  confidence: number;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  retractedReason: string | null;
}

export interface TaskEvidence {
  id: string;
  projectId: string;
  externalRef: string;
  kind: string;
  payload: unknown;
  createdAt: string;
  /** SHA-256 over the row's content; kept when the evidence is erased. */
  contentSha256: string;
}

/** What remains of task evidence erased with its project (audit M4). */
export interface ErasedTaskEvidence {
  id: string;
  kind: string;
  contentSha256: string;
  createdAt: string;
  erasedAt: string;
}

export interface PurgeOptions {
  /**
   * Erase the project's immutable task evidence (tombstone: id, kind, hash and time stay;
   * project, reference and payload go). Without it, purge refuses while evidence exists.
   */
  eraseEvidence?: boolean;
}

export interface RecordEvidenceInput {
  projectId: string;
  externalRef: string;
  kind: string;
  payload: unknown;
}

export type DecisionStatus = "proposed" | "accepted" | "rejected" | "superseded" | "deprecated";

export interface Decision {
  id: string;
  projectId: string;
  title: string;
  adrMarkdown: string;
  status: DecisionStatus;
  approver: string | null;
  createdAt: string;
}

export interface RecordDecisionInput {
  projectId: string;
  title: string;
  adrMarkdown: string;
  status?: DecisionStatus;
  approver?: string;
}

export interface SearchHit {
  chunkId: number;
  documentId: string;
  path: string;
  kind: string;
  text: string;
  startLine: number;
  endLine: number;
  /** bm25 rank; lower is more relevant. */
  score: number;
}
