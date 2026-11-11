import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sshArguments, sshRequest, type RemoteRequest } from "./transport.js";

// Every request spawns a real process; starting one can take seconds on a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const route = { host: "factory-worker", root: "/home/exedev/factory" };
function executable(body: string) {
  const root = mkdtempSync(join(tmpdir(), "mimir-ssh-"));
  roots.push(root);
  const path = join(root, "ssh-fixture");
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o700);
  return path;
}
it("pins SSH security policy and uses a fixed remote command", () => {
  const args = sshArguments(route);
  expect(args.slice(-3)).toEqual(["--", "factory-worker", "mimir-remote-entrypoint"]);
  for (const value of [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "ForwardAgent=no",
    "SendEnv=-*",
  ])
    expect(args).toContain(value);
  for (const host of ["-oProxyCommand=evil", "host;touch bad", "user@host", "host\nnext"])
    expect(() => sshArguments({ ...route, host })).toThrow();
  for (const root of ["relative", "/a/../b", "/a//b", "/a\nb"])
    expect(() => sshArguments({ ...route, root })).toThrow();
});
it("carries shell metacharacters only as structured stdin data", async () => {
  const result = await sshRequest(
    route,
    { operation: "submit", jobId: "job-1", payload: { text: "$(touch NEVER); 'quoted'\nnext" } },
    {
      executable: executable(
        'let data="";process.stdin.on("data",b=>data+=b);process.stdin.on("end",()=>console.log(JSON.stringify({protocol:1,request:JSON.parse(data),argv:process.argv.slice(2)})));',
      ),
    },
  );
  expect(result).toMatchObject({
    state: "confirmed",
    response: { request: { payload: { text: "$(touch NEVER); 'quoted'\nnext" } } },
  });
});
it("never treats transport loss, malformed replies, or remote nonzero exits as task completion", async () => {
  for (const body of [
    "process.exit(255)",
    "process.exit(1)",
    'console.log("not json")',
    'console.log("{\\"protocol\\":2}")',
  ]) {
    expect(
      await sshRequest(
        route,
        { operation: "inspect", jobId: "job-1" },
        { executable: executable(body) },
      ),
    ).toMatchObject({ state: "unknown" });
  }
});
it("bounds output and duration", async () => {
  expect(
    await sshRequest(
      route,
      { operation: "health" },
      { executable: executable('console.log("x".repeat(10000))'), maxBytes: 100 },
    ),
  ).toMatchObject({ state: "unknown", reason: expect.stringContaining("output limit") });
  expect(
    await sshRequest(
      route,
      { operation: "health" },
      { executable: executable("setInterval(()=>{},1000)"), timeoutMs: 100 },
    ),
  ).toMatchObject({ state: "unknown", reason: expect.stringContaining("deadline") });
});
it("distinguishes a missing local executable and refuses missing mutation identities", async () => {
  expect(
    await sshRequest(route, { operation: "health" }, { executable: "/nonexistent/mimir-ssh" }),
  ).toMatchObject({ state: "unavailable" });
  await expect(sshRequest(route, { operation: "submit" })).rejects.toThrow("job ID");
});
it("refuses unknown operations and unusable bounds before starting SSH", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "mimir-ssh-")), "started");
  roots.push(join(marker, ".."));
  const ssh = executable(`require("node:fs").writeFileSync(${JSON.stringify(marker)},"1")`);
  await expect(
    sshRequest(route, { operation: "exec", jobId: "job-1" } as unknown as RemoteRequest, {
      executable: ssh,
    }),
  ).rejects.toThrow("Unsupported remote operation");
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
    { maxBytes: 0 },
    { maxBytes: Number.POSITIVE_INFINITY },
  ])
    await expect(
      sshRequest(route, { operation: "health" }, { executable: ssh, ...options }),
    ).rejects.toThrow("Transport bounds must be positive integers");
  await expect(
    sshRequest(route, { operation: "inspect", jobId: "../escape" }, { executable: ssh }),
  ).rejects.toThrow("job ID");
  await expect(
    sshRequest(
      route,
      { operation: "submit", jobId: "job-1", payload: { blob: "x".repeat(16 * 1024 * 1024) } },
      { executable: ssh },
    ),
  ).rejects.toThrow("exceeds 16 MiB");
  await expect(
    sshRequest({ ...route, host: "user@host" }, { operation: "health" }, { executable: ssh }),
  ).rejects.toThrow(/SSH configuration alias/);
  expect(existsSync(marker)).toBe(false);
});
it("counts diagnostics toward the output limit and ignores a peer that never reads stdin", async () => {
  expect(
    await sshRequest(
      route,
      { operation: "health" },
      { executable: executable('console.error("x".repeat(10000))'), maxBytes: 100 },
    ),
  ).toMatchObject({ state: "unknown", reason: expect.stringContaining("output limit") });
  // The peer answers and exits without consuming a large request: EPIPE must not mask its reply.
  expect(
    await sshRequest(
      route,
      { operation: "submit", jobId: "job-1", payload: { blob: "x".repeat(4 * 1024 * 1024) } },
      { executable: executable("console.log(JSON.stringify({protocol:1,ok:true}))") },
    ),
  ).toEqual({ state: "confirmed", response: { protocol: 1, ok: true } });
  for (const body of ['console.log("[1]")', 'console.log("null")', 'console.log("{}")'])
    expect(
      await sshRequest(route, { operation: "health" }, { executable: executable(body) }),
    ).toEqual({ state: "unknown", reason: "Remote response was not a valid protocol envelope" });
});
it("runs the ssh found on PATH by default, ignores diagnostics and reports a signal exit", async () => {
  // A stub named ssh first on PATH: the default executable, never the real client.
  const ssh = executable(
    'console.error("Warning: diagnostics");console.log(JSON.stringify({protocol:1,ok:true,argv:process.argv.slice(2)}))',
  );
  const dir = join(ssh, "..");
  const named = join(dir, "ssh");
  writeFileSync(named, readFileSync(ssh));
  chmodSync(named, 0o700);
  vi.stubEnv("PATH", dir);
  try {
    expect(await sshRequest(route, { operation: "health" })).toEqual({
      state: "confirmed",
      response: { protocol: 1, ok: true, argv: sshArguments(route) },
    });
  } finally {
    vi.unstubAllEnvs();
  }
  expect(
    await sshRequest(
      route,
      { operation: "health" },
      { executable: executable('process.kill(process.pid,"SIGKILL")') },
    ),
  ).toEqual({ state: "unknown", reason: "SSH exited by signal; reconcile the same remote job" });
});
