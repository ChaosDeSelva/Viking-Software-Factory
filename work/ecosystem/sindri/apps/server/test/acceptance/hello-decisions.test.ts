import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, type FakeResponder } from "@sindri/director";
import { openDatabase, type ProjectDecision } from "@sindri/knowledge";
import type { InjectOptions } from "fastify";
import { expect, it } from "vitest";
import { buildServer } from "../../src/app.js";
import { contextIdsOf } from "../../src/demo-responder.js";
import { demoPlanResponder } from "../../src/demo-plan-responder.js";
import { findMimirMain, startMimirChild } from "./mimir-child.js";

const source = process.env["SINDRI_ACCEPTANCE_HELLO_REPO"];
const main = findMimirMain();
const choice = {
  title: "Public greeting fallback",
  decision: "Use world for an anonymous greeting.",
  rationale: "Clients can omit a name.",
};
const duringBuild = {
  title: "Whitespace normalization",
  decision: "Trim supplied names before choosing the default greeting.",
  rationale: "A name containing only spaces is empty.",
};
const responder =
  (proposeGreeting: boolean, firstPlan: boolean): FakeResponder =>
  (req, index) => {
    if (req.metadata?.purpose === "plan" || req.metadata?.purpose === "delivery_summary") {
      const r = demoPlanResponder()(req, index);
      if (req.metadata.purpose === "plan") {
        const out = r.output as { tasks: { objective: string }[]; designDecisions?: unknown[] };
        if (firstPlan) out.designDecisions = [{ ...duringBuild, citations: ["ac:AC1"] }];
        for (const task of out.tasks)
          task.objective = task.objective.replace("reports CSV export", "greeting fallback");
      }
      return r;
    }
    if (req.metadata?.purpose === "classify")
      return { output: { kind: "bug", impactedAreas: [], confidence: 1 } };
    const citations = [contextIdsOf(req).find((id) => id.startsWith("intake:")) ?? "request"];
    return {
      output: {
        title: "Handle blank names in the greeting API",
        problem: { text: "GET /greet emits Hello, null! without a name.", citations },
        goals: [{ text: "Provide the documented default greeting and trim names", citations }],
        nonGoals: [],
        constraints: [],
        risks: [],
        assumptions: [],
        acceptanceCriteria: [
          {
            id: "AC1",
            text: "The GET /greet API returns Hello, world! for absent and blank names and trims named requests.",
            verification: "test",
            citations,
          },
        ],
        designDecisions: proposeGreeting ? [{ ...choice, citations }] : [],
        openQuestions: [],
      },
    };
  };

