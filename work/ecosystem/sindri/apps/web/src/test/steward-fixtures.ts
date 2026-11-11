import type {
  Decision,
  ProjectFeedbackGraph,
  StewardNote,
  StewardStatus,
  StewardType,
} from "../api/steward-types.js";

const stats = (over: Partial<StewardType["stats"]> = {}): StewardType["stats"] => ({
  decided: 10,
  accepted: 6,
  changed: 2,
  rejected: 1,
  rolledBack: 1,
  autoApplied: 0,
  accuracy: 0.8,
  ...over,
});

export const stewardType = (over: Partial<StewardType> = {}): StewardType => ({
  type: "spec.answer",
  mode: "recommend",
  autoAllowed: true,
  stats: stats(),
  ...over,
});

export const stewardStatus = (over: Partial<StewardStatus> = {}): StewardStatus => ({
  running: true,
  types: [
    stewardType(),
    stewardType({
      type: "plan.approve",
      autoAllowed: false,
      stats: stats({ accepted: 3, changed: 0, rejected: 0, rolledBack: 0, accuracy: null }),
    }),
  ],
  feedbackGraph: {
    configured: true,
    enabled: true,
    url: "http://127.0.0.1:8787",
    reachable: true,
    error: null,
  },
  ...over,
});

export const note = (over: Partial<StewardNote> = {}): StewardNote => ({
  id: "n1",
  projectId: "p1",
  decisionId: null,
  author: "operator",
  text: "Prefer small PRs",
  createdAt: "2026-11-01T10:00:00Z",
  ...over,
});

export const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  projectId: "p1",
  type: "spec.answer",
  subject: { kind: "spec", id: "s1", label: "CSV export: which columns?" },
  inputs: [
    { kind: "lesson", ref: "fg:L7", summary: "Always confirm column order" },
    { kind: "past_decision", ref: "d0", summary: "Answered with all columns; accepted" },
    { kind: "run", ref: "e1", summary: "Last run passed" },
  ],
  recommendation: { value: "All visible columns", detail: "Matches the reports table" },
  reasoning: "The reports table shows these columns.",
  confidence: 0.82,
  mode: "recommend",
  status: "pending",
  outcome: null,
  reversible: true,
  notes: [],
  createdAt: "2026-11-01T12:00:00Z",
  decidedAt: null,
  ...over,
});

export const projectFg = (over: Partial<ProjectFeedbackGraph> = {}): ProjectFeedbackGraph => ({
  link: { projectKey: "demo", source: "auto" },
  lessons: [
    {
      id: "L7",
      title: "Confirm column order",
      rule: "Ask before reordering CSV columns.",
      appliesWhen: "Changing exports",
      paths: ["src/export/**", "src/reports.ts"],
      status: "approved",
    },
  ],
  error: null,
  ...over,
});
