import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sshArguments, sshRequest } from "./transport.js";

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
