import { execFileSync } from "node:child_process";
/**
 * Full factory acceptance run (03_FACTORY.md "Acceptance test: complete factory run") against a
 * real Mimir server started as a child process (fake agent runtime). Sindri runs in-process
 * with the FakeProvider director. Skipped, with the reason, when no Mimir build is found.
 *
 * Each step records `ok`, or `blocked` with the missing capability, in `steps`; the table is
 * printed at the end and pasted into docs/gates/g4-g7.md.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, type FakeResponder } from "@sindri/director";
import { openDatabase, type SqliteDatabase } from "@sindri/knowledge";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/app.js";
import { demoPlanResponder } from "../../src/demo-plan-responder.js";
import { demoResponder } from "../../src/demo-responder.js";
import { DEMO_TICKET, writeDemoRepo } from "../../src/demo-repo.js";
import { findMimirMain, startMimirChild, type MimirChild } from "./mimir-child.js";

const MIMIR_MAIN = findMimirMain();
const SKIP_REASON = "no Mimir build found (build ../mimir with `pnpm build`)";
const TOKEN = "a".repeat(64);
const SECRET = "mimir.token";
/** Fixed approval pairing code (production prints a random one on the server's terminal). */
const PAIRING_CODE = "ACCEP-TANCE";

type Step = { step: string; status: "ok" | "blocked"; detail: string };
const steps: Step[] = [];
const record = (step: string, status: Step["status"], detail: string) => {
  steps.push({ step, status, detail });
};

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end)
      throw new Error(`timed out; last value ${JSON.stringify(v).slice(0, 2_000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The demo spec plus a backend criterion, so the plan selects frontend + backend + qa. */
function fullStack(base: FakeResponder): FakeResponder {
  return (req, i) => {
    const r = base(req, i);
    const out = r.output as { acceptanceCriteria?: { citations: string[] }[] } | undefined;
    if (!out?.acceptanceCriteria?.[0]) return r;
    const citations = out.acceptanceCriteria[0].citations;
    return {
      ...r,
      output: {
        ...out,
        acceptanceCriteria: [
          ...out.acceptanceCriteria,
          {
            id: "AC2",
            text: "The GET /api/reports.csv endpoint returns the invoices as CSV",
            verification: "test",
            citations,
          },
        ],
      },
    };
  };
}

let mimir: MimirChild | undefined;
let app: FastifyInstance | undefined;
let db: SqliteDatabase | undefined;
const dirs: string[] = [];
afterAll(async () => {
  await app?.close();
  db?.close();
  await mimir?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (steps.length > 0) {
    const w = Math.max(...steps.map((s) => s.step.length));
    const table = [
      "factory acceptance run:",
      ...steps.map((s) => `${s.step.padEnd(w)}  ${s.status.padEnd(7)}  ${s.detail}`),
    ].join("\n");
    // Vitest hides console output of passing tests; write straight to the terminal.
    process.stdout.write(table + "\n");
    const out = process.env["SINDRI_ACCEPTANCE_OUT"];
    if (out) writeFileSync(out, table + "\n");
  }
});

describe.skipIf(!MIMIR_MAIN)(
  MIMIR_MAIN
    ? `factory run against Mimir at ${MIMIR_MAIN}`
    : `factory run (skipped: ${SKIP_REASON})`,
  () => {
    it("runs ticket to trace against a real Mimir", { timeout: 900_000 }, async () => {
      const root = mkdtempSync(join(tmpdir(), "sindri-acceptance-"));
      dirs.push(root);
      const sindriDir = join(root, "sindri");
      mimir = await startMimirChild(MIMIR_MAIN!, join(root, "mimir"));
      const provider = new FakeProvider(demoPlanResponder(fullStack(demoResponder())));
      db = openDatabase(join(root, "sindri.db"));
      const boot = () =>
        buildServer({
          db: db!,
          dataDir: sindriDir,
          authToken: TOKEN,
          providerFactory: () => provider,
          secrets: { get: (k) => Promise.resolve(k === SECRET ? mimir!.token : undefined) },
          approval: { pairingCode: PAIRING_CODE },
        });
      app = boot();
      let n = 0;
      const call = (o: InjectOptions) => {
        const method = (o.method ?? "GET").toUpperCase();
        return app!.inject({
          ...o,
          headers: {
            authorization: `Bearer ${TOKEN}`,
            ...(method === "GET" ? {} : { "idempotency-key": `acc-${++n}` }),
            ...(o.headers as Record<string, string> | undefined),
          },
        });
      };
      // Approvals need an approval secret minted with the pairing code; sessions live in server
      // memory, so a restarted server needs a new one (audit M9).
      let approval: { app: FastifyInstance; secret: string } | undefined;
      const approvalHeaders = async () => {
        if (!approval || approval.app !== app) {
          const res = await app!.inject({
            method: "POST",
            url: "/v1/approval-session",
            headers: { authorization: `Bearer ${TOKEN}` },
            payload: { pairingCode: PAIRING_CODE, channel: "web" },
          });
          expect(res.statusCode, res.body).toBe(201);
          approval = { app: app!, secret: res.json().approvalSecret as string };
        }
        return { "x-sindri-approval": approval.secret };
      };
      const ok = async (o: InjectOptions, status = 200) => {
        const r = await call(o);
        expect(r.statusCode, `${o.method ?? "GET"} ${o.url}: ${r.body}`).toBe(status);
        return r.json();
      };

      // 0. Compatibility: Mimir answers GET /v1/capabilities with protocol 1.
      const caps = await mimir.api<{ protocolVersion: number; serverVersion: string }>(
        "/v1/capabilities",
      );
      expect(caps.protocolVersion).toBe(1);
      record(
        "mimir capabilities",
        "ok",
        `protocol ${caps.protocolVersion}, server ${caps.serverVersion}`,
      );

      // 1. Sample repo with a planted failing test; project, bootstrap, ticket import.
      const repo = writeDemoRepo(join(root, "demo"), { failingTest: true });

      const manifestPath = join(repo.repoPath, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.scripts["docs:links"] = "node --test";
      manifest.scripts["docs:examples"] = "node --test";
      writeFileSync(manifestPath, JSON.stringify(manifest));
      execFileSync("git", ["add", "package.json"], { cwd: repo.repoPath });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Acceptance",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "Fixture documentation checks",
        ],
        { cwd: repo.repoPath },
      );
      const initialSettings = (await ok({ url: "/v1/settings" })).settings;
      await ok({
        method: "PUT",
        url: "/v1/settings",
        payload: { ...initialSettings, brokkrEnabled: true },
      });
      const { project } = await ok(
        {
          method: "POST",
          url: "/v1/projects",
          payload: { name: "Reports", repoPath: repo.repoPath },
        },
        201,
      );
      const boot1 = await ok({
        method: "POST",
        url: `/v1/projects/${project.id}/bootstrap`,
        payload: {},
      });
      const { intake } = await ok(
        { method: "POST", url: "/v1/intakes", payload: { projectId: project.id, ...DEMO_TICKET } },
        201,
      );
      record(
        "ticket imported",
        "ok",
        `manual intake ${intake.id}; bootstrap indexed ${boot1.result.indexed.length}`,
      );

      // 2. Spec: draft from the ticket, answer the blocking question, submit, approve.
      const draft = await ok(
        {
          method: "POST",
          url: "/v1/director/draft",
          payload: { projectId: project.id, intakeId: intake.id, request: DEMO_TICKET.title },
        },
        201,
      );
      const answered = await ok(
        {
          method: "POST",
          url: `/v1/specs/${draft.spec.id}/answer`,
          payload: { questionId: "Q1", answer: "id, customer and total" },
        },
        201,
      );
      const specId = answered.spec.id as string;
      await ok({ method: "POST", url: `/v1/specs/${specId}/submit`, payload: {} });
      const spec = (
        await ok({
          method: "POST",
          url: `/v1/specs/${specId}/approve`,
          payload: {},
          headers: await approvalHeaders(),
        })
      ).spec;
      record("spec approved", "ok", `spec ${spec.id} v${spec.version}`);

      // 3. Plan with harness selection, approved.
      let proposed = await ok(
        { method: "POST", url: "/v1/plans/propose", payload: { specId } },
        201,
      );
      // Deterministic fixtures consume no model tokens. Keep only the documented wall-clock
      // metadata; production monetary/token budgets explicitly block unknown usage.
      proposed = await ok(
        {
          method: "POST",
          url: `/v1/plans/${proposed.plan.id}/revise`,
          payload: {
            tasks: proposed.plan.tasks.map((t: object) => ({
              ...t,
              budget: { wallClockMinutes: 10 },
            })),
          },
        },
        201,
      );
      await ok({ method: "POST", url: `/v1/plans/${proposed.plan.id}/submit`, payload: {} });
      const plan = (
        await ok({
          method: "POST",
          url: `/v1/plans/${proposed.plan.id}/approve`,
          payload: {},
          headers: await approvalHeaders(),
        })
      ).plan;
      const harnesses = [...new Set(plan.tasks.map((t: { harnessId: string }) => t.harnessId))];
      expect(harnesses).toEqual(
        expect.arrayContaining(["frontend-react", "backend-node", "qa-regression"]),
      );
      record(
        "plan approved",
        "ok",
        `plan ${plan.id} v${plan.version}; ${plan.tasks.length} tasks; harnesses ${harnesses.join(", ")}`,
      );

      // 4. Connect to Mimir and submit.
      const st = (await ok({ url: "/v1/settings" })).settings;
      await ok({
        method: "PUT",
        url: "/v1/settings",
        payload: { ...st, mimirUrl: mimir.url, mimirTokenSecret: SECRET },
      });
      const status = await ok({ url: "/v1/mimir/status" });
      expect(status).toMatchObject({ configured: true, reachable: true });
      const { execution } = await ok(
        { method: "POST", url: "/v1/executions", payload: { planId: plan.id } },
        201,
      );
      const { crews } = await mimir.api<{ crews: unknown[] }>(
        `/v1/crews?missionId=${execution.mimirMissionId}`,
      );
      expect(crews.length).toBeGreaterThan(1);
      record(
        "mission submitted",
        crews.length > 1 ? "ok" : "blocked",
        `mission ${execution.mimirMissionId}; ${crews.length} crews`,
      );

      const events = async () => {
        const out: { type: string; taskId?: string; payload: Record<string, unknown> }[] = [];
        let cursor: string | null = null;
        do {
          const q = `/v1/events?missionId=${execution.mimirMissionId}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
          const page: { events: typeof out; nextCursor: string | null } = await mimir!.api(q);
          out.push(...page.events);
          cursor = page.nextCursor;
        } while (cursor);
        return out;
      };
      const statusOf = async () =>
        (await ok({ url: `/v1/executions/${execution.id}` })).execution.status as string;

      // 5. Restart Sindri mid-run, once Mimir has completed at least one task.
      await until(events, (es) => es.some((e) => e.type === "task.completed"), 300_000);
      await app.close();
      app = boot();
      await app.ready();
      record("sindri restarted mid-run", "ok", `status after restart ${await statusOf()}`);

      const final = await until(
        statusOf,
        (s) => !["running", "submitted", "planned", "pending"].includes(s),
        600_000,
      );
      expect(final).toBe("verified_pending_review");
      record("execution settled", "ok", `status ${final}`);

      // 6. Evidence from Mimir: test runs and diffs per task; the planted failure repaired.
      const es = await events();
      const runs = es.filter((e) => e.type === "test.run_completed");
      const diffs = es.filter(
        (e) => e.type === "artifact.recorded" && e.payload["kind"] === "diff",
      );
      expect(runs.length).toBeGreaterThan(0);
      expect(diffs.length).toBeGreaterThan(0);
      record(
        "test + diff evidence",
        runs.length > 0 && diffs.length > 0 ? "ok" : "blocked",
        `${runs.length} test.run_completed, ${diffs.length} diff artifacts`,
      );
      const failed = runs.find((e) => e.payload["passed"] === false);
      const repaired =
        failed !== undefined &&
        runs.some(
          (e) =>
            e.taskId === failed.taskId &&
            e.payload["passed"] === true &&
            runs.indexOf(e) > runs.indexOf(failed),
        );
      record(
        "planted failure repaired",
        repaired ? "ok" : "blocked",
        failed
          ? `task ${failed.taskId} failed ${String(failed.payload["command"])} then ${repaired ? "passed on retry" : "did not pass"}`
          : "no failing run observed",
      );
      expect(repaired).toBe(true);

      // 7. Quality gates (Brokkr verdict + independent review) on the verified execution.
      const gates = await until(
        async () =>
          (await ok({ url: `/v1/executions/${execution.id}` })).gates as {
            planTaskId: string;
            passed: boolean;
          }[],
        (g) => g.length === plan.tasks.length,
        120_000,
      );
      const inbox = await ok({ url: `/v1/reviews?projectId=${project.id}` });
      const reasons = [
        ...new Set((inbox.gateFailures as { reason: string }[]).map((g) => g.reason)),
      ];
      record(
        "quality gates",
        gates.every((g) => g.passed) ? "ok" : "blocked",
        `${gates.filter((g) => g.passed).length}/${gates.length} passed; failures: ${reasons.join(", ") || "none"}; review findings: ${(inbox.findings as { message: string }[]).map((f) => f.message).join(", ") || "none"}`,
      );

      expect(
        gates.every((g) => g.passed),
        JSON.stringify(reasons),
      ).toBe(true);

      // 8. PR request (Mimir records a local delivery when there is no remote).
      let pr = await call({
        method: "POST",
        url: `/v1/executions/${execution.id}/pr`,
        headers: await approvalHeaders(),
      });
      expect(pr.statusCode, pr.body).toBe(200);
      expect(pr.json().pr.status).toBe("built");
      const requests = pr.json().pr.prs as { approvalId: string; status: string }[];
      expect(requests.every((p) => p.status === "awaiting_approval")).toBe(true);
      expect(
        (
          await call({
            method: "POST",
            url: `/v1/deliveries/${execution.id}/proposals`,
            headers: await approvalHeaders(),
          })
        ).statusCode,
      ).toBe(409);
      for (const p of requests) {
        await ok({
          method: "POST",
          url: `/v1/executions/${execution.id}/approvals/${p.approvalId}`,
          headers: await approvalHeaders(),
          payload: { decision: "approved" },
        });
      }
      pr = await call({
        method: "POST",
        url: `/v1/executions/${execution.id}/pr`,
        headers: await approvalHeaders(),
      });
      expect(pr.statusCode, pr.body).toBe(200);
      expect(pr.json().pr.prs.every((p: { status: string }) => p.status === "requested")).toBe(
        true,
      );
      expect(pr.json().pr.status).toBe("delivered_pending_merge");

      record(
        "PR requested",
        pr.statusCode === 200 ? "ok" : "blocked",
        `HTTP ${pr.statusCode} ${pr.statusCode === 200 ? JSON.stringify(pr.json().pr.status) : JSON.stringify(pr.json().error)}`,
      );

      // 9. Delivery report and trace: ticket -> spec v -> plan v -> mission -> task events -> artifacts.
      const delivery = await call({ url: `/v1/deliveries/${execution.id}` });
      record(
        "delivery report",
        delivery.statusCode === 200 ? "ok" : "blocked",
        `HTTP ${delivery.statusCode}`,
      );
      const traceRes = await call({ url: `/v1/deliveries/${execution.id}/trace` });
      expect(traceRes.statusCode, traceRes.body).toBe(200);
      const trace = traceRes.json().trace;
      expect(trace.ticket?.id ?? trace.ticket?.intakeId).toBeTruthy();
      expect(trace.spec).toMatchObject({ id: spec.id, version: spec.version });
      expect(trace.plan).toMatchObject({ id: plan.id, version: plan.version });
      expect(trace.mission.id).toBe(execution.mimirMissionId);
      const traced = trace.tasks as { events: unknown[]; artifacts: unknown[] }[];
      expect(traced.length).toBe(plan.tasks.length);
      expect(traced.every((t) => t.events.length > 0)).toBe(true);
      expect(traced.some((t) => t.artifacts.length > 0)).toBe(true);
      record(
        "trace",
        "ok",
        `ticket ${trace.ticket?.id ?? "?"} -> spec v${trace.spec.version} -> plan v${trace.plan.version} -> mission ${trace.mission.id} -> ${traced.length} tasks, ${traced.reduce((n, t) => n + t.events.length, 0)} events, ${traced.reduce((n, t) => n + t.artifacts.length, 0)} artifacts`,
      );

      // 10. Proposals remain pending until a human approves their evidence-backed claims.
      const proposedKnowledge = await ok({
        method: "POST",
        url: `/v1/deliveries/${execution.id}/proposals`,
        headers: await approvalHeaders(),
      });
      expect(proposedKnowledge.proposals.length).toBeGreaterThan(0);
      expect(
        proposedKnowledge.proposals.every(
          (p: { sourceRefs: unknown[] }) => p.sourceRefs.length > 0,
        ),
      ).toBe(true);
      record("knowledge proposed", "ok", `${proposedKnowledge.proposals.length} sourced proposals`);
    });
  },
);
