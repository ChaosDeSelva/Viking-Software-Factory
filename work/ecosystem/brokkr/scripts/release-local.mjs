// pnpm release:local (no publish, no network):
//   0. run the coverage gate (pnpm test:coverage; skipped when BROKKR_SKIP_COVERAGE=1);
//   1. pack the workspace (scripts/pack-local.mjs) and check the license policy;
//   2. install @brokkr/cli from those tarballs into a relocatable lib/ with
//      `pnpm install --frozen-lockfile --offline` from a lockfile whose
//      third-party versions are pinned to the workspace lock (review I6);
//   3. generate the CycloneDX SBOM from the shipped lib/ and the TypeDoc API docs;
//   4. write a reproducible dist/brokkr-<version>-<os>-<arch>.tar.gz (sorted
//      entries, fixed mtime from SOURCE_DATE_EPOCH or the HEAD commit, uid/gid 0,
//      no extended attributes, gzip -n) plus a .sha256;
//   5. extract it to a temp dir and smoke test `brokkr doctor` and
//      `brokkr harness list --json`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { offlineInstall, stripInstallState, workspacePins } from "./lib/offline-install.mjs";
import { buildSbom } from "./sbom.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cwd, cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  });

const version = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")).version;
const os =
  { darwin: "macos", linux: "linux", win32: "windows" }[process.platform] ?? process.platform;
const name = `brokkr-${version}-${os}-${process.arch}`;
const dist = join(root, "dist");
const stage = join(dist, "stage");
const top = join(stage, name);
const epoch = Number(
  process.env.SOURCE_DATE_EPOCH ?? run(root, "git", ["log", "-1", "--format=%ct"]).trim(),
);
const epochIso = new Date(epoch * 1000).toISOString();

if (process.env.BROKKR_SKIP_COVERAGE === "1") {
  console.log("== coverage gate skipped (BROKKR_SKIP_COVERAGE=1)");
} else {
  console.log("== coverage gate (pnpm test:coverage)");
  execFileSync("node", [join(root, "scripts/coverage.mjs")], { cwd: root, stdio: "inherit" });
}

console.log("== pack");
execFileSync("node", [join(root, "scripts/pack-local.mjs")], { cwd: root, stdio: "inherit" });
const { tarballs } = JSON.parse(readFileSync(join(root, "dist-packages/manifest.json"), "utf8"));

console.log("== license policy");
execFileSync("node", [join(root, "scripts/licenses.mjs")], { cwd: root, stdio: "inherit" });

console.log(`== assemble ${name} (offline, frozen lockfile)`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(top, "bin"), { recursive: true });
mkdirSync(join(top, "lib"), { recursive: true });
cpSync(join(root, "dist-packages"), join(top, "packages"), { recursive: true });
const fileSpec = (pkg) => `file:../packages/${tarballs[pkg]}`;
const pins = workspacePins(root, ["--filter", "@brokkr/cli", "--prod"]);
offlineInstall(join(top, "lib"), {
  pkg: {
    name: "brokkr-release",
    version,
    private: true,
    type: "module",
    dependencies: { "@brokkr/cli": fileSpec("@brokkr/cli") },
  },
  tarballs: Object.fromEntries(Object.keys(tarballs).map((p) => [p, fileSpec(p)])),
  pins,
  prod: true,
  hoisted: true,
});
console.log(`installed @brokkr/cli with ${Object.keys(pins).length} pinned third-party packages`);

console.log("== SBOM of the shipped lib/");
const pnpmJson = (cwd, args) => JSON.parse(run(cwd, "pnpm", args) || "[]");
const libTree = pnpmJson(join(top, "lib"), ["list", "--prod", "--depth", "Infinity", "--json"]);
const licenses = {};
for (const [license, pkgs] of Object.entries(
  pnpmJson(join(top, "lib"), ["licenses", "list", "--prod", "--json"]),
))
  for (const p of pkgs) for (const v of p.versions ?? []) licenses[`${p.name}@${v}`] = license;
