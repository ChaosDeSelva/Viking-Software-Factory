// pnpm qa:smoke: one command a QA engineer runs after cloning. Builds, runs release:local,
// extracts the archive to a temp dir, installs the shim into a temp HOME, then drives the
// shipped `brokkr` end to end. Exit 0 only if every step passes (skips are listed, not hidden).
// Output of every step: qa-smoke-output/<timestamp>/NN-<step>.log (gitignored).
//   --with-coverage   also run the coverage gate inside release:local (slow)
//   --skip-repro      skip `pnpm release:repro` (runs release:local twice)
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner, formatTable } from "./lib/steps.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(root, "qa-smoke-output", stamp);
const tmp = mkdtempSync(join(tmpdir(), "brokkr-qa-"));
const home = join(tmp, "home");
const binDir = join(home, ".local", "bin");
const prefix = join(home, ".local", "share", "brokkr");
mkdirSync(binDir, { recursive: true });

// Hermetic environment for everything that runs the shipped CLI: temp HOME, no inherited overrides.
const env = {
  ...process.env,
  HOME: home,
  BROKKR_HOME: home,
  BROKKR_BIN_DIR: binDir,
  BROKKR_PREFIX: prefix,
};
delete env.BROKKR_BUILTIN_HARNESSES;
env.PATH = `${binDir}:${process.env.PATH}`;

const runner = createRunner({ outDir, env });
const { step } = runner;
const repo = join(tmp, "demo");
const brokkr = (ctx, label, args, opts = {}) =>
  ctx.exec(label, join(binDir, "brokkr"), args, { cwd: repo, ...opts });
const json = (res) => JSON.parse(res.stdout);
const latestRun = async () => {
  const { runsRootFor } = await import("../packages/evidence/dist/index.js");
  const dir = runsRootFor(repo, env.BROKKR_HOME);
  return join(dir, readdirSync(dir).sort().at(-1));
};
console.log(`qa:smoke  output ${outDir}\n          temp ${tmp}\n`);

await step("build", (ctx) => ctx.exec("pnpm build", "pnpm", ["build"], { cwd: root }));

let archive = "";
await step("release:local", async (ctx) => {
  const e = flags.has("--with-coverage") ? env : { ...env, BROKKR_SKIP_COVERAGE: "1" };
  if (!flags.has("--with-coverage"))
    ctx.log("coverage gate skipped here (run `pnpm test:coverage`, or pass --with-coverage)");
  await ctx.exec("pnpm release:local", "pnpm", ["release:local"], {
    cwd: root,
    env: { ...e, HOME: process.env.HOME, PATH: process.env.PATH },
  });
  const tgz = readdirSync(join(root, "dist")).filter((f) => /^brokkr-.*\.tar\.gz$/.test(f));
  ctx.expect(tgz.length > 0, "no brokkr-*.tar.gz in dist/");
  archive = join(root, "dist", tgz.sort().at(-1));
  ctx.expect(existsSync(`${archive}.sha256`), "missing .sha256 next to the archive");
  ctx.log(`archive: ${archive}`);
});

await step("extract+install shim", async (ctx) => {
  ctx.expect(archive, "no archive (release:local failed)");
  const x = join(tmp, "extract");
  mkdirSync(x);
  await ctx.exec("tar -x", "tar", ["-xzf", archive, "-C", x]);
  const res = await ctx.exec(
    "install-local.sh",
    "sh",
    [join(root, "scripts/install-local.sh"), archive],
    { cwd: root },
  );
  ctx.expect(/checksum ok/.test(res.stdout), "install-local did not verify the checksum");
  ctx.expect(existsSync(join(binDir, "brokkr")), "shim not written to the temp HOME");
});

