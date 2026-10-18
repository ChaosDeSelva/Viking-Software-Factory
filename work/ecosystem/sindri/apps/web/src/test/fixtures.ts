import type { Intake, KnowledgeEntry, Spec, SpecMeta } from "../api/types.js";

export const intake = (over: Partial<Intake> = {}): Intake => ({
  id: "i1",
  projectId: "p1",
  source: "manual",
  externalId: null,
  externalUrl: null,
  title: "Add CSV",
  body: "raw",
  status: null,
  importedAt: "2026-01-01T00:00:00Z",
  syncState: "imported",
  createdAt: "2026-01-01T00:00:00Z",
  hasPendingSnapshot: false,
  display: { title: "Add CSV", body: "Please add CSV export" },
  ...over,
});

export const spec = (over: Partial<Spec> = {}): Spec => ({
  id: "s1",
  projectId: "p1",
  intakeId: "i1",
  lineageId: "L1",
  version: 1,
  status: "draft",
  title: "CSV export for reports",
  body: {
    problem: "Users cannot export reports as CSV.",
    goals: ["Export the reports page as CSV"],
    nonGoals: [],
    constraints: [],
    assumptions: [{ text: "Exports run in the browser", risk: "medium" }],
    acceptanceCriteria: [{ id: "AC1", text: "A CSV button exists", verification: "test" }],
    risks: [],
    openQuestions: [
      { id: "Q1", text: "Which columns?", blocking: true },
      { id: "Q2", text: "File name?", blocking: false },
    ],
  },
  provenance: {
    problem: [{ intakeId: "i1aaaaaaaa" }],
    acceptanceCriteria: { AC1: [{ documentId: "d1", startLine: 1, endLine: 3 }] },
  },
  approvedBy: null,
  approvedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

export const meta = (over: Partial<SpecMeta> = {}): SpecMeta => ({
  untrustedInstructionDetected: false,
  injectionFindings: [],
  unverifiedClaims: [],
  answers: [],
  ...over,
});

export const entry = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id: "k1",
  projectId: "p1",
  claim: "CSV uses papaparse",
  sourceRefs: [{ documentId: "d1", startLine: 1, endLine: 3 }],
  sources: [{ ref: { documentId: "d1", startLine: 1, endLine: 3 }, label: "README.md#L1-L3" }],
  validity: "valid",
  confidence: 0.9,
  supersedesId: null,
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: "user",
  ...over,
});