// Resolved URLs are machine-specific (local tarball paths); paths are only used for traversal.
const scrub = (node) => {
  delete node.resolved;
  for (const g of ["dependencies", "devDependencies", "optionalDependencies"])
    for (const d of Object.values(node[g] ?? {})) scrub(d);
  return node;
};
const sbom = buildSbom({
  tree: libTree.map(scrub),
  licenses,
  rootName: name,
  timestamp: epochIso,
  serialNumber: "urn:uuid:00000000-0000-0000-0000-000000000000",
});
const digest = createHash("sha256").update(JSON.stringify(sbom.components)).digest("hex");
sbom.serialNumber = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
writeFileSync(join(top, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`sbom: ${sbom.components.length} components from lib/`);
stripInstallState(join(top, "lib"));

console.log("== API docs");
run(root, "pnpm", ["--filter", "@brokkr/sdk", "docs:api"], { stdio: "ignore" });
cpSync(join(root, "docs", "api"), join(top, "docs", "api"), { recursive: true });

writeFileSync(
  join(top, "bin/brokkr"),
  `#!/bin/sh
# Brokkr ${version} launcher. Requires Node.js >= 25 on PATH.
set -e
SELF="$0"
while [ -h "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in /*) SELF="$LINK" ;; *) SELF="$(dirname "$SELF")/$LINK" ;; esac
done
HERE=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
exec node "$HERE/../lib/node_modules/@brokkr/cli/dist/bin.js" "$@"
`,
);
chmodSync(join(top, "bin/brokkr"), 0o755);
for (const f of ["LICENSE", "README.md", "CHANGELOG.md", "SECURITY.md"])
  cpSync(join(root, f), join(top, f));
cpSync(join(root, "scripts/install-local.sh"), join(top, "install-local.sh"));
writeFileSync(join(top, "VERSION"), `${version}\n`);

console.log(`== archive (reproducible, mtime ${epochIso})`);
const entries = [];
const collect = (dir, rel) => {
  for (const e of readdirSync(dir).sort()) {
    const abs = join(dir, e);
    const r = rel ? `${rel}/${e}` : e;
    entries.push(r);
    lutimesSync(abs, epoch, epoch);
    if (lstatSync(abs).isDirectory()) collect(abs, r);
  }
};
entries.push(name);
collect(top, name);
lutimesSync(top, epoch, epoch);
const list = join(stage, "files.txt");
writeFileSync(list, `${entries.join("\n")}\n`);
const tarPath = join(stage, `${name}.tar`);
run(stage, "tar", [
  "-cf",
  tarPath,
  "-n",
  "--uid",
  "0",
  "--gid",
  "0",
  "--uname",
  "",
  "--gname",
  "",
  "--no-xattrs",
  "--no-acls",
  "--no-fflags",
  "--no-mac-metadata",
  "--format",
  "ustar",
  "-T",
  list,
]);
const archive = join(dist, `${name}.tar.gz`);
writeFileSync(archive, execFileSync("gzip", ["-n", "-9", "-c", tarPath], { maxBuffer: 1 << 30 }));
const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${sha}  ${name}.tar.gz\n`);
cpSync(join(top, "sbom.cdx.json"), join(dist, `${name}.sbom.cdx.json`));
rmSync(stage, { recursive: true, force: true });
console.log(`${archive}\nsha256 ${sha}`);

console.log("== smoke test (extract to a temp dir)");
const tmp = mkdtempSync(join(tmpdir(), "brokkr-release-"));
run(tmp, "tar", ["-xzf", archive]);
const bin = join(tmp, name, "bin/brokkr");
const work = mkdtempSync(join(tmpdir(), "brokkr-release-work-"));
const env = { ...process.env, BROKKR_HOME: mkdtempSync(join(tmpdir(), "brokkr-release-home-")) };
delete env.BROKKR_BUILTIN_HARNESSES;
const doctor = run(work, bin, ["doctor"], { env });
console.log(`$ brokkr doctor\n${doctor}`);
const listJson = JSON.parse(run(work, bin, ["harness", "list", "--json"], { env }));
const harnesses = (listJson.harnesses ?? listJson).map((h) => `${h.name}@${h.version}`);
console.log(
  `$ brokkr harness list --json -> ${harnesses.length} harnesses: ${harnesses.join(", ")}`,
);
if (harnesses.length < 8) throw new Error("release smoke test: built-in harness library missing");
console.log("release smoke test passed");
