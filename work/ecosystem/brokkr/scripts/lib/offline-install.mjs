// Offline, lockfile-pinned installs for release:local and smoke:pack (review I6).
// Third-party versions are taken from the workspace's own resolution
// (`pnpm list --json`, i.e. pnpm-lock.yaml) and pinned with overrides; every
// @brokkr/* package is pinned to its local tarball. The install first writes a
// lockfile offline, then installs from it with --frozen-lockfile --offline, so
// nothing is ever resolved from or fetched over the network.
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pnpm = (cwd, args) =>
  execFileSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** name -> version for every non-workspace package in `pnpm list <args> --json`. */
export function workspacePins(root, args) {
  const tree = JSON.parse(pnpm(root, ["list", ...args, "--depth", "Infinity", "--json"]) || "[]");
  const found = new Map();
  const walk = (deps) => {
    for (const [name, dep] of Object.entries(deps ?? {})) {
      if (typeof dep.version === "string" && !dep.version.startsWith("link:")) {
        const set = found.get(name) ?? new Set();
        set.add(dep.version);
        found.set(name, set);
      }
      walk(dep.dependencies);
    }
  };
  for (const pkg of tree) {
    walk(pkg.dependencies);
    walk(pkg.devDependencies);
  }
  const pins = {};
  for (const [name, versions] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    if (name.startsWith("@brokkr/")) continue;
    if (versions.size !== 1)
      throw new Error(`cannot pin ${name}: the workspace resolves ${[...versions].join(", ")}`);
    pins[name] = [...versions][0];
  }
  return pins;
}

/**
 * Write package.json + pnpm-workspace.yaml in `dir` and install offline from a
 * lockfile. `tarballs` maps @brokkr/* names to `file:` specs.
 */
export function offlineInstall(dir, { pkg, tarballs, pins, prod = false, hoisted = false }) {
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const lines = [
    ...(hoisted ? ["nodeLinker: hoisted"] : []),
    "overrides:",
    ...Object.entries(tarballs).map(([n, spec]) => `  "${n}": "${spec}"`),
    ...Object.entries(pins).map(([n, v]) => `  "${n}": "${v}"`),
    "",
  ];
  writeFileSync(join(dir, "pnpm-workspace.yaml"), lines.join("\n"));
  pnpm(dir, ["install", "--lockfile-only", "--offline", "--ignore-scripts"]);
  pnpm(dir, [
    "install",
    "--frozen-lockfile",
    "--offline",
    "--ignore-scripts",
    ...(prod ? ["--prod"] : []),
  ]);
}

/** Remove pnpm's per-install state (timestamps, store paths) so the tree is reproducible. */
export function stripInstallState(dir) {
  const nm = join(dir, "node_modules");
  for (const f of [".modules.yaml", ".pnpm-workspace-state-v1.json", ".pnpm"])
    rmSync(join(nm, f), { recursive: true, force: true });
  for (const e of readdirSync(nm)) if (e.startsWith(".pnpm-")) rmSync(join(nm, e), { force: true });
}