await step("checksum tamper refused", async (ctx) => {
  ctx.expect(archive, "no archive");
  const bad = join(tmp, "tampered");
  mkdirSync(bad);
  const copy = join(bad, archive.split("/").at(-1));
  cpSync(archive, copy);
  writeFileSync(`${copy}.sha256`, `${"0".repeat(64)}  ${copy.split("/").at(-1)}\n`);
  const res = await ctx.exec(
    "install-local.sh (bad sha)",
    "sh",
    [join(root, "scripts/install-local.sh"), copy],
    {
      cwd: root,
      env: { ...env, BROKKR_PREFIX: join(bad, "prefix"), BROKKR_BIN_DIR: join(bad, "bin") },
      expect: [1],
    },
  );
  ctx.expect(/checksum mismatch/.test(res.stderr), "expected 'checksum mismatch' on stderr");
  ctx.expect(!existsSync(join(bad, "prefix")), "installer wrote files despite a bad checksum");
});

await step("brokkr doctor", async (ctx) => {
  mkdirSync(repo, { recursive: true });
  const r = json(await brokkr(ctx, "doctor --json", ["doctor", "--json"], { cwd: tmp }));
  ctx.expect(r.ok === true, "doctor reported ok=false");
  ctx.log(`doctor checks: ${r.checks.map((c) => `${c.id}:${c.status}`).join(" ")}`);
});

