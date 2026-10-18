// Wire types for the Sindri server API (kept local: the web app does not import server code).

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BootstrapResult {
  indexed: string[];
  unchanged: string[];
  removed: string[];
  skipped: { path: string; reason: string }[];
}

export interface SearchHit {
  chunkId: number;
  documentId: string;
  path: string;
  kind: string;
  text: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface Intake {
  id: string;
  projectId: string;
  source: "manual" | "jira" | "linear";
  externalId: string | null;
  externalUrl: string | null;
  title: string;
  body: string;
  status: string | null;
  importedAt: string;
  syncState: "imported" | "stale" | "conflict";
  createdAt: string;
  hasPendingSnapshot: boolean;
  /** Sanitized copy for display; never render `title`/`body` as HTML. */
  display: { title: string; body: string };
}

export interface IntakeComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  origin: "remote" | "local";
  display: { author: string; body: string };
}

export type ProvenanceRef =
  | { knowledgeEntryId: string }
  | { taskEvidenceId: string }
  | { intakeId: string }
  | { documentId: string; startLine?: number; endLine?: number };

export interface OpenQuestion {
  id: string;
  text: string;
  blocking: boolean;
}

export interface SpecBody {
  problem: string;
  goals: string[];
  nonGoals: string[];
  constraints: string[];
  assumptions: { text: string; risk: "low" | "medium" | "high" }[];
  acceptanceCriteria: { id: string; text: string; verification: string }[];
  risks: string[];
  openQuestions: OpenQuestion[];
}

export type SpecStatus = "draft" | "review" | "approved" | "superseded";

export interface Spec {
  id: string;
  projectId: string;
  intakeId: string | null;
  lineageId: string;
  version: number;
  status: SpecStatus;
  title: string;
  body: SpecBody;
  provenance: Record<string, unknown>;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface SpecMeta {
  untrustedInstructionDetected: boolean;
  injectionFindings: { source: string; patternId: string }[];
  unverifiedClaims: { section: string; text: string; unknownCitations: string[] }[];
  answers: { questionId: string; questionText: string; answer: string }[];
}

export interface ContextItemView {
  id: string;
  kind: string;
  title: string;
  ref: ProvenanceRef | null;
  excerpt: string;
}

export interface DraftResult {
  spec: Spec;
  meta: SpecMeta;
  context: ContextItemView[];
  analysis: { impactedSystems: { area: string; paths: string[] }[]; testCommands: string[] };
}

export interface SpecDetail {
  spec: Spec;
  meta: SpecMeta;
  lineage: { id: string; version: number; status: SpecStatus; title: string; createdAt: string }[];
}

export interface ListDiff {
  added: string[];
  removed: string[];
}

export interface SpecDiff {
  from: string;
  to: string;
  changed: boolean;
  title?: { from: string; to: string };
  problem?: { from: string; to: string };
  goals: ListDiff;
  nonGoals: ListDiff;
  constraints: ListDiff;
  risks: ListDiff;
  assumptions: { added: unknown[]; removed: unknown[]; changed: unknown[] };
  acceptanceCriteria: { added: unknown[]; removed: unknown[]; changed: unknown[] };
  openQuestions: { added: unknown[]; removed: unknown[]; changed: unknown[] };
}

export type SourceRef =
  | { documentId: string; startLine: number; endLine: number }
  | { taskEvidenceId: string }
  | { url: string };

export interface KnowledgeEntry {
  id: string;
  projectId: string;
  claim: string;
  sourceRefs: SourceRef[];
  sources: { ref: SourceRef; label: string }[];
  validity: "valid" | "superseded" | "retracted";
  confidence: number;
  supersedesId: string | null;
  createdAt: string;
  createdBy: string;
  retractedReason?: string | null;
}

export interface NewKnowledge {
  claim: string;
  sourceRefs: SourceRef[];
  confidence: number;
}

export interface Settings {
  provider: "anthropic" | "codex-cli" | "claude-cli" | "fake" | "null";
  workerAgent?: "codex" | "claude" | "opencode" | "gemini" | "pi" | "pi-signed" | "grok" | "kimi" | "cursor" | "muse" | "rovo" | "omp" | "agy" | "devin" | "commandcode";
  reviewerAgent?: "codex" | "claude" | "opencode" | "gemini" | "pi" | "pi-signed" | "grok" | "kimi" | "cursor" | "muse" | "rovo" | "omp" | "agy" | "devin" | "commandcode";
  model: string;
  localOnly: boolean;
  mimirUrl?: string;
  /** SecretStore key holding the Mimir token. */
  mimirTokenSecret?: string;
  brokkrEnabled?: boolean;
  apiKeySecret?: string;
  connectors?: {
    jira?: { baseUrl: string; email: string; apiTokenSecret: string };
    linear?: { apiKeySecret: string };
  };
}

export interface Capabilities {
  serverVersion: string;
  features: { mimir: boolean; brokkr: boolean };
}
