// Installs the tarballs from dist-packages/ into a fresh temp project (no
// workspace, no source paths) and proves a consumer can use them:
//   - `new Brokkr()` resolves, prepares and verifies (MockExecutor and the real executor);
//   - `@brokkr/sdk/testing` and the JSON Schemas are importable;
//   - the type declarations typecheck in a strict TypeScript consumer.
// Run `pnpm pack:local` first. Installs offline from a lockfile (scripts/lib/offline-install.mjs).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { offlineInstall, workspacePins } from "./lib/offline-install.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = join(root, "dist-packages");
const { tarballs } = JSON.parse(readFileSync(join(packages, "manifest.json"), "utf8"));
const app = mkdtempSync(join(tmpdir(), "brokkr-consumer-"));
const spec = (name) => `file:${join(packages, tarballs[name])}`;

const run = (cmd, args, cwd = app) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
console.log(`consumer project: ${app}`);
// Offline from a lockfile; every version pinned to the workspace lock (review I6).
const pins = {
  ...workspacePins(root, ["--filter", "@brokkr/sdk", "--prod"]),
  ...workspacePins(root, ["-w", "typescript", "@types/node"]),
};
offlineInstall(app, {
  pkg: {
    name: "brokkr-consumer",
    private: true,
    type: "module",
    dependencies: { "@brokkr/sdk": spec("@brokkr/sdk"), "@brokkr/core": spec("@brokkr/core") },
    devDependencies: { typescript: pins.typescript, "@types/node": pins["@types/node"] },
  },
  tarballs: Object.fromEntries(Object.keys(tarballs).map((n) => [n, spec(n)])),
  pins,
});
console.log(
  `installed with pnpm install --frozen-lockfile --offline (${Object.keys(pins).length} pinned third-party packages)`,
);

// A repository to work on.
const repo = join(app, "repo");
mkdirSync(repo);
writeFileSync(
  join(repo, "package.json"),
  JSON.stringify({ name: "r", private: true, scripts: { test: "node check.mjs" } }),
);
writeFileSync(join(repo, "check.mjs"), "console.log('42 passed');\n");

writeFileSync(
  join(app, "consumer.ts"),
  `import {
  Brokkr,
  LocalProcessExecutor,
  VerificationReportSchema,
  type CheckExecutionRequest,
  type CheckExecutionResult,
  type CheckExecutor,
  type Selection,
  type VerificationEvent,
} from "@brokkr/sdk";
import { MockExecutor } from "@brokkr/sdk/testing";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = ${JSON.stringify(repo)};
const homeDir = mkdtempSync(join(tmpdir(), "brokkr-consumer-home-"));
const task = { id: "QA-1", title: "Regression pass", description: "qa", taskTypes: ["qa"] };

const brokkr = new Brokkr({ cwd: repo, offline: true, homeDir });
const harnesses = await brokkr.listHarnesses();
const selection: Selection = await brokkr.resolve({ task });
const prepared = await brokkr.prepare({ selection, provider: "claude-code" });

const events: VerificationEvent[] = [];
const mocked = await new Brokkr({ cwd: repo, homeDir, executor: new MockExecutor({ test: "failed" }) })
  .verify({ selection, workspace: repo, onEvent: (e) => events.push(e) });
// A consumer-implemented executor, type-checked against the tarball's CheckExecutor (review M1).
class AuditingExecutor implements CheckExecutor {
  readonly seen: string[] = [];
  private readonly inner = new LocalProcessExecutor();
  execute(request: CheckExecutionRequest, signal?: AbortSignal): Promise<CheckExecutionResult> {
    this.seen.push(request.checkId);
    return this.inner.execute(request, signal);
  }
}
const auditing = new AuditingExecutor();
const real = await new Brokkr({ cwd: repo, homeDir, executor: auditing, lock: selection.lock }).verify({
  selection,
  workspace: repo,
});

const schemaPath = createRequire(import.meta.url).resolve("@brokkr/sdk/schemas/verification-report.v1.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { title: string };
console.log(JSON.stringify({
  harnesses: harnesses.length,
  selected: selection.harnesses.map((h) => h.name),
  prepared: prepared.files.length,
  mocked: mocked.verdict,
  events: events.map((e) => e.type),
  real: real.verdict,
  injected: auditing.seen,
  realValid: VerificationReportSchema.safeParse(real).success,
  schema: schema.title,
}));
`,
);
writeFileSync(
  join(app, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      skipLibCheck: true, // pino's thread-stream d.ts does not compile against @types/node 26
      types: ["node"],
      allowImportingTsExtensions: true,
    },
    include: ["consumer.ts"],
  }),
);
console.log("$ tsc --noEmit (strict consumer)");
run(join(app, "node_modules/.bin/tsc"), ["--noEmit", "-p", "."]);
console.log("types ok");
console.log("$ node consumer.ts");
const out = JSON.parse(
  run("node", ["--experimental-strip-types", "--no-warnings", "consumer.ts"]).trim(),
);
console.log(JSON.stringify(out, null, 2));
const ok =
  out.harnesses >= 8 &&
  out.selected.includes("qa-regression") &&
  out.prepared > 0 &&
  out.mocked === "failed" &&
  out.events[0] === "verification.started" &&
  out.events.at(-1) === "verification.completed" &&
  out.real === "passed" &&
  out.injected.includes("test") &&
  out.realValid === true;
if (!ok) {
  console.error("tarball smoke test FAILED");
  process.exit(1);
}
console.log("tarball smoke test passed");
