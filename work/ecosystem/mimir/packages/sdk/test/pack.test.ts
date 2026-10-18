import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const sdkDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const protocolDir = join(sdkDir, "..", "protocol");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

describe("@mimir/sdk package", () => {
  it("declares ESM + types exports with a browser condition", () => {
    const pkg = readJson(join(sdkDir, "package.json"));
    expect(pkg["type"]).toBe("module");
    expect(pkg["exports"]).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        browser: "./dist/index.js",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
    });
    expect(pkg["files"]).toEqual(["dist", "contracts"]);
    expect((pkg["scripts"] as Record<string, string>)["pack:local"]).toBeDefined();
  });

  it("builds against DOM libs without Node types, and src has no Node-only imports", () => {
    const build = readJson(join(sdkDir, "tsconfig.build.json")) as {
      compilerOptions: { lib?: string[]; types?: string[] };
    };
    expect(build.compilerOptions.types).toEqual([]);
    expect(build.compilerOptions.lib).toContain("DOM");
    const files = readdirSync(join(sdkDir, "src")).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    for (const f of files) {
      const text = readFileSync(join(sdkDir, "src", f), "utf8");
      expect(text, f).not.toMatch(/from "node:|require\(|\bprocess\.|\bBuffer\b/);
    }
  });
});

describe("pnpm pack tarball", () => {
  let out: string;
  let tarball: string;

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "mimir-sdk-pack-"));
    execFileSync("pnpm", ["run", "build"], { cwd: sdkDir, stdio: "pipe" });
    execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: sdkDir, stdio: "pipe" });
    const found = readdirSync(out).find((f) => f.endsWith(".tgz"));
    if (!found) throw new Error("no tarball produced");
    tarball = join(out, found);
  }, 60_000);

  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it("is named mimir-sdk-<version>.tgz", () => {
    const version = readJson(join(sdkDir, "package.json"))["version"];
    expect(tarball.endsWith(`mimir-sdk-${String(version)}.tgz`)).toBe(true);
  });

  it("has exports and no workspace: ranges, pinning @mimir/protocol to its real version", () => {
    const pkg = JSON.parse(
      execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
    ) as Record<string, unknown>;
    expect(pkg["exports"]).toBeDefined();
    expect(JSON.stringify(pkg)).not.toContain("workspace:");
    const protocolVersion = readJson(join(protocolDir, "package.json"))["version"];
    expect((pkg["dependencies"] as Record<string, string>)["@mimir/protocol"]).toBe(
      protocolVersion,
    );
  });

  it("ships the contracts/ fixtures: index.json, errors.json and one file per operation", () => {
    const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
    const shipped = files.filter((f) => f.startsWith("package/contracts/"));
    const committed = readdirSync(join(sdkDir, "contracts")).map((f) => `package/contracts/${f}`);
    expect(shipped.sort()).toEqual(committed.sort());
    expect(shipped).toContain("package/contracts/index.json");
    expect(shipped).toContain("package/contracts/errors.json");
    expect(shipped).toContain("package/contracts/post-v1-tasks-id-pr.json");
    const index = JSON.parse(
      execFileSync("tar", ["-xzOf", tarball, "package/contracts/index.json"], { encoding: "utf8" }),
    ) as { operations: { file: string }[] };
    for (const o of index.operations) expect(shipped).toContain(`package/contracts/${o.file}`);
  });

  it("contains the built ESM and declarations and no tests", () => {
    const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
    expect(files).toContain("package/dist/index.js");
    expect(files).toContain("package/dist/index.d.ts");
    expect(files.filter((f) => /\.test\.|\/test\//.test(f))).toEqual([]);
  });
});

describe("protocol tarball shipped alongside by pack:local", () => {
  let out: string;
  let tarball: string;

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "mimir-protocol-pack-"));
    execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: protocolDir, stdio: "pipe" });
    const found = readdirSync(out).find((f) => f.endsWith(".tgz"));
    if (!found) throw new Error("no tarball produced");
    tarball = join(out, found);
  }, 60_000);

  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it("has exports, no workspace: ranges, the built ESM and the OpenAPI document", () => {
    const pkg = JSON.parse(
      execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
    ) as Record<string, unknown>;
    expect(pkg["exports"]).toBeDefined();
    expect(JSON.stringify(pkg)).not.toContain("workspace:");
    const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
    expect(files).toContain("package/dist/index.js");
    expect(files).toContain("package/dist/index.d.ts");
    expect(files).toContain("package/openapi.json");
  });
});
