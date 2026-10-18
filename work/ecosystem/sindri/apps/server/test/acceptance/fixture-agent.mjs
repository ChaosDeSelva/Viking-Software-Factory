// Explicit deterministic agent fixture. The server, git, Brokkr checks and evidence remain real.
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
const root = resolve(dirname(process.env.SINDRI_ACCEPTANCE_MIMIR_MAIN), "../../..");
const { FakeRuntime } = await import(
  pathToFileURL(join(root, "packages/fake-runtime/dist/index.js"))
);
const create = FakeRuntime.prototype.createSession;
FakeRuntime.prototype.createSession = function (spec) {
  mkdirSync(join(spec.cwd, "node_modules"), { recursive: true });
  mkdirSync(join(spec.cwd, ".mimir/artifacts"), { recursive: true });
  // Simulated reviewer output must follow the same assigned criterion contract as a real agent.
  // This fixture validates plumbing, not model judgment or browser acceptance.
  const brief = spec.argv.join(" ");
  const assigned = brief.match(/Acceptance criteria(?: to judge)?: ([A-Za-z0-9_, -]+?)(?: Role:| Do not change|\n|$)/)?.[1] ?? "";
  const acceptance = assigned.split(",").map(id => id.trim()).filter(Boolean).map(criterionId => ({
    criterionId, satisfied: true, note: "Deterministic acceptance fixture; model review is simulated",
  }));
  writeFileSync(
    join(spec.cwd, ".mimir/artifacts/review.json"),
    JSON.stringify({ verdict: "approve", findings: [], acceptance, decisions: [] }),
  );
  return create.call(this, spec);
};
const { Brokkr } = await import(
  pathToFileURL(join(root, "apps/server/node_modules/@brokkr/sdk/dist/index.js"))
);
mkdirSync(process.env.MIMIR_DATA_DIR, { recursive: true });
const selection = await new Brokkr({ cwd: root, homeDir: process.env.MIMIR_DATA_DIR }).resolve({
  task: {
    id: "acceptance",
    title: "Acceptance fixture",
    description: "Real regression checks for deterministic agents",
  },
  harnesses: [{ name: "qa-regression", version: "^1" }],
});
writeFileSync(
  join(process.env.MIMIR_DATA_DIR, "acceptance.lock.json"),
  JSON.stringify(selection.lock),
);
