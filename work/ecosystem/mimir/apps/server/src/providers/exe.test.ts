import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { exePlan, ExeProvider } from "./exe.js";
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function file() {
  const p = mkdtempSync(join(tmpdir(), "exe-fixture-"));
  roots.push(p);
  return join(p, "receipts.json");
}
it("builds a bounded private VM plan without commands from task text", () => {
  expect(exePlan({ name: "worker-one" }).command).toBe(
    "new --name=worker-one --image=exeuntu --cpu=2 --memory=4GB --no-email",
  );
  expect(() => exePlan({ name: "worker; rm x" })).toThrow();
  expect(() => exePlan({ name: "worker-one", image: "x --env=SECRET=x" })).toThrow();
});
it("uses plain-text authenticated API and persists a confirmed identity", async () => {
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ vm_name: "worker-one", ssh_host: "worker-one.exe.xyz" })),
  );
  const path = file();
  const provider = new ExeProvider("test-token", path, request);
  expect((await provider.create({ name: "worker-one" }, "request1")).state).toBe("confirmed");
  const call = request.mock.calls[0]!;
  expect(call[0]).toBe("https://exe.dev/exec");
  expect(call[1]!.body).toBe(exePlan({ name: "worker-one" }).command);
  expect(call[1]!.redirect).toBe("error");
  await new ExeProvider("test-token", path, request).create({ name: "worker-one" }, "request1");
  expect(request).toHaveBeenCalledTimes(1);
});
it("does not retry ambiguous creation across controller restarts", async () => {
  const request = vi.fn<typeof fetch>(async () => {
    throw new Error("response lost after create");
  });
  const path = file();
  const provider = new ExeProvider("test-token", path, request);
  expect((await provider.create({ name: "worker-one" }, "request1")).state).toBe("unknown");
  await new ExeProvider("test-token", path, request).create({ name: "worker-one" }, "request1");
  expect(request).toHaveBeenCalledTimes(1);
  await expect(provider.create({ name: "worker-two" }, "request1")).rejects.toThrow("changed");
});
it("refuses missing credentials before network access", async () => {
  const request = vi.fn<typeof fetch>();
  await expect(
    new ExeProvider("", file(), request).create({ name: "worker-one" }, "request1"),
  ).rejects.toThrow("credentials");
  expect(request).not.toHaveBeenCalled();
});
