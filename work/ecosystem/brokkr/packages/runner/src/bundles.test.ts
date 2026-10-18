import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGeneratedBundles } from "./bundles.js";
import { tmp as tempDir } from "../test/helpers.js";

function ws(): string {
  const dir = tempDir("brokkr-bundles-");
  mkdirSync(join(dir, ".brokkr", "generated", "sub"), { recursive: true });
  return dir;
}

describe("readGeneratedBundles (fix round 2, N2)", () => {
  it(
    "reads regular files and refuses links, FIFOs, devices and oversize files",
    { timeout: 10_000 },
    async () => {
      const dir = ws();
      const g = join(dir, ".brokkr", "generated");
      writeFileSync(join(g, "CLAUDE.md"), "ok\n");
      writeFileSync(join(g, "sub", "skill.md"), "ok2\n");
      writeFileSync(join(g, "big.md"), "x".repeat(64));
      symlinkSync("/dev/zero", join(g, "zero.md"));
      symlinkSync(tempDir("outside-"), join(g, "linkdir"));
      execFileSync("mkfifo", [join(g, "pipe")]);
      const r = await readGeneratedBundles(dir, { maxBytes: 32 });
      expect(r.files.map((f) => [f.file.slice(g.length + 1), f.text])).toEqual([
        ["CLAUDE.md", "ok\n"],
        ["sub/skill.md", "ok2\n"],
      ]);
      const w = r.warnings.join("\n");
      expect(w).toMatch(/big\.md: larger than 32 bytes/);
      expect(w).toMatch(/zero\.md: it is a symlink/);
      expect(w).toMatch(/linkdir: it is a symlink/);
      expect(w).toMatch(/pipe: it is not a regular file/);
    },
  );

  it("refuses hard links (fix round 3, I-a)", async () => {
    const dir = ws();
    const outside = join(tempDir("outside-"), "host-secret.env");
    writeFileSync(outside, "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n");
    linkSync(outside, join(dir, ".brokkr", "generated", "a.md"));
    const r = await readGeneratedBundles(dir);
    expect(r.files).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/a\.md: it is a hard link/);
  });

  it("caps every visited entry once across the whole walk and caps depth (m-a)", async () => {
    const dir = ws();
    const g = join(dir, ".brokkr", "generated");
    for (let i = 0; i < 3; i++) symlinkSync("/dev/zero", join(g, `l${i}.md`));
    for (let i = 0; i < 3; i++) writeFileSync(join(g, "sub", `${i}.md`), "x");
    const r = await readGeneratedBundles(dir, { maxFiles: 4 });
    const stops = r.warnings.filter((w) => /after 4 entries/.test(w));
    expect(stops).toHaveLength(1);
    expect(r.files.length + r.warnings.filter((w) => /symlink/.test(w)).length).toBeLessThanOrEqual(
      4,
    );
    let deep = join(g, "d");
    for (let i = 0; i < 40; i++) {
      mkdirSync(deep);
      deep = join(deep, "d");
    }
    const d = await readGeneratedBundles(dir, { maxDepth: 8 });
    expect(d.warnings.join("\n")).toMatch(/deeper than 8 levels/);
  });

  it("refuses a file larger than the cap by one byte", async () => {
    const dir = ws();
    writeFileSync(
      join(dir, ".brokkr", "generated", "big.md"),
      Buffer.alloc(8 * 1024 * 1024 + 1, 120),
    );
    const r = await readGeneratedBundles(dir);
    expect(r.files).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/big\.md: larger than 8388608 bytes/);
  });
});
