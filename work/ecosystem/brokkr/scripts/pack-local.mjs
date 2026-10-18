// Builds and packs @brokkr/sdk, @brokkr/core and every workspace package they
// (and @brokkr/cli) depend on into <repo>/dist-packages/. `pnpm pack` rewrites
// `workspace:` ranges to real versions. The built-in harness library and the
// license are copied into the SDK and CLI packages for the duration of the pack.
// Local only: nothing is published.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-packages");
const ROOTS = ["@brokkr/sdk", "@brokkr/core", "@brokkr/cli"];
const WITH_HARNESSES = ["@brokkr/sdk", "@brokkr/cli"];

function workspacePackages() {
  const dirs = [];
  for (const base of ["apps", "packages", "packages/adapters"]) {
    for (const e of readdirSync(join(root, base), { withFileTypes: true })) {
      const dir = join(root, base, e.name);
      if (e.isDirectory() && existsSync(join(dir, "package.json"))) dirs.push(dir);
    }
  }
  const byName = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    byName.set(pkg.name, { dir, pkg });
  }
  return byName;
}

function closure(byName, names) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    const entry = byName.get(name);
    if (!entry) throw new Error(`unknown workspace package ${name}`);
    seen.add(name);
    for (const [dep, range] of Object.entries(entry.pkg.dependencies ?? {}))
      if (String(range).startsWith("workspace:")) visit(dep);
  };
  names.forEach(visit);
  return [...seen].sort();
}

const run = (cwd, cmd, args) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });

const byName = workspacePackages();
const names = closure(byName, ROOTS);
console.log(`building ${names.length} packages`);
run(root, "pnpm", ["exec", "turbo", "run", "build", ...names.map((n) => `--filter=${n}`)]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tarballs = {};
const copied = [];
try {
  for (const name of names) {
    const { dir } = byName.get(name);
    if (WITH_HARNESSES.includes(name)) {
      cpSync(join(root, "harnesses"), join(dir, "harnesses"), { recursive: true });
      copied.push(join(dir, "harnesses"));
    }
    if (!existsSync(join(dir, "LICENSE"))) {
      cpSync(join(root, "LICENSE"), join(dir, "LICENSE"));
      copied.push(join(dir, "LICENSE"));
    }
    const json = run(dir, "pnpm", ["pack", "--pack-destination", out, "--json"]);
    const file = JSON.parse(json).filename;
    tarballs[name] = relative(out, file);
    console.log(`  ${name} -> dist-packages/${tarballs[name]}`);
  }
} finally {
  for (const p of copied) rmSync(p, { recursive: true, force: true });
}

// Consumers install the tarballs they need and map every @brokkr/* package to
// its tarball (pnpm `overrides`), so nothing is ever fetched from a registry.
writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ tarballs }, null, 2)}\n`);
console.log(`tarballs written to ${out}`);