it.skipIf(!source || !main)(
  "freezes hello-factory decisions at first writable verification and delivers later changes in the follow-up",
  { timeout: 240_000 },
  async (ctx) => {
    if (!source || !main || !existsSync(join(source, "examples/02-greeting-bug.md")))
      throw new Error("Set SINDRI_ACCEPTANCE_HELLO_REPO to a hello-factory checkout");
    const root = mkdtempSync(join(tmpdir(), "sindri-hello-decisions-"));
    ctx.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const clone = join(root, "hello");
    const git = (args: string[], input?: string, cwd = clone) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
      });
    const db = openDatabase(join(root, "state.db"));
    ctx.onTestFinished(() => {
      db.close();
    });
    const mimirDir = join(root, "mimir");
    const child = await startMimirChild(
      main,
      mimirDir,
      new URL("./hello-agent.mjs", import.meta.url),
    );
    ctx.onTestFinished(() => child.close());
    const resume = (stage: "build" | "verify") =>
      writeFileSync(join(mimirDir, `hello-${stage}.continue`), "");
    const waitAt = async (stage: "build" | "verify") => {
      const path = join(mimirDir, `hello-${stage}.started`);
      await expect.poll(() => existsSync(path), { timeout: 50_000, interval: 50 }).toBe(true);
      return readFileSync(path, "utf8");
    };
    const token = "d".repeat(64);
    const planPrompts: string[] = [];
    let proposeGreeting = true;
    const app = buildServer({
      db,
      dataDir: join(root, "sindri"),
      authToken: token,
      providerFactory: () =>
        new FakeProvider((req, index) => {
          if (req.metadata?.purpose === "plan") {
            planPrompts.push(req.messages.map((m) => m.content).join("\n"));
          }
          return responder(proposeGreeting, planPrompts.length === 1)(req, index);
        }),
      secrets: { get: async (k) => (k === "mimir.token" ? child.token : undefined) },
      approval: { pairingCode: "HELLO-TEST1" },
    });
    ctx.onTestFinished(() => app.close());
    ctx.onTestFinished(() => {
      resume("build");
      resume("verify");
    });
    execFileSync("git", ["clone", "--quiet", "--no-local", source, clone]);
    git(["remote", "remove", "origin"]);
    const title = "Greeting without a name says Hello, null!";
    const ticket = readFileSync(join(clone, "examples/02-greeting-bug.md"), "utf8");
    let seq = 0,
      approval = "";
    async function call(
      url: string,
      method: "GET" | "POST" | "PUT" = "GET",
      payload?: unknown,
      status = 200,
      key?: string,
    ) {
      const res = await app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === "GET" ? {} : { "idempotency-key": key ?? `test-${++seq}` }),
          ...(approval ? { "x-sindri-approval": approval } : {}),
        },
        ...(payload !== undefined ? { payload: payload as InjectOptions["payload"] } : {}),
      } as InjectOptions);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
      return res.json();
    }
    approval = (
      await call(
        "/v1/approval-session",
        "POST",
        { pairingCode: "HELLO-TEST1", channel: "web" },
        201,
      )
    ).approvalSecret;
    const settings = (await call("/v1/settings")).settings;
    await call("/v1/settings", "PUT", {
      ...settings,
      mimirUrl: child.url,
      mimirTokenSecret: "mimir.token",
      brokkrEnabled: true,
    });
    const { project } = await call(
      "/v1/projects",
      "POST",
      { name: "Hello Factory", repoPath: clone },
      201,
    );
    const log = `/v1/projects/${project.id}/decision-log`;
    await call(`/v1/projects/${project.id}/bootstrap`, "POST", {});
    async function draftTicket(projectId: string, ticketTitle: string, body: string) {
      const { intake } = await call(
        "/v1/intakes",
        "POST",
        { projectId, title: ticketTitle, body },
        201,
      );
      const { spec } = await call(
        "/v1/director/draft",
        "POST",
        { projectId, intakeId: intake.id, request: ticketTitle },
        201,
      );
      return { intake, spec };
    }
    const { intake, spec } = await draftTicket(project.id, title, ticket);
    proposeGreeting = false;
    const proposed = (await call(log)).entries.find(
      (e: ProjectDecision) => e.title === choice.title,
    );
    expect(proposed).toMatchObject({ status: "proposed", decision: choice.decision });
    await call(`${log}/${proposed.id}/decision`, "POST", { decision: "accepted" });
    async function approvePlan(specId: string) {
      await call(`/v1/specs/${specId}/submit`, "POST", {});
      await call(`/v1/specs/${specId}/approve`, "POST", {});
      const before = planPrompts.length;
      const { plan: draft } = await call("/v1/plans/propose", "POST", { specId }, 201);
      expect(planPrompts).toHaveLength(before + 1);
      // This dependency-free service has API and regression checks, and no documentation build.
      const tasks = draft.tasks
        .filter((t: { role: string }) => t.role !== "docs")
        .map((t: { dependsOn: string[] }) => ({
          ...t,
          dependsOn: t.dependsOn.filter((id) => id !== "docs"),
        }));
      const { plan } = await call(`/v1/plans/${draft.id}/revise`, "POST", { tasks }, 201);
      await call(`/v1/plans/${plan.id}/submit`, "POST", {});
      await call(`/v1/plans/${plan.id}/approve`, "POST", {});
      return {
        id: plan.id as string,
        draftId: draft.id as string,
        tasks: plan.tasks as unknown[],
        prompt: planPrompts[before]!,
      };
    }
    const plan = await approvePlan(spec.id);
    expect(plan.prompt).toContain(choice.decision);
    const submit = async (planId: string, key: string) =>
      (await call("/v1/executions", "POST", { planId }, 201, key)).execution;
    const first = await submit(plan.id, "run-one");
    const mission = async (id: string) =>
      (
        await child.api<{
          mission: {
            decisionLogAtVerification?: boolean;
            decisionLogRequested?: boolean;
            decisionLogPinned?: boolean;
            decisionLogRef?: string;
          };
        }>(`/v1/missions/${id}`)
      ).mission;
    await waitAt("build");
    const building = await mission(first.mimirMissionId);
    expect(building.decisionLogAtVerification).toBe(true);
    expect(building.decisionLogRequested).not.toBe(true);
    expect(building.decisionLogRef).toBeUndefined();
    const normalization = (await call(log)).entries.find(
      (entry: ProjectDecision) => entry.title === duringBuild.title,
    );
    expect(normalization).toMatchObject({
      actor: "Planner",
      status: "proposed",
      decision: duringBuild.decision,
    });
    expect(normalization.source).toContain(`plan:${plan.draftId}`);
    expect(normalization.source).toContain("ac:AC1");
    await call(`${log}/${normalization.id}/decision`, "POST", { decision: "accepted" });
    const privateProposal = await call(
      log,
      "POST",
      {
        title: "Private proposal",
        decision: "Private choice",
        rationale: "Sensitive rationale",
        source: "Private note",
      },
      201,
    );
    const otherRepo = join(root, "other");
    execFileSync("git", ["clone", "--quiet", "--no-local", clone, otherRepo]);
    const other = (await call("/v1/projects", "POST", { name: "Other", repoPath: otherRepo }, 201))
      .project;
    await call(`/v1/projects/${other.id}/bootstrap`, "POST", {});
    const otherLog = `/v1/projects/${other.id}/decision-log`;
    const foreign = await call(
      otherLog,
      "POST",
      {
        title: "Foreign rule",
        decision: "Use the other queue",
        rationale: "Other product",
        source: "Other issue",
      },
      201,
    );
    await call(`${otherLog}/${foreign.id}/decision`, "POST", { decision: "accepted" });
    resume("build");
    const verifyingWorkspace = await waitAt("verify");
    const pinned = await mission(first.mimirMissionId);
    expect(pinned).toMatchObject({ decisionLogRequested: true, decisionLogPinned: true });
    expect(pinned.decisionLogRef).toMatch(/^[0-9a-f]{64}$/);
    const verifiedSpec = readFileSync(join(verifyingWorkspace, "SPEC.md"), "utf8");
    const verifiedText = verifiedSpec.replaceAll("\\.", ".");
    expect(verifiedText).toContain(choice.decision);
    expect(verifiedText).toContain(duringBuild.decision);
    const replacement = await call(
      log,
      "POST",
      {
        title: "Fallback scope",
        decision: "Apply the default greeting to the public service only.",
        rationale: "Other services own their own names.",
        source: "Internal note 21",
        supersedesId: proposed.id,
      },
      201,
    );
    await call(`${log}/${replacement.id}/decision`, "POST", { decision: "accepted" });
    expect((await submit(plan.id, "run-one")).id).toBe(first.id);
    const otherTicket = await draftTicket(
      other.id,
      "Fix the sibling service's anonymous greeting",
      ticket,
    );
    const otherPlan = await approvePlan(otherTicket.spec.id);
    expect(otherPlan.prompt).toContain("Use the other queue");
    expect(otherPlan.prompt).not.toMatch(
      /Public greeting fallback|Whitespace normalization|Fallback scope/,
    );
    const otherExecution = await submit(otherPlan.id, "run-other-project");
    resume("verify");
    const deliver = async (id: string, taskCount: number) => {
      const end = Date.now() + 80_000;
      let state;
      do {
        state = await call(`/v1/executions/${id}`);
        if (
          !["running", "submitted", "planned", "pending"].includes(state.execution.status) &&
          (state.execution.status !== "verified_pending_review" || state.gates.length === taskCount)
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      } while (Date.now() < end);
      expect(state.execution.status, JSON.stringify(state).slice(0, 6000)).toBe(
        "verified_pending_review",
      );
      expect(state.gates.length).toBeGreaterThan(0);
      expect(
        state.gates.every((g: { passed: boolean }) => g.passed),
        JSON.stringify(state.gates),
      ).toBe(true);
      const path = `/v1/executions/${id}`;
      const pending = await call(path + "/pr", "POST", {});
      for (const request of pending.pr.prs)
        await call(path + "/approvals/" + request.approvalId, "POST", { decision: "approved" });
      await call(path + "/pr", "POST", {});
      const { result } = await call(`/v1/deliveries/${id}/local`);
      expect(typeof result.patch).toBe("string");
      expect((await call(`/v1/deliveries/${id}/local`)).result.patch).toBe(result.patch);
      expect(result.patch).not.toMatch(/Private choice|Other issue|Internal note 21/);
      return result as { patch: string; followUp?: { patch: string } };
    };
    const apply = (cwd: string, patch: string) => {
      git(["apply", "--check", "-"], patch, cwd);
      git(["apply", "-"], patch, cwd);
      execFileSync(process.execPath, ["--test"], { cwd, stdio: "pipe" });
      return readFileSync(join(cwd, "SPEC.md"), "utf8");
    };
    const applied = join(root, "applied");
    execFileSync("git", ["clone", "--quiet", "--no-local", clone, applied]);
    const initialDelivery = await deliver(first.id, plan.tasks.length);
    const one = apply(applied, initialDelivery.patch);
    expect(one).toBe(verifiedSpec);
    expect(one.match(/<!-- decision:/g)).toHaveLength(2);
    expect(one).not.toContain("Fallback scope");
    expect(initialDelivery.patch).not.toContain("Foreign rule");
    expect((await mission(first.mimirMissionId)).decisionLogRef).toBe(pinned.decisionLogRef);
    expect(git(["diff", "--", "services/greeter/server.mjs"], undefined, applied)).toContain(
      "?.trim()",
    );
    const otherDelivery = await deliver(otherExecution.id, otherPlan.tasks.length);
    const otherRecipient = join(root, "other-recipient");
    execFileSync("git", ["clone", "--quiet", "--no-local", otherRepo, otherRecipient]);
    const otherSpec = apply(otherRecipient, otherDelivery.patch);
    expect(otherSpec).toContain("Foreign rule");
    expect(otherSpec).toContain("Use the other queue");
    expect(otherSpec.match(/<!-- decision:/g)).toHaveLength(1);
    expect(otherSpec).not.toMatch(
      /Public greeting fallback|Whitespace normalization|Fallback scope/,
    );
    expect(git(["status", "--porcelain"], undefined, otherRepo)).toBe("");
    const nextTicket = await draftTicket(
      project.id,
      "Cover the greeting for a padded name",
      "Check the public greeting API when a caller pads a name with whitespace.",
    );
    expect(nextTicket.intake.id).not.toBe(intake.id);
    const ticketPlan = await approvePlan(nextTicket.spec.id);
    const checkPlanningContext = (prompt: string) => {
      expect(prompt).toContain(`decision:${normalization.id}`);
      expect(prompt).toContain(duringBuild.decision);
      expect(prompt).toContain(`decision:${replacement.id}`);
      expect(prompt).not.toContain(`decision:${proposed.id}`);
      expect(prompt).not.toMatch(/Foreign rule|Use the other queue|Private choice/);
    };
    checkPlanningContext(ticketPlan.prompt);
    const rework = await call(
      `/v1/deliveries/${first.id}/rework`,
      "POST",
      { feedback: "Document the revised scope of the default greeting." },
      201,
    );
    const nextPlan = await approvePlan(rework.spec.id);
    checkPlanningContext(nextPlan.prompt);
    const second = await submit(nextPlan.id, "run-two");
    expect(second.id).not.toBe(first.id);
    const next = await deliver(second.id, nextPlan.tasks.length);
    expect(next.patch).not.toContain("Foreign rule");
    const fresh = join(root, "fresh");
    execFileSync("git", ["clone", "--quiet", "--no-local", clone, fresh]);
    const two = apply(fresh, next.patch);
    expect(next.followUp?.patch).toBeTruthy();
    expect(apply(applied, next.followUp!.patch)).toBe(two);
    expect(two).toContain("Fallback scope");
    expect(two).toContain(choice.title);
    expect(two).toContain(duringBuild.title);
    expect(two).toContain("superseded");
    expect(two.match(/<!-- decision:/g)).toHaveLength(4);
    const nextPin = await mission(second.mimirMissionId);
    expect(nextPin.decisionLogPinned).toBe(true);
    expect(nextPin.decisionLogRef).toMatch(/^[0-9a-f]{64}$/);
    expect(nextPin.decisionLogRef).not.toBe(pinned.decisionLogRef);
    expect(
      (await call(log)).entries.find((e: ProjectDecision) => e.id === privateProposal.id).status,
    ).toBe("proposed");
    expect(git(["status", "--porcelain"])).toBe("");
  },
);
