import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RuntimeAdapter } from "@mimir/protocol";
import type { FleetRuntime } from "./adapter.js";
import { FleetConfigSchema, loadFleet } from "./config.js";

const roots: string[] = [];
const fleets: FleetRuntime[] = [];
afterEach(async () => {
  for (const fleet of fleets.splice(0)) await fleet.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(workers: unknown[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-fleet-config-")));
  roots.push(root);
  const file = join(root, "fleet.json");
  const write = (value: unknown[]) =>
    writeFileSync(file, JSON.stringify({ version: 1, workers: value }));
  write(workers);
  return { root, file, dataDir: join(root, "data"), write };
}
const ssh = { id: "remote", capacity: 2, runtime: "ssh", host: "factory-worker", root: "/srv/m" };
const skidbladnir = {
  id: "aws",
  capacity: 1,
  runtime: "skidbladnir",
  url: "http://127.0.0.1:4380",
  root: "/srv/mimir",
  template: "general",
  minutes: 15,
};

it("builds one runtime per configured worker and records each worker's identity", async () => {
  const f = workspace([
    ssh,
    { ...ssh, id: "remote-interactive", backend: "tmux-interactive", agentKinds: ["claude"] },
    skidbladnir,
    { id: "local", capacity: 4, runtime: "cli" },
    { id: "local-tmux", capacity: 1, runtime: "tmux" },
    { id: "panes", capacity: 1, runtime: "tmux-interactive" },
  ]);
  const fleet = loadFleet(f.file, f.dataDir);
  fleets.push(fleet);
  const nodes = (
    fleet as unknown as {
      nodes: { id: string; capacity: number; agentKinds?: string[]; runtime: RuntimeAdapter }[];
    }
  ).nodes;
  expect(nodes.map((n) => [n.id, n.capacity, n.agentKinds])).toEqual([
    ["remote", 2, undefined],
    ["remote-interactive", 2, ["claude"]],
    ["aws", 1, undefined],
    ["local", 4, undefined],
    ["local-tmux", 1, undefined],
    ["panes", 1, undefined],
  ]);
  const capabilities = await Promise.all(nodes.map((n) => n.runtime.capabilities()));
  expect(capabilities.map((c) => [c.runtime, c.features.sendInput])).toEqual([
    ["ssh", false],
    ["ssh", true],
    ["skidbladnir", false],
    ["cli", false],
    ["tmux", false],
    ["tmux-interactive", true],
  ]);
  // The fleet's own capabilities honour the per-worker agent kind restriction.
  expect((await fleet.capabilities()).runtime).toBe("fleet");
  const state = JSON.parse(readFileSync(join(f.dataDir, "fleet", "placements.json"), "utf8")) as {
    nodes: [string, { identity: string }][];
  };
  expect(
    Object.fromEntries(state.nodes.map(([id, node]) => [id, JSON.parse(node.identity)])),
  ).toEqual({
    remote: ["ssh", "factory-worker", "/srv/m", null],
    "remote-interactive": ["ssh", "factory-worker", "/srv/m", "tmux-interactive"],
    aws: ["skidbladnir", "http://127.0.0.1:4380", "/srv/mimir", "general", 15],
    local: ["cli", null, null, null],
    "local-tmux": ["tmux", null, null, null],
    panes: ["tmux-interactive", null, null, null],
  });
  // Interactive panes keep their bindings under the fleet's data directory, one home per worker.
  expect(existsSync(join(f.dataDir, "fleet", "panes"))).toBe(true);
});

it("refuses a worker whose route changed while its node ID was kept", async () => {
  const f = workspace([ssh]);
  await loadFleet(f.file, f.dataDir).dispose();
  f.write([{ ...ssh, root: "/srv/other" }]);
  expect(() => loadFleet(f.file, f.dataDir)).toThrow(/changed identity/);
  f.write([{ ...skidbladnir, id: "remote" }]);
  expect(() => loadFleet(f.file, f.dataDir)).toThrow(/changed identity/);
});

it("rejects duplicate IDs, incomplete workers, unknown fields and unsafe routes", () => {
  const load = (workers: unknown[]) => {
    const f = workspace(workers);
    return () => loadFleet(f.file, f.dataDir);
  };
  expect(load([ssh, { ...ssh, capacity: 1 }])).toThrow("Duplicate worker IDs");
  expect(load([{ id: "remote", capacity: 1, runtime: "ssh", host: "factory-worker" }])).toThrow(
    /SSH workers require host and root/,
  );
  expect(load([{ ...skidbladnir, minutes: undefined }])).toThrow(
    /Skidbladnir workers require url, root, template and minutes/,
  );
  expect(load([{ ...ssh, command: "rm -rf /" }])).toThrow(/command/);
  expect(load([{ ...ssh, id: "../escape" }])).toThrow();
  expect(load([{ ...ssh, capacity: 0 }])).toThrow();
  expect(load([])).toThrow();
  // The schema accepts any string; the runtimes themselves refuse routes that could inject.
  expect(load([{ ...ssh, host: "-oProxyCommand=evil" }])).toThrow(/SSH configuration alias/);
  expect(load([{ ...skidbladnir, url: "https://example.com" }])).toThrow(/loopback/);
  expect(FleetConfigSchema.safeParse({ version: 2, workers: [ssh] }).success).toBe(false);
});

it("fails loudly when the configuration file is missing or not JSON", () => {
  const f = workspace([ssh]);
  expect(() => loadFleet(join(f.root, "absent.json"), f.dataDir)).toThrow(/ENOENT/);
  writeFileSync(f.file, "{not json");
  expect(() => loadFleet(f.file, f.dataDir)).toThrow(SyntaxError);
});
