// Runs the real release script into a temp dir and checks the artifact layout.
// Run with `pnpm test:release` (slow: it deploys the CLI and server).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const work = mkdtempSync(join(tmpdir(), "mimir-release-test-"));
const dist = join(work, "dist");
const packages = join(work, "dist-packages");
const tarball = join(dist, `mimir-${version}-macos-arm64.tar.gz`);
const extract = join(work, "extract");
const home = join(work, "home");

const cleanEnv = { ...process.env, HOME: home, MIMIR_DATA_DIR: join(home, ".mimir") };

beforeAll(() => {
  execFileSync("mkdir", ["-p", extract, home]);
  execFileSync(
    "node",
    [
      join(root, "scripts/release-local.mjs"),
      "--out-dir",
      dist,
      "--packages-dir",
      packages,
      // The coverage gate runs the whole test suite; this test checks packaging only.
      "--skip-coverage",
    ],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync("tar", ["-xzf", tarball, "-C", extract]);
}, 280_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

const top = () => join(extract, `mimir-${version}-macos-arm64`);

describe("release:local", () => {
  it("packs the protocol and sdk tarballs", () => {
    // The protocol and SDK are versioned on their own (0.2.0 since T12b), not with the app.
    const own = (pkg) =>
      JSON.parse(readFileSync(join(root, "packages", pkg, "package.json"), "utf8")).version;
    expect(existsSync(join(packages, `mimir-protocol-${own("protocol")}.tgz`))).toBe(true);
    expect(existsSync(join(packages, `mimir-sdk-${own("sdk")}.tgz`))).toBe(true);
  });

  it("produces a tarball with server, web and cli", () => {
    for (const p of [
      "bin/mimir",
      "app/cli/dist/main.js",
      "app/server/dist/main.js",
      "app/web/dist/index.html",
      "scripts/install-local.sh",
      "VERSION",
      "third_party/terminal-bridge/LICENSE",
      "third_party/terminal-bridge/README.md",
    ]) {
      expect(existsSync(join(top(), p)), p).toBe(true);
    }
    expect(statSync(join(top(), "bin/mimir")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(top(), "VERSION"), "utf8").trim()).toBe(version);
  });

  it("ships no sources, tests, or secrets", () => {
    const list = execFileSync("tar", ["-tzf", tarball], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const own = list.split("\n").filter((l) => !l.includes("/node_modules/"));
    expect(own.filter((l) => /\.test\./.test(l))).toEqual([]);
    expect(own.filter((l) => /\/src\/|auth-token|\.env/.test(l))).toEqual([]);
  });

  it("runs mimir doctor with plain node from the extracted tree", () => {
    const r = spawnSync(join(top(), "bin/mimir"), ["doctor", "--json"], {
      env: cleanEnv,
      encoding: "utf8",
    });
    const out = JSON.parse(r.stdout);
    expect(out.checks.find((c) => c.name === "node").status).toBe("ok");
    expect(out.checks.find((c) => c.name === "data-dir").status).toBe("ok");
  });

  it("installs with install-local.sh into overridden dirs and the shim runs", () => {
    const app = join(work, "app");
    const bin = join(work, "bin");
    const env = { ...cleanEnv, MIMIR_APP_DIR: app, MIMIR_BIN_DIR: bin };
    execFileSync("bash", [join(top(), "scripts/install-local.sh"), tarball], { env });
    const r = spawnSync(join(bin, "mimir"), ["doctor", "--json"], { env, encoding: "utf8" });
    expect(JSON.parse(r.stdout).checks.length).toBeGreaterThan(0);
    // a second install replaces the first without error
    execFileSync("bash", [join(top(), "scripts/install-local.sh"), tarball], { env });
  });
});
