// End-to-end test of the local release: bundle the built CLI into
// dist/sindri-<version>-<os>-<arch>.tar.gz, extract it, install it with scripts/install-local.sh
// into temp dirs, and run `sindri doctor` from the installed shim. Needs `pnpm build` first.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

describe("pnpm release:local", () => {
  it("builds a self-contained tarball that installs and runs sindri doctor", () => {
    const out = tmp("sindri-release-");
    const r = spawnSync(
      "node",
      [
        join(root, "scripts/release-local.mjs"),
        "--skip-build",
        "--packages-dir",
        join(out, "packages"),
        "--out-dir",
        out,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const version = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")).version;
    const os = process.platform === "darwin" ? "macos" : process.platform;
    const name = `sindri-${version}-${os}-${process.arch}`;
    const tarball = join(out, `${name}.tar.gz`);
    expect(existsSync(tarball)).toBe(true);
    expect(r.stdout).toContain(tarball);

    // The tarball has a single top-level directory with the shim, the CLI and the web build.
    const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
    expect(list.every((l) => l === "" || l.startsWith(`${name}/`))).toBe(true);
    for (const f of ["bin/sindri", "lib/cli/dist/main.js", "lib/web/dist/index.html", "LICENSE"])
      expect(list).toContain(`${name}/${f}`);
    expect(list.some((l) => l.includes("/src/") && l.includes("@sindri"))).toBe(false);

    const home = tmp("sindri-install-home-");
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      SINDRI_SECRET_STORE: "env",
      SINDRI_INSTALL_ROOT: join(home, "share"),
      SINDRI_BIN_DIR: join(home, "bin"),
    };
    const install = spawnSync("sh", [join(root, "scripts/install-local.sh"), tarball], {
      env,
      encoding: "utf8",
    });
    expect(install.status, install.stderr + install.stdout).toBe(0);
    const shim = join(home, "bin", "sindri");
    expect(lstatSync(shim).isFile() || lstatSync(shim).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, "share", name, "lib/cli/dist/main.js"))).toBe(true);

    // Runs from the installed copy, with no access to the workspace's node_modules.
    const doctor = spawnSync(shim, ["doctor", "--json"], { cwd: home, env, encoding: "utf8" });
    expect(doctor.stderr).toBe("");
    const report = JSON.parse(doctor.stdout);
    const status = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    expect(status).toMatchObject({ node: "ok", git: "ok", "data-dir": "ok", config: "ok" });
    expect(doctor.status).toBe(0);

    // Re-installing the same version replaces it in place.
    const again = spawnSync("sh", [join(root, "scripts/install-local.sh"), tarball], {
      env,
      encoding: "utf8",
    });
    expect(again.status, again.stderr).toBe(0);
  }, 600_000);
});
