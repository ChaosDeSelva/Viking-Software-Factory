import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.js";
import type { ExecutionStreamMessage } from "./delivery-types.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const client = (fetch: ReturnType<typeof vi.fn>) =>
  createApiClient({
    baseUrl: "",
    getToken: () => "tok",
    fetch: fetch as unknown as typeof globalThis.fetch,
    newKey: () => "k",
  });

describe("delivery api client", () => {
  it("calls the plan routes", async () => {
    const fetch = vi.fn(async () =>
      json(201, { plan: { id: "pl1" }, versions: [], harnessSource: "fake" }),
    );
    const api = client(fetch);
    await expect(api.proposePlan("s/1")).resolves.toMatchObject({ plan: { id: "pl1" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/plans/propose");
    expect(JSON.parse(String(init.body))).toEqual({ specId: "s/1" });
    fetch.mockImplementation(async () => json(200, { plans: [] }));
    await api.listPlans("p1");
    expect((fetch.mock.calls[1] as unknown as [string])[0]).toBe("/v1/plans?projectId=p1");
    fetch.mockImplementation(async () => json(200, { dryRun: { steps: [], order: [] } }));
    await expect(api.dryRunPlan("pl/1")).resolves.toEqual({ steps: [], order: [] });
    expect((fetch.mock.calls[2] as unknown as [string])[0]).toBe("/v1/plans/pl%2F1/dry-run");
  });

  it("creates executions and decides approvals with idempotency keys", async () => {
    const fetch = vi.fn(async () => json(201, { execution: { id: "e1" } }));
    const api = client(fetch);
    await api.createExecution("pl1");
    await api.decideApproval("e1", "apr1", "approved");
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("/v1/executions");
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ planId: "pl1" });
    expect(calls[1]![0]).toBe("/v1/executions/e1/approvals/apr1");
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ decision: "approved" });
    expect(new Headers(calls[1]![1].headers).get("idempotency-key")).toBe("k");
  });

  it("reads the execution SSE relay with the bearer token and parses frames", async () => {
    const body = [
      'event: execution.snapshot\ndata: {"execution":{"id":"e1"},"tasks":[]}\n\n',
      'id: exv_1\nevent: execution.event\ndata: {"id":"exv_1","type":"task.ready"}\n\n: ping\n\n',
      'event: execution.notice\ndata: {"type":"status_changed","executionId":"e1","to":"running"}\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        // Split a frame across chunks to exercise buffering.
        c.enqueue(enc.encode(body[0]!.slice(0, 20)));
        c.enqueue(enc.encode(body[0]!.slice(20)));
        c.enqueue(enc.encode(body[1]!));
        c.enqueue(enc.encode(body[2]!));
        c.close();
      },
    });
    const fetch = vi.fn(async () => new Response(stream, { status: 200 }));
    const api = client(fetch);
    const got: ExecutionStreamMessage[] = [];
    await api.streamExecution("e1", (m) => got.push(m), new AbortController().signal);
    expect(got.map((m) => m.kind)).toEqual(["snapshot", "event", "notice"]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/executions/e1/events");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("delivers nothing when aborted before the response arrives", async () => {
    const ctrl = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('id: a\nevent: execution.event\ndata: {"id":"a"}\n\n'));
        c.close();
      },
    });
    const fetch = vi.fn(async () => {
      ctrl.abort();
      return new Response(stream, { status: 200 });
    });
    const got: ExecutionStreamMessage[] = [];
    await client(fetch).streamExecution("e1", (m) => got.push(m), ctrl.signal);
    expect(got).toEqual([]);
  });
});
