// Fixture tests for scripts/licenses.mjs and scripts/sbom.mjs: each builds a throwaway pnpm workspace
// from local `file:` packages (no network), installs it, and runs the real scripts against it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { classify } from "./licenses.mjs";
import { purl } from "./sbom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

// vendored: { name: license }; prod / dev: names of vendored packages each workspace package depends on.
function fixture({ vendored, prod = [], dev = [] }) {
  const root = mkdtempSync(join(tmpdir(), "supply-chain-"));
  dirs.push(root);
  writeJson(join(root, "package.json"), { name: "fx", private: true, version: "0.0.0" });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const ref = (n) => `file:../../vendor/${n}`;
  for (const [name, license] of Object.entries(vendored)) {
    writeJson(join(root, "vendor", name, "package.json"), {
      name,
      version: "1.0.0",
      ...(license ? { license } : {}),
    });
  }
  writeJson(join(root, "packages/a/package.json"), {
    name: "@fx/a",
    version: "1.0.0",
    dependencies: Object.fromEntries(prod.map((n) => [n, ref(n)])),
    devDependencies: { "@fx/b": "workspace:*", ...Object.fromEntries(dev.map((n) => [n, ref(n)])) },
  });
  writeJson(join(root, "packages/b/package.json"), { name: "@fx/b", version: "2.0.0" });
  execFileSync("pnpm", ["install"], { cwd: root, stdio: "ignore" });
  return root;
}

const run = (script, root, extra = []) =>
  spawnSync("node", [join(here, script), "--root", root, ...extra], { encoding: "utf8" });

describe("classify", () => {
  it("allows the permissive set", () => {
    for (const l of [
      "MIT",
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "ISC",
      "0BSD",
      "Unlicense",
      "CC0-1.0",
      "BlueOak-1.0.0",
      "Python-2.0",
      "Zlib",
    ]) {
      expect(classify(l)).toBe("allowed");
    }
  });
  it("treats MPL-2.0 as dev-only and everything else as a violation", () => {
    expect(classify("MPL-2.0")).toBe("dev-only");
    for (const l of [
      "GPL-3.0-only",
      "AGPL-3.0",
      "Unknown",
      "UNLICENSED",
      "",
      undefined,
      "SEE LICENSE IN x",
    ]) {
      expect(classify(l)).toBe("violation");
    }
  });
  it("evaluates SPDX expressions", () => {
    expect(classify("(MIT OR GPL-3.0-only)")).toBe("allowed");
    expect(classify("MIT AND GPL-3.0-only")).toBe("violation");
    expect(classify("(MPL-2.0 OR MIT)")).toBe("allowed");
  });
});

describe("licenses:check", () => {
  it("passes, records dev-only MPL-2.0, and writes docs/licenses.md", () => {
    const root = fixture({
      vendored: { "lib-mit": "MIT", "lib-mpl": "MPL-2.0" },
      prod: ["lib-mit"],
      dev: ["lib-mpl"],
    });
    const r = run("licenses.mjs", root);
    expect(r.status, r.stderr).toBe(0);
    const doc = readFileSync(join(root, "docs/licenses.md"), "utf8");
    expect(doc).toMatch(/Development-only MPL-2\.0/);
    expect(doc).toMatch(/\| lib-mpl \|/);
    expect(doc).toMatch(/\| MIT \| 1 \| allowed \|/);
  });

  it("keeps hand-written docs text and replaces only the generated block", () => {
    const root = fixture({ vendored: { "lib-mit": "MIT" }, prod: ["lib-mit"] });
    writeFileSync(join(root, "docs-note.md"), "# Mine\n\nhand written\n");
    expect(run("licenses.mjs", root, ["--docs", join(root, "docs-note.md")]).status).toBe(0);
    expect(run("licenses.mjs", root, ["--docs", join(root, "docs-note.md")]).status).toBe(0);
    const doc = readFileSync(join(root, "docs-note.md"), "utf8");
    expect(doc.startsWith("# Mine\n\nhand written")).toBe(true);
    expect(doc.match(/licenses:generated:start/g)).toHaveLength(1);
  });

  it("fails on MPL-2.0 in a production dependency", () => {
    const root = fixture({ vendored: { "lib-mpl": "MPL-2.0" }, prod: ["lib-mpl"] });
    const r = run("licenses.mjs", root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/lib-mpl@.*MPL-2\.0/);
  });

  it("fails on a disallowed license and lists the package", () => {
    const root = fixture({
      vendored: { "lib-gpl": "GPL-3.0-only", "lib-mit": "MIT" },
      dev: ["lib-gpl", "lib-mit"],
    });
    const r = run("licenses.mjs", root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/lib-gpl@.*GPL-3\.0-only/);
    expect(r.stderr).not.toMatch(/lib-mit/);
  });

  it("fails on a package with no license", () => {
    const root = fixture({ vendored: { "lib-none": undefined }, prod: ["lib-none"] });
    const r = run("licenses.mjs", root, ["--no-write"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/lib-none@/);
  });
});

describe("sbom", () => {
  it("emits CycloneDX 1.5 with every workspace package, purls, licenses, and edges", () => {
    const root = fixture({ vendored: { "lib-mit": "MIT" }, prod: ["lib-mit"] });
    const out = join(root, "dist", "sbom.cdx.json");
    const r = run("sbom.mjs", root);
    expect(r.status, r.stderr).toBe(0);
    const sbom = JSON.parse(readFileSync(out, "utf8"));
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.5");
    expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(sbom.version).toBe(1);
    expect(sbom.metadata.component.name).toBe("fx");
    const names = sbom.components.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["@fx/a", "@fx/b", "lib-mit"]));
    for (const c of sbom.components) {
      expect(c.purl).toMatch(/^pkg:npm\//);
      expect(c["bom-ref"]).toBe(c.purl);
    }
    const mit = sbom.components.find((c) => c.name === "lib-mit");
    expect(mit.licenses).toEqual([{ license: { id: "MIT" } }]);
    const a = sbom.dependencies.find((d) => d.ref === purl("@fx/a", "1.0.0"));
    expect(a.dependsOn).toContain(purl("@fx/b", "2.0.0"));
    const refs = new Set(
      sbom.components.map((c) => c["bom-ref"]).concat(sbom.metadata.component["bom-ref"]),
    );
    for (const d of sbom.dependencies) for (const t of d.dependsOn) expect(refs.has(t)).toBe(true);
  });

  it("purl encodes scoped names", () => {
    expect(purl("@scope/name", "1.2.3")).toBe("pkg:npm/%40scope/name@1.2.3");
    expect(purl("plain", "1.0.0")).toBe("pkg:npm/plain@1.0.0");
  });
});
