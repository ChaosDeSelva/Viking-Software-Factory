// pnpm release:local
// Builds everything, packs @mimir/protocol and @mimir/sdk into dist-packages/, and writes
// dist/mimir-<version>-macos-arm64.tar.gz: the built CLI, server and web app, runnable with `node`.
// Flags (used by the test): --out-dir <dir> (default dist), --packages-dir <dir> (default dist-packages),
// --skip-coverage (skip the `pnpm test:coverage` gate; the release test and the QA smoke's dev loop use it).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : resolve(process.argv[i + 1] ?? fallback);
};
const outDir = arg("--out-dir", join(root, "dist"));
const packagesDir = arg("--packages-dir", join(root, "dist-packages"));

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error(
    `release:local only builds the macos-arm64 artifact (this host is ${process.platform}-${process.arch}); ` +
      "the bundle contains native modules compiled for the build host.",
  );
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const name = `mimir-${version}-macos-arm64`;
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

// 1. Build everything, then the coverage gate (tests + per-package floors, see CONTRIBUTING.md).
run("pnpm", ["build"]);
if (!process.argv.includes("--skip-coverage")) run("pnpm", ["test:coverage"]);

// 2. Library tarballs for other repos (Sindri consumes these).
mkdirSync(packagesDir, { recursive: true });
for (const f of readdirSync(packagesDir)) {
  if (/^mimir-(protocol|sdk)-.*\.tgz$/.test(f)) rmSync(join(packagesDir, f));
}
for (const pkg of ["protocol", "sdk"]) {
  run("pnpm", ["pack", "--pack-destination", packagesDir], join(root, "packages", pkg));
}

// 3. Stage the runnable bundle.
const stageRoot = join(outDir, "stage");
const stage = join(stageRoot, name);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(join(stage, "app"), { recursive: true });
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(join(stage, "scripts"), { recursive: true });

for (const app of ["cli", "server"]) {
  // pnpm deploy copies the package with its production dependencies (workspace packages included).
  run("pnpm", ["--filter", `@mimir/${app}`, "deploy", "--prod", join(stage, "app", app)]);
}
cpSync(join(root, "apps/web/dist"), join(stage, "app/web/dist"), { recursive: true });

// Strip everything that is not needed at run time.
for (const app of ["cli", "server"]) {
  const dir = join(stage, "app", app);
  for (const f of [
    "src",
    "eslint.config.js",
    "vitest.config.ts",
    "vitest.chaos.config.ts",
    "test",
    "bench",
    "tsconfig.json",
    "tsconfig.build.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]) {
    rmSync(join(dir, f), { recursive: true, force: true });
  }
}
const stripTests = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) stripTests(p);
    else if (/\.test\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(e.name)) rmSync(p);
  }
};
stripTests(join(stage, "app"));

writeFileSync(
  join(stage, "bin/mimir"),
  `#!/bin/sh
# Resolves symlinks so the shim and a direct call behave the same.
self="$0"
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
base=$(cd "$(dirname "$self")/.." && pwd -P)
exec node "$base/app/cli/dist/main.js" "$@"
`,
);
chmodSync(join(stage, "bin/mimir"), 0o755);
writeFileSync(
  join(stage, "bin/mimir-remote-entrypoint"),
  `#!/bin/sh
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export MIMIR_REMOTE_ROOT="\${MIMIR_REMOTE_ROOT:-$HOME/.mimir-remote}"
exec node "$base/app/server/dist/ssh-runtime/entrypoint.js"
`,
);
chmodSync(join(stage, "bin/mimir-remote-entrypoint"), 0o755);

writeFileSync(
  join(stage, "bin/mimir-exe-worker"),
  `#!/bin/sh
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$base/app/server/dist/providers/cli.js" "$@"
`,
);
chmodSync(join(stage, "bin/mimir-exe-worker"), 0o755);
copyFileSync(join(root, "scripts/install-local.sh"), join(stage, "scripts/install-local.sh"));
chmodSync(join(stage, "scripts/install-local.sh"), 0o755);
for (const f of ["LICENSE", "README.md", "CHANGELOG.md"])
  copyFileSync(join(root, f), join(stage, f));
cpSync(join(root, "site"), join(stage, "site"), { recursive: true });
cpSync(join(root, "third_party"), join(stage, "third_party"), { recursive: true });
cpSync(join(root, "docs"), join(stage, "docs"), {
  recursive: true,
  filter: (src) => src !== join(root, "docs", "herdr"),
});
writeFileSync(join(stage, "VERSION"), `${version}\n`);

// 4. Tar it.
mkdirSync(outDir, { recursive: true });
const tarball = join(outDir, `${name}.tar.gz`);
if (existsSync(tarball)) rmSync(tarball);
execFileSync("tar", ["-czf", tarball, "-C", stageRoot, name], {
  stdio: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
rmSync(stageRoot, { recursive: true, force: true });

// 5. Supply chain: license policy gate and CycloneDX SBOM (dist/sbom.cdx.json by default).
run("node", ["scripts/licenses.mjs"]);
run("node", ["scripts/sbom.mjs", "--out", join(outDir, "sbom.cdx.json")]);
console.log(`sbom: ${join(outDir, "sbom.cdx.json")}`);
console.log(`tarball: ${tarball}`);
console.log(`packages: ${packagesDir}`);
