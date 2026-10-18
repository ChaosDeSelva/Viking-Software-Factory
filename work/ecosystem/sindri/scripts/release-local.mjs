// pnpm release:local
// Builds everything, packs the listed packages into dist-packages/, checks the license policy,
// emits the CycloneDX SBOM at dist/sbom.cdx.json, and bundles the CLI with its dependencies and
// the built web app into dist/sindri-<version>-<os>-<arch>.tar.gz (install with
// scripts/install-local.sh).
// Flags: --packages-dir <dir> (default dist-packages), --out-dir <dir> (default dist),
// --skip-build (used by tests).
// Builds everything, runs the test suite with coverage thresholds (pnpm test:coverage), packs
// the listed packages into dist-packages/, checks the license policy, and emits the CycloneDX
// SBOM at dist/sbom.cdx.json.
// Flags: --packages-dir <dir> (default dist-packages), --skip-build (used by tests),
// --skip-coverage (skip the coverage run, for quick local repacks).

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleCli } from "./bundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : resolve(process.argv[i + 1] ?? fallback);
};
const packagesDir = arg("--packages-dir", join(root, "dist-packages"));
const outDir = arg("--out-dir", join(root, "dist"));
const PACK = ["apps/cli", "packages/mimir-client"];
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

if (!process.argv.includes("--skip-build")) run("pnpm", ["build"]);
if (!process.argv.includes("--skip-coverage")) run("pnpm", ["test:coverage"]);

mkdirSync(packagesDir, { recursive: true });
for (const f of readdirSync(packagesDir)) if (f.endsWith(".tgz")) rmSync(join(packagesDir, f));
for (const dir of PACK) run("pnpm", ["pack", "--pack-destination", packagesDir], join(root, dir));

run("node", ["scripts/licenses.mjs"]);
run("node", ["scripts/sbom.mjs"]);
const bundle = bundleCli({ root, outDir });
console.log(`packages: ${packagesDir}`);
console.log(`tarball: ${bundle.tarball} (${bundle.packages} packages bundled)`);
console.log(`sbom: ${join(root, "dist", "sbom.cdx.json")}`);
