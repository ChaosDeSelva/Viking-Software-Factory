// Self-contained CLI bundle for `pnpm release:local`, built from the installed workspace with no
// network: the CLI's production dependency closure is copied into a pnpm-like isolated layout
// (lib/store/<id>/node_modules/<name> plus relative symlinks to each dependency), so every
// package keeps exactly the versions it was tested with. Native modules (better-sqlite3) are
// copied as built, hence the os/arch in the tarball name.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Node-style lookup of `name` from a package directory (pnpm virtual store aware). */
function findPackage(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    }
    if (dirname(dir) === dir) return null;
  }
}

const SKIP = new Set(["node_modules", ".turbo", ".vite"]);

/**
 * Copies `entryDir`'s production dependency closure into `<libDir>/store` and links its direct
 * dependencies into `<entryOut>/node_modules`. Workspace packages (not under node_modules) are
 * copied without sources. Returns the number of packages copied.
 */
export function copyDependencyClosure(entryDir, entryOut, libDir) {
  const ids = new Map(); // realpath -> store id
  const storeDir = join(libDir, "store");
  const idFor = (real, pkg) =>
    `${pkg.name.replace("/", "+")}@${pkg.version}-${createHash("sha256").update(real).digest("hex").slice(0, 8)}`;
  const deps = (pkg) => [
    ...Object.keys(pkg.dependencies ?? {}).map((n) => [n, true]),
    ...Object.keys(pkg.optionalDependencies ?? {}).map((n) => [n, false]),
    ...Object.keys(pkg.peerDependencies ?? {}).map((n) => [n, false]),
  ];
  const link = (fromModules, name, real) => {
    const id = ids.get(real);
    const target = join(storeDir, id, "node_modules", name);
    const at = join(fromModules, name);
    if (existsSync(at)) return;
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(relative(dirname(at), target), at);
  };
  const visit = (real) => {
    if (ids.has(real)) return;
    const pkg = readJson(join(real, "package.json"));
    const id = idFor(real, pkg);
    ids.set(real, id);
    const dest = join(storeDir, id, "node_modules", pkg.name);
    const workspace = !real.split("/").includes("node_modules");
    cpSync(real, dest, {
      recursive: true,
      filter: (src) => {
        const rel = relative(real, src);
        const top = rel.split("/")[0];
        if (SKIP.has(top) || rel.split("/").includes("node_modules")) return false;
        if (workspace && rel && !["dist", "package.json", "LICENSE"].includes(top)) return false;
        if (workspace && /\.test\.(?:js|d\.ts)(?:\.map)?$/.test(rel)) return false;
        return true;
      },
    });
    for (const [name, required] of deps(pkg)) {
      const dep = findPackage(real, name);
      if (!dep) {
        if (required) throw new Error(`${pkg.name}: cannot resolve dependency ${name}`);
        continue;
      }
      visit(dep);
      link(join(storeDir, id, "node_modules"), name, dep);
    }
  };
  const entry = readJson(join(entryDir, "package.json"));
  for (const [name, required] of deps(entry)) {
    const dep = findPackage(entryDir, name);
    if (!dep) {
      if (required) throw new Error(`${entry.name}: cannot resolve dependency ${name}`);
      continue;
    }
    visit(dep);
    link(join(entryOut, "node_modules"), name, dep);
  }
  return ids.size;
}

const SHIM = `#!/bin/sh
# Sindri launcher: runs the bundled CLI with the node on PATH (Node 25 or newer).
set -e
self="$0"
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
here=$(cd "$(dirname "$self")/.." && pwd)
exec node "$here/lib/cli/dist/main.js" "$@"
`;

/**
 * Builds `<outDir>/sindri-<version>-<os>-<arch>.tar.gz` from the built workspace at `root`.
 * Layout: bin/sindri, lib/cli (dist + package.json + node_modules links), lib/web/dist,
 * lib/store, install-local.sh, LICENSE, README.md, CHANGELOG.md.
 */
export function bundleCli({ root, outDir }) {
  const cliDir = join(root, "apps/cli");
  const webDist = join(root, "apps/web/dist");
  for (const need of [join(cliDir, "dist/main.js"), join(webDist, "index.html")])
    if (!existsSync(need)) throw new Error(`missing ${need}; run pnpm build first`);
  const version = readJson(join(cliDir, "package.json")).version;
  const os = process.platform === "darwin" ? "macos" : process.platform;
  const name = `sindri-${version}-${os}-${process.arch}`;
  const stage = join(outDir, `.stage-${process.pid}`);
  const top = join(stage, name);
  rmSync(stage, { recursive: true, force: true });
  const lib = join(top, "lib");
  const cliOut = join(lib, "cli");
  mkdirSync(cliOut, { recursive: true });
  cpSync(join(cliDir, "dist"), join(cliOut, "dist"), { recursive: true });
  copyFileSync(join(cliDir, "package.json"), join(cliOut, "package.json"));
  cpSync(webDist, join(lib, "web", "dist"), { recursive: true });
  const packages = copyDependencyClosure(cliDir, cliOut, lib);
  mkdirSync(join(top, "bin"));
  writeFileSync(join(top, "bin", "sindri"), SHIM);
  chmodSync(join(top, "bin", "sindri"), 0o755);
  copyFileSync(join(root, "scripts/install-local.sh"), join(top, "install-local.sh"));
  chmodSync(join(top, "install-local.sh"), 0o755);
  for (const f of ["LICENSE", "README.md", "CHANGELOG.md"])
    if (existsSync(join(root, f))) copyFileSync(join(root, f), join(top, f));
  writeFileSync(join(top, "VERSION"), `${version}\n`);
  mkdirSync(outDir, { recursive: true });
  const tarball = join(outDir, `${name}.tar.gz`);
  rmSync(tarball, { force: true });
  // COPYFILE_DISABLE keeps macOS metadata (._ files) out of the archive.
  execFileSync("tar", ["-czf", tarball, "-C", stage, name], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  rmSync(stage, { recursive: true, force: true });
  return { tarball, name, version, packages };
}
