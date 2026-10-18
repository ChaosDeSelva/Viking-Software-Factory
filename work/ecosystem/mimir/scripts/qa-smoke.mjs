#!/usr/bin/env node
// pnpm qa:smoke: end-to-end QA smoke for a fresh clone (see docs/qa.md).
//
// Builds, runs release:local, extracts the tarball, installs the shim into a temp HOME, then drives
// the released product: doctor, a FakeRuntime server on a free port with a temp data dir, a
// 3-task demo mission over the HTTP API (with approvals), event replay with a cursor, SSE resume
// with Last-Event-ID, a SIGKILL + restart mid-mission, `mimir export`, and an axe scan of the
// mission page through the Playwright setup in apps/web. Exits 0 only if every step passes.
//
// Every step's output lands in qa-smoke-output/<timestamp>/ (gitignored); the table names the file.
//
// Flags:
//   --tarball <path>  reuse a release tarball: skips the build and release:local steps (dev loop)
//   --skip-coverage   run release:local without its coverage gate (run `pnpm test:coverage` on its
//                     own; useful on a loaded machine where suite timeouts would stop the smoke)
//   --keep            keep the temp work dir (data dir, sample repo, install) for inspection
//
// TODO(T15d): drive the demo with `mimir demo` once it lands; until then the demo mission is
// created step by step over the HTTP API below.
import { spawn } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner, execLogged, formatTable } from "./qa-smoke-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : resolve(argv[i + 1] ?? "");
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(root, "qa-smoke-output", stamp);
const work = mkdtempSync(join(tmpdir(), "mimir-qa-smoke-"));
const home = join(work, "home");
const dataDir = join(work, "data");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const runner = createRunner({ outDir });
const skipCoverage = flag("--skip-coverage");
const releaseStep = skipCoverage
  ? "release:local (--skip-coverage)"
  : "release:local (with test:coverage)";
const { step } = runner;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function waitFor(what, fn, { timeoutMs = 120_000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(everyMs);
  }
}
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
const portInUse = (port) =>
  new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(true));
    s.listen(port, "127.0.0.1", () => s.close(() => res(false)));
  });

// ---------------------------------------------------------------- state shared across steps
const st = {
  tarball: option("--tarball"),
  appDir: join(home, ".mimir", "app"),
  shim: join(home, ".local", "bin", "mimir"),
  server: null,
  port: 0,
  token: "",
  repo: join(work, "repo"),
  demo: null,
  serverRuns: 0,
};
const baseEnv = () => ({
  ...process.env,
  HOME: home,
  MIMIR_DATA_DIR: dataDir,
  MIMIR_RUNTIME: "fake",
  MIMIR_TICK_MS: "200",
});
const url = (p) => `http://127.0.0.1:${st.port}${p}`;

