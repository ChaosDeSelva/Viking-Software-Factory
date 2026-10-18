import type {
  DeliveryDetail,
  LocalDelivery,
  DryRun,
  ExecutionDetail,
  ExecutionStreamMessage,
  ExecutionSummary,
  ExplainInput,
  HarnessSource,
  HarnessSummary,
  MimirStatus,
  Plan,
  PlanTask,
  PlanVersion,
  PrDelivery,
  RepoSignals,
  ReviewsInbox,
  Selection,
  EscalationDecision,
  TaskGate,
  TraceDocument,
} from "./delivery-types.js";

type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

const enc = encodeURIComponent;
const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

const FRAME_KINDS: Record<string, ExecutionStreamMessage["kind"]> = {
  "execution.snapshot": "snapshot",
  "execution.event": "event",
  "execution.notice": "notice",
};

/** Parse one SSE frame (`event:` + `data:` lines); comments and unknown events give null. */
export function parseFrame(frame: string): ExecutionStreamMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  const kind = FRAME_KINDS[event];
  if (!kind || data.length === 0) return null;
  try {
    return { kind, data: JSON.parse(data.join("\n")) } as ExecutionStreamMessage;
  } catch {
    return null;
  }
}

/**
 * Client methods for plans, harnesses, executions, reviews and deliveries. The execution stream
 * is read with fetch (not EventSource) so the bearer token stays in a header.
 */
export function deliveryMethods(call: Call, send: Send) {
  return {
    proposePlan: (specId: string) =>
      call<{ plan: Plan; versions: PlanVersion[]; harnessSource: HarnessSource }>(
        "POST",
        "/v1/plans/propose",
        { specId },
      ),
    listPlans: async (projectId: string) =>
      (await call<{ plans: Plan[] }>("GET", `/v1/plans?${qs({ projectId })}`)).plans,
    getPlan: (id: string) =>
      call<{ plan: Plan; versions: PlanVersion[] }>("GET", `/v1/plans/${enc(id)}`),
    dryRunPlan: async (id: string) =>
      (await call<{ dryRun: DryRun }>("GET", `/v1/plans/${enc(id)}/dry-run`)).dryRun,
    submitPlan: async (id: string) =>
      (await call<{ plan: Plan }>("POST", `/v1/plans/${enc(id)}/submit`)).plan,
    approvePlan: async (id: string) =>
      (await call<{ plan: Plan }>("POST", `/v1/plans/${enc(id)}/approve`, {})).plan,
    revisePlan: async (id: string, tasks: PlanTask[]) =>
      (await call<{ plan: Plan }>("POST", `/v1/plans/${enc(id)}/revise`, { tasks })).plan,

    listHarnesses: () =>
      call<{ source: HarnessSource; harnesses: HarnessSummary[] }>("GET", "/v1/harnesses"),
    getHarness: (name: string) =>
      call<{ source: HarnessSource; name: string; versions: HarnessSummary[] }>(
        "GET",
        `/v1/harnesses/${enc(name)}`,
      ),
    repoSignals: async (projectId: string) =>
      (
        await call<{ signals: RepoSignals }>(
          "GET",
          `/v1/harnesses/repo-signals?${qs({ projectId })}`,
        )
      ).signals,
    explainHarness: (input: ExplainInput) =>
      call<{ source: HarnessSource; selection: Selection; explanation: string[] }>(
        "POST",
        "/v1/harnesses/explain",
        input,
      ),

    createExecution: (planId: string) =>
      call<ExecutionDetail>("POST", "/v1/executions", { planId }),
    listExecutions: async (projectId: string) =>
      (await call<{ executions: ExecutionSummary[] }>("GET", `/v1/executions?${qs({ projectId })}`))
        .executions,
    getExecution: (id: string) => call<ExecutionDetail>("GET", `/v1/executions/${enc(id)}`),
    decideApproval: (
      executionId: string,
      approvalId: string,
      decision: "approved" | "rejected",
      reason?: string,
    ) =>
      call<{ approval: unknown }>(
        "POST",
        `/v1/executions/${enc(executionId)}/approvals/${enc(approvalId)}`,
        reason ? { decision, reason } : { decision },
      ),
    resolveEscalation: (
      executionId: string,
      planTaskId: string,
      decision: EscalationDecision,
      reason: string,
    ) =>
      call<ExecutionDetail>(
        "POST",
        `/v1/executions/${enc(executionId)}/escalations/${enc(planTaskId)}`,
        { decision, reason },
      ),
    requestPr: async (executionId: string) =>
      (await call<{ pr: PrDelivery }>("POST", `/v1/executions/${enc(executionId)}/pr`)).pr,
    assessExecution: async (executionId: string) =>
      (await call<{ gates: TaskGate[] }>("POST", `/v1/executions/${enc(executionId)}/assess`))
        .gates,
    /** Reads the execution SSE relay until it ends or `signal` aborts. */
    async streamExecution(
      executionId: string,
      onMessage: (m: ExecutionStreamMessage) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const res = await send("GET", `/v1/executions/${enc(executionId)}/events`);
      const reader = res.body?.getReader();
      if (!reader) return;
      // Aborted while the request was in flight: the abort event has already fired.
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      const onAbort = () => void reader.cancel().catch(() => undefined);
      signal.addEventListener("abort", onAbort, { once: true });
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const m = parseFrame(buf.slice(0, i));
            buf = buf.slice(i + 2);
            if (m && !signal.aborted) onMessage(m);
          }
        }
      } catch (err) {
        if (!signal.aborted) throw err;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    reviews: (projectId: string) => call<ReviewsInbox>("GET", `/v1/reviews?${qs({ projectId })}`),
    listDeliveries: async (projectId: string) =>
      (await call<{ deliveries: ExecutionSummary[] }>("GET", `/v1/deliveries?${qs({ projectId })}`))
        .deliveries,
    getDelivery: (id: string) => call<DeliveryDetail>("GET", `/v1/deliveries/${enc(id)}`),
    localDelivery: async (id: string) =>
      (await call<{ result: LocalDelivery | null }>("GET", `/v1/deliveries/${enc(id)}/local`))
        .result,
    deliveryTrace: async (id: string) =>
      (await call<{ trace: TraceDocument }>("GET", `/v1/deliveries/${enc(id)}/trace`)).trace,

    mimirStatus: () => call<MimirStatus>("GET", "/v1/mimir/status"),
  };
}

/** Method names, for test mocks. */
export const DELIVERY_METHOD_NAMES = [
  "proposePlan",
  "listPlans",
  "getPlan",
  "dryRunPlan",
  "submitPlan",
  "approvePlan",
  "revisePlan",
  "listHarnesses",
  "getHarness",
  "repoSignals",
  "explainHarness",
  "createExecution",
  "listExecutions",
  "getExecution",
  "decideApproval",
  "resolveEscalation",
  "requestPr",
  "assessExecution",
  "streamExecution",
  "reviews",
  "listDeliveries",
  "getDelivery",
  "localDelivery",
  "deliveryTrace",
  "mimirStatus",
] as const satisfies readonly (keyof ReturnType<typeof deliveryMethods>)[];
