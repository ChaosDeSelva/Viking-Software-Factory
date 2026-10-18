import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { skidbladnirRequester } from "./adapter.js";
it("allocates once and preserves final evidence across restart before retiring worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-skid-"));
  let launches = 0,
    retired = 0;
  const config = {
    id: "aws-slot",
    url: "http://127.0.0.1:4380",
    template: "general" as const,
    minutes: 15,
    root: "/tmp/mimir",
  };
  const route = { host: config.id, root: config.root };
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    let value: unknown;
    if (path === "/api/session") value = { token: "fixture" };
    else if (path === "/api/workers") {
      launches++;
      value = { id: "worker-1", state: "starting" };
    } else if (path.endsWith("/readiness")) value = { ready: true, state: "running" };
    else if (path.endsWith("/terminate")) {
      retired++;
      value = { state: "terminating" };
    } else if (path.endsWith("/commands")) {
      const encoded = body.command!.match(/printf %s '([^']+)'/)?.[1];
      expect(encoded).toBeTruthy();
      const envelope = JSON.parse(Buffer.from(encoded!, "base64").toString()) as {
        operation: string;
      };
      value = {
        id: "c",
        commandId: "ssm-c",
        status: "Success",
        exitCode: 0,
        stdout: JSON.stringify({
          protocol: 1,
          ok: true,
          job: { state: envelope.operation === "submit" ? "running" : "completed", patch: "" },
          output: "synthetic",
        }),
      };
    } else throw Error("Unexpected route " + path);
    return Response.json(value);
  };
  try {
    const file = join(dir, "state");
    let transport = skidbladnirRequester(config, file, request);
    expect(
      (await transport(route, { operation: "submit", jobId: "job-1", payload: { files: [] } }))
        .state,
    ).toBe("confirmed");
    expect((await transport(route, { operation: "inspect", jobId: "job-1" })).state).toBe(
      "confirmed",
    );
    expect(retired).toBe(1);
    transport = skidbladnirRequester(config, file, request);
    expect((await transport(route, { operation: "inspect", jobId: "job-1" })).state).toBe(
      "confirmed",
    );
    expect(launches).toBe(1);
    expect(retired).toBe(1);
    expect(() => skidbladnirRequester({ ...config, root: "/other" }, file, request)).toThrow(
      /changed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("refuses nonlocal control origins", () => {
  expect(() =>
    skidbladnirRequester(
      { id: "x", url: "https://example.com", template: "general", minutes: 15, root: "/tmp/x" },
      "unused",
    ),
  ).toThrow(/loopback/);
});

it("runs a tiny mission through the real remote entrypoint and applies its returned patch", async () => {
  const { mkdirSync, writeFileSync, chmodSync, readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { SkidbladnirRuntime } = await import("./adapter.js");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "skid-mission-"))),
    cwd = join(dir, "checkout"),
    remote = join(dir, "remote"),
    bin = join(dir, "bin");
  mkdirSync(cwd);
  mkdirSync(bin);
  const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(["init", "--quiet"]);
  writeFileSync(join(cwd, "hello.txt"), "before\n");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  const agent = join(bin, "agent");
  writeFileSync(
    agent,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync('hello.txt','after\\n');console.log('mission evidence');`,
  );
  chmodSync(agent, 0o700);
  const entry = fileURLToPath(new URL("../../dist/ssh-runtime/entrypoint.js", import.meta.url));
  const wrapper = join(bin, "mimir-remote-entrypoint");
  writeFileSync(
    wrapper,
    `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,[${JSON.stringify(entry)}],{stdio:'inherit',env:{...process.env,MIMIR_REMOTE_ROOT:${JSON.stringify(remote)},MIMIR_CODEX_BIN:${JSON.stringify(agent)}}});process.exit(r.status??1);`,
  );
  chmodSync(wrapper, 0o700);
  let launches = 0,
    retired = 0;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as { command: string }) : undefined;
    let value: unknown;
    if (path === "/api/session") value = { token: "fixture" };
    else if (path === "/api/snapshot") value = { mode: "aws", templates: ["general"] };
    else if (path === "/api/workers") {
      launches++;
      value = { id: "w-real-protocol", state: "running" };
    } else if (path.endsWith("/readiness")) value = { ready: true, state: "running" };
    else if (path.endsWith("/terminate")) {
      retired++;
      value = { state: "terminating" };
    } else if (path.endsWith("/commands")) {
      const stdout = execFileSync("/bin/sh", ["-c", body!.command], {
        env: { ...process.env, PATH: bin + ":" + process.env.PATH },
        encoding: "utf8",
        timeout: 10000,
      });
      value = { id: "c", commandId: "ssm-fixture", status: "Success", exitCode: 0, stdout };
    } else throw Error("Unexpected request");
    return Response.json(value);
  };
  const runtime = new SkidbladnirRuntime(
    { url: "http://127.0.0.1:4380", template: "general", minutes: 15, id: "slot", root: remote },
    join(dir, "state"),
    request,
  );
  try {
    await runtime.createSession({
      sessionId: "mission",
      idempotencyKey: "mission-key",
      crewId: "crew",
      taskId: "task",
      agentKind: "codex",
      argv: ["codex", "exec", "synthetic"],
      cwd,
      env: {},
      workspaceLabel: "Synthetic",
      timeoutMs: 5000,
    });
    for (let i = 0; i < 30; i++) {
      await runtime.reconcile();
      if ((await runtime.getSession("mission"))?.state === "completed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await runtime.getSession("mission")).toMatchObject({ state: "completed" });
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("after\n");
    expect(launches).toBe(1);
    expect(retired).toBe(1);
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