async function api(method, path, body, ctx) {
  const headers = { authorization: `Bearer ${st.token}` };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = `qa-${crypto.randomUUID()}`;
  }
  const res = await fetch(url(path), {
    method,
    headers,
    ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (ctx && method !== "GET") ctx.note(`${method} ${path} -> ${res.status}`);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

/** Every event (optionally for one mission), paging with `nextCursor`. */
async function replayAll(query = "", limit = 500) {
  const events = [];
  const cursors = [];
  let cursor;
  for (;;) {
    const q = new URLSearchParams(query);
    q.set("limit", String(limit));
    if (cursor) q.set("cursor", cursor);
    const page = await api("GET", `/v1/events?${q}`);
    events.push(...page.events);
    cursors.push(page.nextCursor ?? page.lastCursor ?? null);
    if (!page.hasMore || page.nextCursor === null || page.events.length === 0) break;
    cursor = page.nextCursor;
  }
  return { events, cursors };
}

/** Per-stream `sequence` must increase by exactly 1 (no gap, no duplicate). */
function checkStreams(events) {
  const last = new Map();
  for (const e of events) {
    const prev = last.get(e.streamId);
    if (prev !== undefined && e.sequence !== prev + 1) {
      throw new Error(`stream ${e.streamId}: sequence ${prev} then ${e.sequence}`);
    }
    last.set(e.streamId, e.sequence);
  }
  const ids = new Set(events.map((e) => e.id));
  assert(ids.size === events.length, `duplicate event ids (${events.length - ids.size})`);
  return last.size;
}

// ---------------------------------------------------------------- server process
async function startServer(label) {
  st.serverRuns += 1;
  const log = runner.evidencePath(`${label} server output`);
  const out = createWriteStream(log, { flags: "a" });
  const env = { ...baseEnv(), MIMIR_PORT: String(st.port) };
  const child = spawn("node", [join(st.appDir, "app/server/dist/main.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const exited = new Promise((r) => child.once("exit", (code, sig) => r(code ?? sig)));
  st.server = { child, log, exited };
  await waitFor(
    "GET /v1/health",
    async () => {
      if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
      try {
        return (await fetch(url("/v1/health"))).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 30_000 },
  );
  st.token = readFileSync(join(dataDir, "auth-token"), "utf8").trim();
  return log;
}
async function stopServer(signal = "SIGTERM") {
  if (!st.server) return;
  const { child, exited } = st.server;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  const how = await Promise.race([exited, sleep(10_000).then(() => "still running")]);
  if (how === "still running") {
    child.kill("SIGKILL");
    await exited;
  }
  st.server = null;
  return how;
}

// ---------------------------------------------------------------- SSE
/** Opens the SSE stream and collects frames; `close()` aborts it. */
function openSse(path, headers = {}) {
  const ac = new AbortController();
  const frames = [];
  let ended = false;
  const done = (async () => {
    const res = await fetch(url(path), {
      headers: { authorization: `Bearer ${st.token}`, accept: "text/event-stream", ...headers },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`SSE ${path} -> ${res.status}`);
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const f = { id: undefined, event: undefined, data: undefined };
          for (const line of raw.split("\n")) {
            if (line.startsWith("id: ")) f.id = line.slice(4);
            else if (line.startsWith("event: ")) f.event = line.slice(7);
            else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
          }
          if (f.data !== undefined) frames.push(f);
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    } finally {
      ended = true;
    }
  })();
  done.catch(() => {});
  return {
    frames,
    get ended() {
      return ended;
    },
    done,
    close: () => ac.abort(),
  };
}

// ---------------------------------------------------------------- demo mission over HTTP
function makeSampleRepo(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "qa-sample", private: true, scripts: { test: 'node -e "0"' } }, null, 2),
  );
  writeFileSync(join(dir, "README.md"), "# QA sample repo\n");
  return [
    ["git", ["init", "-q", "-b", "main"]],
    ["git", ["-c", "user.name=qa", "-c", "user.email=qa@localhost", "add", "."]],
    ["git", ["-c", "user.name=qa", "-c", "user.email=qa@localhost", "commit", "-q", "-m", "init"]],
  ];
}

async function createDemoMission(ctx, projectId, objective) {
  const { mission } = await api("POST", "/v1/missions", { projectId, objective }, ctx);
  const { crew } = await api(
    "POST",
    "/v1/crews",
    {
      missionId: mission.id,
      template: "solo",
      limits: { maxConcurrentTasks: 2 },
      members: [{ role: "implementer", agentKind: "shell" }],
    },
    ctx,
  );
  const task = async (title, brief, dependsOn = []) =>
    (await api("POST", "/v1/tasks", { missionId: mission.id, title, brief, dependsOn }, ctx)).task
      .id;
  const a = await task("Task A", "echo A");
  const b = await task("Task B", "echo B", [a]);
  // A and B are plain allowlisted `echo` words. C quotes its argument, so it is not plain words:
  // the gate classifies the whole `sh -c` argv, which no allowlist entry matches -> approval.
  const c = await task("Task C", 'echo "C"');
  return { missionId: mission.id, crewId: crew.id, tasks: { A: a, B: b, C: c } };
}

/** Approves every pending approval for the mission; returns the ids it approved. */
async function approvePending(ctx, missionId) {
  const { approvals } = await api(
    "GET",
    `/v1/approvals?status=pending&missionId=${encodeURIComponent(missionId)}`,
  );
  const ids = [];
  for (const a of approvals) {
    await api("POST", `/v1/approvals/${a.id}/decision`, { decision: "approved" }, ctx);
    ctx.note(`approved ${a.id} (${a.action}) for task ${a.taskId}`);
    ids.push(a.id);
  }
  return ids;
}

const TERMINAL = new Set(["completed", "cancelled", "failed"]);
async function driveToTerminal(ctx, missionId, approved, timeoutMs = 180_000) {
  return waitFor(
    `mission ${missionId} to finish`,
    async () => {
      approved.push(...(await approvePending(ctx, missionId)));
      const m = await api("GET", `/v1/missions/${missionId}`);
      return TERMINAL.has(m.mission.status) ? m : null;
    },
    { timeoutMs, everyMs: 300 },
  );
}

/** `want` must appear in `types` in this order (other events may sit in between). */
function inOrder(types, want) {
  let i = 0;
  for (const t of types) if (t === want[i]) i += 1;
  return i === want.length;
}

// ================================================================= steps
async function main() {
  console.log(`qa:smoke  output: ${outDir}\n           work:   ${work}`);

  if (!st.tarball) {
    await step("build", (ctx) => ctx.exec("pnpm", ["build"], { cwd: root }));
    await step(
      releaseStep,
      async (ctx) => {
        await ctx.exec(
          "node",
          [
            "scripts/release-local.mjs",
            "--out-dir",
            join(work, "dist"),
            "--packages-dir",
            join(work, "dist-packages"),
            ...(skipCoverage ? ["--skip-coverage"] : []),
          ],
          { cwd: root, timeoutMs: 40 * 60_000 },
        );
        st.tarball = join(work, "dist", `mimir-${version}-macos-arm64.tar.gz`);
        assert(existsSync(st.tarball), `no tarball at ${st.tarball}`);
        for (const p of ["protocol", "sdk"]) {
          const f = readdirSync(join(work, "dist-packages")).find((x) =>
            x.startsWith(`mimir-${p}-`),
          );
          assert(f, `no @mimir/${p} tarball in dist-packages`);
          ctx.note(`library tarball: ${f}`);
        }
        ctx.note(`tarball: ${st.tarball} (${statSync(st.tarball).size} bytes)`);
      },
      { requires: ["build"] },
    );
  }
  const haveTarball = st.tarball ? [] : [releaseStep];

  await step(
    "extract tarball",
    async (ctx) => {
      const dest = join(work, "extract");
      mkdirSync(dest, { recursive: true });
      await ctx.exec("tar", ["-xzf", st.tarball, "-C", dest]);
      const top = join(dest, `mimir-${version}-macos-arm64`);
      for (const p of ["bin/mimir", "app/server/dist/main.js", "app/web/dist/index.html"]) {
        assert(existsSync(join(top, p)), `missing ${p} in the tarball`);
      }
      st.extracted = top;
    },
    { requires: haveTarball },
  );

  await step(
    "install shim into temp HOME",
    async (ctx) => {
      mkdirSync(home, { recursive: true });
      await ctx.exec("bash", [join(st.extracted, "scripts/install-local.sh"), st.tarball], {
        env: { ...process.env, HOME: home },
      });
      assert(existsSync(st.shim), `no shim at ${st.shim}`);
      assert((statSync(st.shim).mode & 0o111) !== 0, "shim is not executable");
      assert(existsSync(join(st.appDir, "VERSION")), "app dir has no VERSION");
    },
    { requires: ["extract tarball"] },
  );

  await step(
    "mimir doctor",
    async (ctx) => {
      const r = await ctx.exec(st.shim, ["doctor", "--json"], {
        env: baseEnv(),
        allowFail: true,
      });
      const report = JSON.parse(r.stdout);
      const status = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
      for (const name of ["node", "pnpm", "git", "data-dir"]) {
        assert(status[name] === "ok", `doctor check ${name} is ${status[name]}`);
      }
      // Exit code must agree with the report (0 when ok, 3 when a required check fails).
      assert(r.code === (report.ok ? 0 : 3), `doctor ok=${report.ok} but exit ${r.code}`);
      ctx.note(`doctor ok=${report.ok}; herdr=${status.herdr} (real HerdR is out of scope)`);
    },
    { requires: ["install shim into temp HOME"] },
  );

  await step(
    "server start (FakeRuntime, free port, temp data dir)",
    async (ctx) => {
      st.port = await freePort();
      for (const [cmd, args] of makeSampleRepo(st.repo))
        await ctx.exec(cmd, args, { cwd: st.repo });
      const log = await startServer("run 1");
      ctx.note(`server on port ${st.port}, data ${dataDir}, output in ${log}`);
      const health = await (await fetch(url("/v1/health"))).json();
      assert(health.status === "ok", `health ${JSON.stringify(health)}`);
      const caps = await api("GET", "/v1/capabilities");
      ctx.note(`capabilities: ${JSON.stringify(caps).slice(0, 300)}`);
    },
    { requires: ["install shim into temp HOME"] },
  );

  await step(
    "demo mission: 3 tasks to completion over HTTP, approvals honoured",
    async (ctx) => {
      const { project } = await api(
        "POST",
        "/v1/projects",
        { name: "qa-demo", repoPath: st.repo },
        ctx,
      );
      st.projectId = project.id;
      const demo = await createDemoMission(ctx, project.id, "QA smoke demo");
      ctx.note(`mission ${demo.missionId} tasks ${JSON.stringify(demo.tasks)}`);
      await api("POST", `/v1/missions/${demo.missionId}/start`, {}, ctx);
      const approved = [];
      const final = await driveToTerminal(ctx, demo.missionId, approved);
      ctx.note(
        `final: ${JSON.stringify({ mission: final.mission.status, tasks: final.tasks.map((t) => [t.title, t.status]) })}`,
      );
      assert(final.mission.status === "completed", `mission ended ${final.mission.status}`);
      assert(
        final.tasks.length === 3 && final.tasks.every((t) => t.status === "completed"),
        `tasks: ${final.tasks.map((t) => `${t.title}=${t.status}`).join(", ")}`,
      );
      assert(approved.length > 0, "no approval was required");

      const { events } = await replayAll(`missionId=${demo.missionId}`);
      for (const [key, id] of Object.entries(demo.tasks)) {
        const types = events.filter((e) => e.taskId === id).map((e) => e.type);
        ctx.note(`task ${key} (${id}): ${types.join(" > ")}`);
        const want = [
          "task.created",
          "task.ready",
          "task.leased",
          "task.started",
          "task.verifying",
          "task.completed",
        ];
        assert(inOrder(types, want), `task ${key} sequence is not ${want.join(" > ")}`);
      }
      // Approvals were required and honoured: each gated task was blocked, then decided, then ran.
      const approvals = (await api("GET", `/v1/approvals?missionId=${demo.missionId}`)).approvals;
      assert(
        approvals.some((a) => a.taskId === demo.tasks.C),
        "task C (not allowlisted) was dispatched without an approval",
      );
      for (const a of approvals) {
        assert(a.status === "approved", `approval ${a.id} is ${a.status}`);
        const types = events.filter((e) => e.taskId === a.taskId).map((e) => e.type);
        assert(
          inOrder(types, ["approval.requested", "task.blocked", "task.leased", "task.completed"]),
          `task ${a.taskId} did not go blocked > leased > completed around its approval`,
        );
      }
      assert(
        events.some((e) => e.type === "approval.decided"),
        "no approval.decided event recorded",
      );
      // B depends on A: B is not leased before A completed (cross-stream, compared by occurredAt).
      const at = (task, type) =>
        events.find((e) => e.taskId === demo.tasks[task] && e.type === type)?.occurredAt;
      assert(at("B", "task.leased") >= at("A", "task.completed"), "B leased before A completed");
      st.demo = { ...demo, approvals: approved.length, eventCount: events.length };
      ctx.note(
        `approvals required and approved: ${approved.length}; mission events: ${events.length}`,
      );
    },
    { requires: ["server start (FakeRuntime, free port, temp data dir)"] },
  );

  await step(
    "GET /v1/events replays with a cursor",
    async (ctx) => {
      const all = await replayAll("", 1000);
      const paged = await replayAll("", 7);
      ctx.note(
        `events: ${all.events.length} in one read, ${paged.events.length} over ${paged.cursors.length} pages of 7`,
      );
      assert(paged.cursors.length > 2, "expected several pages");
      assert(
        JSON.stringify(paged.events.map((e) => e.id)) ===
          JSON.stringify(all.events.map((e) => e.id)),
        "paged replay differs from a single read",
      );
      const streams = checkStreams(all.events);
      // Resuming from the first page's cursor returns exactly the events after it.
      const after = await api(
        "GET",
        `/v1/events?limit=5&cursor=${encodeURIComponent(paged.cursors[0])}`,
      );
      assert(
        JSON.stringify(after.events.map((e) => e.id)) ===
          JSON.stringify(all.events.slice(7, 12).map((e) => e.id)),
        "cursor resume did not continue right after the first page",
      );
      ctx.note(`per-stream sequences contiguous across ${streams} streams; cursor resume ok`);
    },
    { requires: ["demo mission: 3 tasks to completion over HTTP, approvals honoured"] },
  );

  await step(
    "SSE stream resumes with Last-Event-ID",
    async (ctx) => {
      const all = (await replayAll("", 1000)).events;
      const first = await api("GET", "/v1/events?limit=1");
      const sse = openSse(
        `/v1/events/stream?cursor=${encodeURIComponent(first.nextCursor ?? first.lastCursor)}`,
      );
      await waitFor("5 SSE frames", () => sse.frames.length >= 5, { timeoutMs: 15_000 });
      sse.close();
      const seen = sse.frames.slice(0, 5);
      assert(
        JSON.stringify(seen.map((f) => f.data.id)) ===
          JSON.stringify(all.slice(1, 6).map((e) => e.id)),
        "first SSE connection did not replay in log order from the cursor",
      );
      const lastId = seen[4].id;
      ctx.note(`first connection: 5 frames, Last-Event-ID ${lastId}`);
      const again = openSse("/v1/events/stream", { "last-event-id": lastId });
      await waitFor("3 SSE frames after reconnect", () => again.frames.length >= 3, {
        timeoutMs: 15_000,
      });
      assert(
        JSON.stringify(again.frames.slice(0, 3).map((f) => f.data.id)) ===
          JSON.stringify(all.slice(6, 9).map((e) => e.id)),
        "reconnect with Last-Event-ID did not resume right after the last frame",
      );
      // ...and keeps following live events after the replay.
      const before = again.frames.length;
      const probeRepo = join(work, "probe-repo");
      for (const [cmd, args] of makeSampleRepo(probeRepo)) {
        await ctx.exec(cmd, args, { cwd: probeRepo });
      }
      await api("POST", "/v1/projects", { name: "qa-live-probe", repoPath: probeRepo }, ctx);
      await waitFor(
        "a live project.created frame",
        () => again.frames.slice(before).some((f) => f.event === "project.created"),
        { timeoutMs: 15_000 },
      );
      again.close();
      ctx.note("reconnect resumed without gap or duplicate and then received a live event");
    },
    { requires: ["demo mission: 3 tasks to completion over HTTP, approvals honoured"] },
  );

  await step(
    "SIGKILL mid-mission and restart: no lost events",
    async (ctx) => {
      const m2 = await createDemoMission(ctx, st.projectId, "QA smoke restart");
      st.restart = m2;
      await api("POST", `/v1/missions/${m2.missionId}/start`, {}, ctx);
      const approved = [];
      // Run until at least one task is running, so the kill lands mid-mission.
      await waitFor(
        "a running task",
        async () => {
          approved.push(...(await approvePending(ctx, m2.missionId)));
          const m = await api("GET", `/v1/missions/${m2.missionId}`);
          return m.tasks.some((t) => t.status === "running");
        },
        { timeoutMs: 60_000, everyMs: 100 },
      );
      const live = openSse("/v1/events/stream");
      await sleep(300);
      const before = (await replayAll("", 1000)).events;
      const tasksBefore = (await api("GET", `/v1/missions/${m2.missionId}`)).tasks;
      st.runningAtKill = tasksBefore.filter((t) => t.status === "running").map((t) => t.id);
      const statusBefore = tasksBefore.map((t) => `${t.title}=${t.status}`);
      ctx.note(`before kill: ${before.length} events; tasks ${statusBefore.join(", ")}`);
      const how = await stopServer("SIGKILL");
      ctx.note(`server killed (${how})`);
      const lastLiveId = live.frames.at(-1)?.id;
      await waitFor("the SSE stream to end", () => live.ended, { timeoutMs: 10_000 });

      const log = await startServer("run 2 (after SIGKILL)");
      ctx.note(`restarted on the same data dir and port; output in ${log}`);
      const after = (await replayAll("", 1000)).events;
      const byId = new Map(after.map((e) => [e.id, e]));
      const lost = before.filter((e) => !byId.has(e.id));
      assert(
        lost.length === 0,
        `${lost.length} events lost: ${lost
          .slice(0, 3)
          .map((e) => e.type)
          .join(", ")}`,
      );
      const changed = before.filter((e) => JSON.stringify(byId.get(e.id)) !== JSON.stringify(e));
      assert(changed.length === 0, `${changed.length} events changed across the restart`);
      assert(
        JSON.stringify(after.slice(0, before.length).map((e) => e.id)) ===
          JSON.stringify(before.map((e) => e.id)),
        "replay order of pre-kill events changed",
      );
      checkStreams(after);
      ctx.note(
        `after restart: ${after.length} events, all ${before.length} pre-kill events intact`,
      );

      if (lastLiveId) {
        const resumed = openSse("/v1/events/stream", { "last-event-id": lastLiveId });
        const idx = after.findIndex((e) => e.id === live.frames.at(-1).data.id);
        const expectNext = after.slice(idx + 1, idx + 3).map((e) => e.id);
        if (expectNext.length > 0) {
          await waitFor(
            "SSE frames after restart",
            () => resumed.frames.length >= expectNext.length,
            {
              timeoutMs: 15_000,
            },
          );
          assert(
            JSON.stringify(resumed.frames.slice(0, expectNext.length).map((f) => f.data.id)) ===
              JSON.stringify(expectNext),
            "SSE resume across the restart skipped or repeated events",
          );
        }
        resumed.close();
        ctx.note(`SSE resumed across the restart from ${lastLiveId}`);
      }
      st.restartApproved = approved;
    },
    { requires: ["demo mission: 3 tasks to completion over HTTP, approvals honoured"] },
  );

  await step(
    "restart recovery: lost sessions parked unknown, operator retry completes the mission",
    async (ctx) => {
      const m2 = st.restart;
      const get = () => api("GET", `/v1/missions/${m2.missionId}`);
      // FakeRuntime sessions die with the process. Mimir must not guess: a task whose session is
      // gone is parked `unknown_after_restart` (runtime state is unknown, never inferred).
      const parked = await waitFor(
        "reconciliation of the lost sessions",
        async () => {
          const m = await get();
          const busy = m.tasks.some((t) => ["running", "leased", "verifying"].includes(t.status));
          return busy ? null : m.tasks.filter((t) => t.blockedReason === "unknown_after_restart");
        },
        { timeoutMs: 60_000, everyMs: 300 },
      );
      ctx.note(`parked unknown_after_restart: ${parked.map((t) => t.title).join(", ") || "none"}`);
      for (const id of st.runningAtKill) {
        assert(
          parked.some((t) => t.id === id),
          `task ${id} was running at the kill but is not parked unknown_after_restart`,
        );
      }
      const { events: recEvents } = await replayAll(`missionId=${m2.missionId}`);
      const kinds = new Set(recEvents.map((e) => e.type));
      assert(
        parked.length === 0 || (kinds.has("session.lost") && kinds.has("recovery.unknown_marked")),
        "parked tasks have no session.lost / recovery.unknown_marked events",
      );
      for (const t of parked) {
        await api(
          "POST",
          `/v1/tasks/${t.id}/retry`,
          { reason: "qa smoke: rerun after restart" },
          ctx,
        );
      }
      const final = await driveToTerminal(ctx, m2.missionId, st.restartApproved, 180_000);
      ctx.note(
        `final: mission=${final.mission.status}; ${final.tasks.map((t) => `${t.title}=${t.status}`).join(", ")}`,
      );
      assert(
        final.mission.status === "completed",
        `mission ended ${final.mission.status} after restart and retry`,
      );
    },
    { requires: ["SIGKILL mid-mission and restart: no lost events"] },
  );

  await step(
    "mimir export",
    async (ctx) => {
      const out = join(work, "export.json");
      const r = await ctx.exec(
        st.shim,
        ["export", "--mission", st.demo.missionId, "--out", out, "--json"],
        { env: baseEnv() },
      );
      const summary = JSON.parse(r.stdout);
      const doc = JSON.parse(readFileSync(out, "utf8"));
      copyFileSync(out, join(outDir, "export-demo-mission.json"));
      const viaApi = (await replayAll(`missionId=${st.demo.missionId}`)).events;
      assert(doc.missionId === st.demo.missionId, "export names another mission");
      assert(summary.count === doc.events.length, "summary count differs from the file");
      assert(
        doc.events.length === viaApi.length,
        `export has ${doc.events.length} events, API ${viaApi.length}`,
      );
      const completed = doc.events.filter((e) => e.type === "task.completed").length;
      assert(completed === 3, `export has ${completed} task.completed events`);
      assert((statSync(out).mode & 0o777) === 0o600, "export file is not 0600");
      ctx.note(`exported ${doc.events.length} events (copy: export-demo-mission.json)`);
    },
    { requires: ["demo mission: 3 tasks to completion over HTTP, approvals honoured"] },
  );

  await stopServer("SIGTERM");

  await step("axe scan of the mission page (Playwright)", async (ctx) => {
    if (await portInUse(5173))
      throw new Error("port 5173 is busy (the Playwright setup runs Vite there)");
    await ctx.exec(
      "pnpm",
      ["--filter", "@mimir/web", "exec", "playwright", "test", "e2e/qa-mission.spec.ts"],
      {
        cwd: root,
        env: { ...process.env, MIMIR_QA_SMOKE: "1", MIMIR_E2E_PORT: String(await freePort()) },
        timeoutMs: 10 * 60_000,
      },
    );
  });
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
} finally {
  await stopServer("SIGTERM").catch(() => {});
}
const table = formatTable(runner.rows, { baseDir: outDir });
writeFileSync(join(outDir, "summary.txt"), table + "\n");
console.log(`\n${table}\n\nevidence: ${outDir}`);
if (crashed) console.error(`qa:smoke crashed: ${crashed.stack ?? crashed}`);
if (flag("--keep")) console.log(`work dir kept: ${work}`);
else rmSync(work, { recursive: true, force: true });
const passed = runner.rows.filter((r) => r.result === "PASS").length;
console.log(`qa:smoke: ${passed}/${runner.rows.length} steps passed`);
process.exit(runner.ok && !crashed ? 0 : 1);