await step("fixture repo", async (ctx) => {
  cpSync(join(root, "tests/fixtures/react-app"), repo, { recursive: true });
  const pkgFile = join(repo, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  pkg.dependencies = { react: "^19.0.0" };
  pkg.devDependencies = { typescript: "^6.0.0" };
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  // A real assertion failure exercises the failed-verdict path independently of CLI flags.
  appendFileSync(
    join(repo, "tests/label.test.mjs"),
    '\ntest("planted QA failure", () => assert.fail("intentional QA failure"));\n',
  );
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.brokkr/\n");
  writeFileSync(
    join(repo, "task.json"),
    JSON.stringify({
      id: "QA-1",
      title: "Add button",
      description: "React button component",
      taskTypes: ["frontend"],
    }),
  );
  const git = (...a) =>
    ctx.exec(
      `git ${a[0]}`,
      "git",
      ["-c", "user.name=qa", "-c", "user.email=qa@example.invalid", ...a],
      { cwd: repo },
    );
  await git("init", "-q");
  await ctx.exec("pnpm install --offline", "pnpm", ["install", "--offline"], {
    cwd: repo,
    env: process.env, // the real pnpm store: --offline needs it; nothing is downloaded
  });
  await git("add", "-A");
  await git("commit", "-qm", "fixture");
});

await step("harness list", async (ctx) => {
  const r = json(await brokkr(ctx, "harness list --json", ["harness", "list", "--json"]));
  const names = (r.harnesses ?? r).map((h) => `${h.name}@${h.version}`);
  ctx.expect(names.length >= 8, `expected >= 8 built-in harnesses, got ${names.length}`);
  ctx.expect(
    names.some((n) => n.startsWith("frontend-react@")),
    "frontend-react missing",
  );
});

await step("harness validate", async (ctx) => {
  await brokkr(ctx, "validate frontend-react", [
    "harness",
    "validate",
    join(root, "harnesses/frontend-react"),
  ]);
  const bad = join(tmp, "bad-harness");
  mkdirSync(bad);
  writeFileSync(join(bad, "harness.yaml"), "name: [this is not a valid manifest\n");
  const res = await brokkr(ctx, "validate broken harness", ["harness", "validate", bad], {
    expect: [1, 2, 3, 4],
  });
  ctx.log(`broken harness refused with exit ${res.code}`);
});

await step("init", async (ctx) => {
  const res = await brokkr(ctx, "init --yes", ["init", "--yes"]);
  ctx.expect(/frontend-react/.test(res.stdout), "init did not recommend frontend-react");
  ctx.expect(existsSync(join(repo, ".brokkr/config.yaml")), ".brokkr/config.yaml not written");
  ctx.expect(existsSync(join(repo, ".brokkr/harness.lock.json")), "harness.lock.json not written");
});

await step("skills resolve", async (ctx) => {
  const r = json(
    await brokkr(ctx, "skills resolve --json", [
      "skills",
      "resolve",
      "--task",
      "task.json",
      "--json",
    ]),
  );
  const picked = r.skills.filter((s) => s.selected).map((s) => s.name);
  for (const s of ["typescript", "react-architecture", "accessibility"])
    ctx.expect(picked.includes(s), `skill ${s} not selected`);
});

await step("prepare", async (ctx) => {
  for (const provider of ["claude-code", "codex"]) {
    const r = json(
      await brokkr(ctx, `prepare ${provider}`, [
        "prepare",
        "--provider",
        provider,
        "--task",
        "task.json",
        "--json",
      ]),
    );
    ctx.expect(existsSync(r.entrypoint), `${provider}: entrypoint ${r.entrypoint} missing`);
  }
});

await step("verify (documented failing verdict)", async (ctx) => {
  // The planted assertion fails; browser checks are not applicable without Playwright.
  await brokkr(ctx, "verify", ["verify"], { expect: [1] });
  const rep = JSON.parse(readFileSync(join(await latestRun(), "report.json"), "utf8"));
  ctx.expect(rep.verdict === "failed", `verdict ${rep.verdict}, expected failed`);
  const state = Object.fromEntries(rep.checks.map((c) => [c.id, c.state]));
  ctx.expect(state.typecheck === "passed", `typecheck ${state.typecheck}`);
  ctx.expect(state.unit === "failed", `unit ${state.unit}`);
  ctx.expect(
    state.axe === "skipped",
    "a required browser check must be reported skipped, not passed",
  );
  ctx.log(`checks: ${JSON.stringify(state)}`);
});

await step("report formats", async (ctx) => {
  const md = await brokkr(ctx, "report md", ["report", "--latest", "--format", "md"]);
  ctx.expect(/# Brokkr verification: FAILED/.test(md.stdout), "md report lacks the FAILED heading");
  const html = await brokkr(ctx, "report html", ["report", "--latest", "--format", "html"]);
  ctx.expect(/<!doctype html>/i.test(html.stdout), "html report is not an html document");
  ctx.expect(
    !/https?:\/\//.test(html.stdout.replace(/xmlns="[^"]*"/g, "")),
    "html report references an external URL (must be offline)",
  );
  const j = json(await brokkr(ctx, "report json", ["report", "--latest", "--json"]));
  ctx.expect(
    j.verdict === "failed" && j.schemaVersion === "1.0",
    "json report verdict/schemaVersion unexpected",
  );
  const runs = json(await brokkr(ctx, "runs list", ["runs", "list", "--json"]));
  ctx.expect(runs.runs.length === 1, "expected one run");
  await brokkr(ctx, "trust list", ["trust", "list"]);
});

await step("evidence tamper refused", async (ctx) => {
  appendFileSync(join(await latestRun(), "logs", "unit.log"), "tampered\n");
  const runId = (await latestRun()).split("/").at(-1);
  const res = await brokkr(ctx, "report after tamper", ["report", "--run", runId], { expect: [1] });
  ctx.expect(/integrity/.test(res.stderr), "expected an integrity failure message");
});

await step("runs prune", async (ctx) => {
  await brokkr(ctx, "runs prune --keep 10", ["runs", "prune", "--keep", "10"]);
});

await step("sdk tarball consumer (smoke:pack)", async (ctx) => {
  await ctx.exec("pnpm smoke:pack", "pnpm", ["smoke:pack"], { cwd: root, env: process.env });
});

await step("release:repro byte-identical", async (ctx) => {
  if (flags.has("--skip-repro")) ctx.skip("--skip-repro");
  const res = await ctx.exec("pnpm release:repro", "pnpm", ["release:repro"], {
    cwd: root,
    env: process.env,
  });
  ctx.expect(
    /reproducible: both runs are byte-identical/.test(res.stdout),
    "archives differ between runs",
  );
});

const table = formatTable(runner.results);
writeFileSync(join(outDir, "summary.txt"), `${table}\n`);
console.log(`\n${table}\n\nsummary: ${join(outDir, "summary.txt")}`);
process.exit(runner.exitCode());
