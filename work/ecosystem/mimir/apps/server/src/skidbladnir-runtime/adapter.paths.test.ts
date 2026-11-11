import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { skidbladnirRequester, SkidbladnirRuntime } from "./adapter.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const config = {
  id: "aws-slot",
  url: "http://127.0.0.1:4380",
  template: "general" as const,
  minutes: 15,
  root: "/srv/mimir",
};
const route = { host: config.id, root: config.root };
type Call = { path: string; method: string; headers: Record<string, string>; body?: unknown };
type Handler = (call: Call) => Response | Promise<Response>;
/** A fake Skidbladnir API: each route answers from `routes`, every call is recorded. */
function api(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const call: Call = {
      path,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) =>
      k.startsWith("*") ? path.endsWith(k.slice(1)) : k === path,
    );
    if (!key) throw new Error("Unexpected route " + path);
    return routes[key]!(call);
  });
  return { request, calls };
}
const json = (value: unknown) => () => Response.json(value);
const base = {
  "/api/session": json({ token: "fixture-token" }),
  "/api/workers": json({ id: "w1", state: "starting" }),
  "*/readiness": json({ ready: true, state: "running" }),
  "*/terminate": json({}),
};
const command = (stdout: unknown, extra: Record<string, unknown> = {}) =>
  json({ id: "c1", status: "Success", exitCode: 0, stdout: JSON.stringify(stdout), ...extra });
function stateFile() {
  const root = mkdtempSync(join(tmpdir(), "mimir-skid-paths-"));
  roots.push(root);
  return join(root, "state");
}

it("validates its configuration and job identity before any request", async () => {
  for (const url of [
    "http://localhost:4380",
    "http://user:pw@127.0.0.1:4380",
    "http://127.0.0.1:4380/api",
    "http://127.0.0.1:4380/?x=1",
    "http://127.0.0.1:4380/#x",
  ])
    expect(() => skidbladnirRequester({ ...config, url }, stateFile())).toThrow(/loopback/);
  for (const minutes of [4, 241, 7.5])
    expect(() => skidbladnirRequester({ ...config, minutes }, stateFile())).toThrow(
      "Invalid worker lifetime",
    );
  const { request } = api(base);
  const transport = skidbladnirRequester(config, stateFile(), request);
  for (const jobId of [undefined, "", "../x", "x".repeat(129)])
    expect(
      await transport(route, { operation: "inspect", ...(jobId === undefined ? {} : { jobId }) }),
    ).toEqual({
      state: "unknown",
      reason: "Stable remote job identity required",
    });
  expect(
    await transport(route, {
      operation: "submit",
      jobId: "job-1",
      payload: { blob: "x".repeat(5000) },
    }),
  ).toMatchObject({ state: "unknown", reason: expect.stringContaining("exceeds 4500 bytes") });
  expect(await transport(route, { operation: "inspect", jobId: "job-1" })).toEqual({
    state: "unavailable",
    reason: "No recorded Skidbladnir worker for this job",
  });
  expect(request).not.toHaveBeenCalled();
});

it("reports health only for an AWS-mode controller offering the configured template", async () => {
  for (const [snapshot, ok] of [
    [{ mode: "aws", templates: ["general"] }, true],
    [{ mode: "local", templates: ["general"] }, false],
    [{ mode: "aws", templates: ["node"] }, false],
  ] as const) {
    const { request, calls } = api({ "/api/snapshot": json(snapshot) });
    expect(
      await skidbladnirRequester(config, stateFile(), request)(route, { operation: "health" }),
    ).toEqual({
      state: "confirmed",
      response: { protocol: 1, ok },
    });
    // Reads need no session token.
    expect(calls).toEqual([{ path: "/api/snapshot", method: "GET", headers: {} }]);
  }
});

it("authenticates mutations and reuses the command identity only for submit retries", async () => {
  const { request, calls } = api({
    ...base,
    "*/commands": command({ protocol: 1, ok: true, job: { state: "running" } }),
  });
  const transport = skidbladnirRequester(config, stateFile(), request);
  const submit = { operation: "submit" as const, jobId: "job-1", payload: { n: 1 } };
  expect(await transport(route, submit)).toMatchObject({ state: "confirmed" });
  expect(await transport(route, submit)).toMatchObject({ state: "confirmed" });
  await transport(route, { operation: "inspect", jobId: "job-1" });
  await transport(route, { operation: "inspect", jobId: "job-1" });
  const posts = calls.filter((c) => c.method === "POST");
  expect(posts.every((c) => c.headers["X-Skidbladnir-Token"] === "fixture-token")).toBe(true);
  expect(calls.filter((c) => c.path === "/api/workers")).toHaveLength(1);
  const keys = calls
    .filter((c) => c.path.endsWith("/commands"))
    .map((c) => c.headers["Idempotency-Key"]);
  expect(keys[0]).toBe(keys[1]);
  expect(new Set(keys).size).toBe(3);
  // No terminal job yet: the worker is not retired.
  expect(calls.some((c) => c.path.endsWith("/terminate"))).toBe(false);
});

