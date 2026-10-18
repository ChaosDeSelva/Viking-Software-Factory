import type {
  DeliveryDetail,
  ExecutionDetail,
  Plan,
  PlanTask,
  PlanVersion,
  ReviewsInbox,
  TraceDocument,
} from "../api/delivery-types.js";

export const planTask = (over: Partial<PlanTask> = {}): PlanTask => ({
  id: "implement-frontend",
  objective: "Build the CSV button",
  inputs: ["spec"],
  outputs: ["code"],
  acceptanceCriteria: ["AC1"],
  dependsOn: [],
  harnessId: "frontend-react",
  harnessVersion: "1.1.0",
  harnessLockDigest: `sha256:${"a".repeat(64)}`,
  skills: ["react-testing"],
  selectionRationale: ["harness frontend-react: selected (task types frontend match)"],
  role: "implementer",
  budget: { wallClockMinutes: 90 },
  maxRetries: 2,
  escalation: "replan",
  ...over,
});

export const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "pl1",
  projectId: "p1",
  lineageId: "L1",
  specId: "s1",
  specVersion: 2,
  version: 1,
  status: "draft",
  tasks: [
    planTask(),
    planTask({
      id: "docs",
      role: "docs",
      dependsOn: ["implement-frontend"],
      harnessId: "documentation",
      harnessVersion: "1.0.0",
      acceptanceCriteria: [],
      selectionRationale: ["harness documentation: selected (task types docs match)"],
    }),
  ],
  estimates: {
    taskCount: 2,
    wallClockMinutes: 120,
    criticalPathMinutes: 120,
    tokens: 500000,
    costUsd: null,
  },
  approvedBy: null,
  approvedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

export const versionOf = (p: Plan): PlanVersion => ({
  id: p.id,
  version: p.version,
  status: p.status,
  specId: p.specId,
  specVersion: p.specVersion,
  approvedBy: p.approvedBy,
  approvedAt: p.approvedAt,
  createdAt: p.createdAt,
});

export const executionDetail = (over: Partial<ExecutionDetail> = {}): ExecutionDetail => ({
  execution: {
    id: "e1",
    planId: "pl1",
    planVersion: 1,
    mimirMissionId: "msn_1",
    status: "awaiting_human",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    projectId: "p1",
  },
  tasks: [
    {
      id: "t1",
      planTaskId: "implement-frontend",
      mimirTaskId: "tsk_1",
      status: "blocked",
      attempts: 0,
      escalation: null,
      escalationReason: null,
    },
  ],
  approvals: [
    {
      id: "exa_1",
      executionId: "e1",
      mimirApprovalId: "apr_1",
      planTaskId: "implement-frontend",
      action: "fs.write",
      reason: "write export.ts",
      disposition: "inbox",
      status: "pending",
      requestedAt: "2026-01-01T00:00:00Z",
      decidedAt: null,
    },
  ],
  artifacts: [],
  plan: {
    id: "pl1",
    version: 1,
    specId: "s1",
    tasks: [{ id: "implement-frontend", objective: "Build", role: "implementer", dependsOn: [] }],
  },
  links: { mission: "http://127.0.0.1:7700/missions/msn_1" },
  gates: [],
  running: true,
  ...over,
});

export const inbox = (over: Partial<ReviewsInbox> = {}): ReviewsInbox => ({
  deliveryService: "s6",
  approvals: [],
  escalations: [],
  budgetAlerts: [],
  gateFailures: [],
  findings: [],
  ...over,
});

export const delivery = (over: Partial<DeliveryDetail> = {}): DeliveryDetail => ({
  deliveryService: "s6",
  report: {
    id: "dlv_1",
    executionId: "e1",
    projectId: "p1",
    status: "built",
    createdAt: "2026-01-01T00:01:00Z",
    deliveredAt: null,
    spec: {
      id: "s1",
      lineageId: "L1",
      version: 2,
      title: "CSV export for reports",
      intakeId: null,
    },
    plan: { id: "pl1", version: 1 },
    missionId: "msn_1",
    requirements: [
      {
        criterionId: "AC1",
        text: "A CSV button exists",
        verification: "test",
        status: "unverified",
        tasks: [{ planTaskId: "implement-frontend", mimirTaskId: "tsk_1", gatePassed: false }],
        evidence: ["evt_9", "art_1"],
      },
    ],
    tasks: [
      {
        planTaskId: "implement-frontend",
        mimirTaskId: "tsk_1",
        role: "implementer",
        status: "completed",
        harness: { id: "frontend-react", version: "1.1.0", lockDigest: "sha256:x" },
        gate: {
          evaluationId: "gev_1",
          passed: false,
          failures: [{ gateId: "brokkr", reason: "verification_report_missing" }],
        },
        brokkr: null,
      },
    ],
    summary: {
      sentences: [{ text: "Plan task implement-frontend completed [ref:evt_8]." }],
      stripped: [],
    },
    changedFiles: [],
    testResults: [
      {
        eventId: "evt_9",
        planTaskId: "implement-frontend",
        command: "pnpm test",
        passed: true,
        exitCode: null,
        durationMs: 120,
      },
    ],
    screenshots: [],
    reviews: [],
    limitations: ["No Brokkr verification report for implement-frontend."],
    rollback: { branches: [], commits: [], note: "Close the PRs; delete the branches." },
  },
  prDescription: "# CSV export for reports\n\n## Requirements\n- **AC1** A CSV button exists\n",
  ...over,
});

export const trace = (): TraceDocument => ({
  schemaVersion: 1,
  delivery: { id: "dlv_1", status: "built", prs: [] },
  ticket: null,
  spec: { id: "s1", version: 2, title: "CSV export for reports", status: "approved" },
  plan: { id: "pl1", version: 1 },
  mission: { id: "msn_1" },
  execution: { id: "e1", status: "verified_pending_review" },
  tasks: [
    {
      planTaskId: "implement-frontend",
      mimirTaskId: "tsk_1",
      role: "implementer",
      status: "completed",
      harness: { id: "frontend-react", version: "1.1.0" },
      gate: { passed: false },
      reviews: [],
      events: [{ id: "evt_1", type: "task.ready", occurredAt: "2026-01-01T00:00:00Z" }],
      artifacts: [{ id: "art_1", kind: "test.output", hash: "sha256:abc" }],
    },
  ],
  reviewTasks: [],
  unattributedEvents: [],
});
