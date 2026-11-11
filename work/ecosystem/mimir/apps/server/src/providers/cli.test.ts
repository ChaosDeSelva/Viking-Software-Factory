import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// The CLI acts at import time on process.argv; exe.dev is replaced by a stubbed fetch and the
// home directory by a temporary one.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => home.dir };
});
const argv = process.argv;
const roots: string[] = [];
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), "mimir-exe-cli-"));
  roots.push(dir);
  vi.stubEnv("MIMIR_DATA_DIR", dir);
  return dir;
}
async function run(...args: string[]) {
  process.argv = [process.execPath, "exe-worker.mjs", ...args];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  log.mockClear();
  await import("./cli.js");
  return JSON.parse(String(log.mock.calls[0]![0])) as unknown;
}

it("prints a provisioning plan without credentials or network", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await run("plan", "worker-one")).toMatchObject({
    command: "new --name=worker-one --image=exeuntu --cpu=2 --memory=4GB --no-email",
    vmName: "worker-one",
  });
  vi.resetModules();
  await expect(run("plan")).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("lists and creates workers through the provider with receipts in the data directory", async () => {
  const dir = dataDir();
  vi.stubEnv("EXE_TOKEN", "test-token");
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    String(init?.body) === "ls"
      ? Response.json([{ vm_name: "worker-one" }])
      : Response.json({ vm_name: "worker-one", ssh_host: "worker-one.exe.xyz" }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await run("list")).toEqual([{ vm_name: "worker-one" }]);
  vi.resetModules();
  expect(await run("create", "worker-one", "request-1")).toMatchObject({
    state: "confirmed",
    worker: { host: "worker-one.exe.xyz", name: "worker-one" },
  });
  expect(existsSync(join(dir, "exe-receipts.json"))).toBe(true);
});

it("refuses incomplete or unknown commands before contacting the provider", async () => {
  dataDir();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(run("create", "worker-one")).rejects.toThrow("create <name> <stable-request-key>");
  vi.resetModules();
  await expect(run("create")).rejects.toThrow("create <name> <stable-request-key>");
  vi.resetModules();
  await expect(run("destroy")).rejects.toThrow("Usage: exe-worker.mjs {plan");
  vi.resetModules();
  // Without EXE_TOKEN the provider refuses before any request.
  vi.stubEnv("EXE_TOKEN", undefined);
  await expect(run("list")).rejects.toThrow("Set EXE_TOKEN");
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps receipts under ~/.mimir when no data directory is configured", async () => {
  home.dir = mkdtempSync(join(tmpdir(), "mimir-exe-home-"));
  roots.push(home.dir);
  vi.stubEnv("MIMIR_DATA_DIR", undefined);
  vi.stubEnv("EXE_TOKEN", "test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ vm_name: "worker-one", ssh_host: "worker-one.exe.xyz" })),
  );
  expect(await run("create", "worker-one", "request-1")).toMatchObject({ state: "confirmed" });
  expect(existsSync(join(home.dir, ".mimir", "exe-receipts.json"))).toBe(true);
});