it("turns every API failure into an unknown outcome, never a confirmed one", async () => {
  const cases: [Record<string, Handler>, string | RegExp][] = [
    [
      { ...base, "/api/session": () => new Response("no", { status: 401 }) },
      "Skidbladnir authentication unavailable",
    ],
    [
      { ...base, "/api/workers": () => new Response("no", { status: 503 }) },
      "Skidbladnir request failed: 503",
    ],
    [{ ...base, "/api/workers": () => new Response(null) }, "Empty Skidbladnir response"],
    [
      { ...base, "/api/workers": () => new Response("x".repeat(2 * 1024 * 1024 + 1)) },
      "Skidbladnir response exceeds limit",
    ],
    [
      { ...base, "*/readiness": json({ ready: false, state: "terminated" }) },
      "AWS worker cannot execute: terminated",
    ],
    [
      { ...base, "*/commands": json({ id: "c1", status: "Failed", exitCode: 0 }) },
      "SSM transport did not confirm completion",
    ],
    [
      { ...base, "*/commands": json({ id: "c1", status: "Success", exitCode: 2 }) },
      "SSM transport did not confirm completion",
    ],
    [
      { ...base, "*/commands": command({ protocol: 2, ok: true }) },
      "Invalid remote protocol response",
    ],
    [
      { ...base, "*/commands": command({ protocol: 1, ok: "yes" }) },
      "Invalid remote protocol response",
    ],
    [{ ...base, "*/commands": json({ id: "c1", status: "Success", exitCode: 0 }) }, /JSON/],
    [
      {
        ...base,
        "/api/workers": () => {
          throw "socket hang up";
        },
      },
      "Skidbladnir transport unavailable",
    ],
  ];
  for (const [routes, reason] of cases) {
    const { request } = api(routes);
    const result = await skidbladnirRequester(
      config,
      stateFile(),
      request,
    )(route, {
      operation: "submit",
      jobId: "job-1",
    });
    expect(result).toMatchObject({ state: "unknown", reason: expect.stringMatching(reason) });
  }
});

it("waits for worker readiness and for the command outcome within one deadline", async () => {
  vi.useFakeTimers({ now: Date.now() });
  let readiness = 0;
  let refreshes = 0;
  const { request, calls } = api({
    ...base,
    "*/readiness": () => Response.json({ ready: ++readiness > 2, state: "pending" }),
    "*/commands": json({ id: "c1", status: "InProgress" }),
    "/api/commands/c1/refresh": () =>
      ++refreshes < 2
        ? Response.json({ id: "c1", status: "InProgress" })
        : Response.json({
            id: "c1",
            status: "Success",
            exitCode: 0,
            stdout: JSON.stringify({ protocol: 1, ok: true, job: { state: "completed" } }),
          }),
  });
  const pending = skidbladnirRequester(
    config,
    stateFile(),
    request,
  )(route, {
    operation: "submit",
    jobId: "job-1",
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toMatchObject({
    state: "confirmed",
    response: { job: { state: "completed" } },
  });
  expect(readiness).toBe(3);
  expect(calls.filter((c) => c.path === "/api/commands/c1/refresh")).toHaveLength(2);
  expect(calls.at(-1)!.path).toBe("/api/workers/w1/terminate");
});

it("gives up as unknown when readiness or the command outcome exceed the deadline", async () => {
  vi.useFakeTimers({ now: Date.now() });
  const never = api({ ...base, "*/readiness": json({ ready: false, state: "pending" }) });
  const waiting = skidbladnirRequester(
    config,
    stateFile(),
    never.request,
  )(route, {
    operation: "submit",
    jobId: "job-1",
  });
  await vi.advanceTimersByTimeAsync(200_000);
  expect(await waiting).toEqual({
    state: "unknown",
    reason: "AWS SSM readiness deadline exceeded",
  });
  const stuck = api({
    ...base,
    "*/commands": json({ id: "c1", status: "InProgress" }),
    "/api/commands/c1/refresh": json({ id: "c1", status: "Pending" }),
  });
  const running = skidbladnirRequester(
    config,
    stateFile(),
    stuck.request,
  )(route, {
    operation: "submit",
    jobId: "job-1",
  });
  await vi.advanceTimersByTimeAsync(200_000);
  expect(await running).toEqual({ state: "unknown", reason: "SSM command outcome unconfirmed" });
});

it("keeps the final evidence when retiring the worker fails", async () => {
  const final = { protocol: 1, ok: true, job: { state: "failed" } };
  const { request, calls } = api({
    ...base,
    "*/commands": command(final),
    "*/terminate": () => new Response("no", { status: 500 }),
  });
  const file = stateFile();
  expect(
    await skidbladnirRequester(config, file, request)(route, { operation: "inspect", jobId: "x" }),
  ).toMatchObject({
    state: "unavailable",
  });
  expect(
    await skidbladnirRequester(
      config,
      file,
      request,
    )(route, { operation: "submit", jobId: "job-1" }),
  ).toEqual({
    state: "confirmed",
    response: final,
  });
  const before = calls.length;
  // Any later request for the job answers from the preserved evidence, without the API.
  expect(
    await skidbladnirRequester(
      config,
      file,
      request,
    )(route, { operation: "cancel", jobId: "job-1" }),
  ).toEqual({
    state: "confirmed",
    response: final,
  });
  expect(calls).toHaveLength(before);
});

it("names itself skidbladnir while speaking the SSH runtime protocol", async () => {
  const runtime = new SkidbladnirRuntime(config, stateFile(), api(base).request);
  try {
    expect(await runtime.capabilities()).toMatchObject({ runtime: "skidbladnir" });
  } finally {
    await runtime.dispose();
  }
});

it("keeps the worker for a job whose reported state is missing or not final", async () => {
  for (const job of [{}, { state: "running" }, undefined]) {
    const { request, calls } = api({
      ...base,
      "*/commands": command({ protocol: 1, ok: true, ...(job ? { job } : {}) }),
    });
    const file = stateFile();
    await skidbladnirRequester(config, file, request)(route, { operation: "submit", jobId: "j" });
    await skidbladnirRequester(config, file, request)(route, { operation: "inspect", jobId: "j" });
    expect(calls.filter((c) => c.path.endsWith("/commands"))).toHaveLength(2);
    expect(calls.some((c) => c.path.endsWith("/terminate"))).toBe(false);
  }
});
