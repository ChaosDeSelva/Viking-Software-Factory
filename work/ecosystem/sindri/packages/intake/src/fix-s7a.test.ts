import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSindriError, openKnowledge } from "@sindri/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openIntake, type Intake } from "./intake.js";
import { sanitizeForDisplay } from "./sanitize.js";

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return isSindriError(e) ? e.code : `untyped:${String(e)}`;
  }
  return "no-throw";
};

describe("sanitizeForDisplay: bidi and zero-width controls", () => {
  it("removes bidi overrides/isolates, zero-width characters and BOM", () => {
    const evil =
      "abc\u202Eexe.txt\u202C \u2066x\u2069 zero\u200Bwidth\u200C\u200D\u200E\u200F\u2060\uFEFF\u061C!";
    expect(sanitizeForDisplay(evil)).toBe("abcexe.txt x zerowidth!");
  });
  it("still strips scripts", () => {
    expect(sanitizeForDisplay("hi<script>alert(1)</script>\u202E")).toBe("hi");
  });
});

describe("intake typed errors and attachment blobs", () => {
  let dir: string;
  let intake: Intake;
  let projectId: string;
  let other: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "intake-fix-"));
    const k = openKnowledge(":memory:");
    projectId = k.projects.create({ name: "p", repoPath: "/r" }).id;
    other = k.projects.create({ name: "o", repoPath: "/r" }).id;
    intake = openIntake(k.db, { attachmentsDir: join(dir, "att") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("throws coded errors", async () => {
    expect(await codeOf(() => intake.createManual({ projectId, title: " ", body: "" }))).toBe(
      "validation_failed",
    );
    expect(
      await codeOf(() => intake.createManual({ projectId: "nope", title: "t", body: "" })),
    ).toBe("not_found");
    expect(await codeOf(() => intake.annotate("nope", { author: "a", body: "b" }))).toBe(
      "not_found",
    );
    expect(await codeOf(() => intake.importFromUrl("https://x.dev/1", { projectId }))).toBe(
      "no_connector",
    );
  });

  it("lists a project's blob paths and deletes only unreferenced ones", () => {
    const shared = { name: "a.txt", content: "shared blob" };
    const own = { name: "b.txt", content: "own blob" };
    intake.createManual({ projectId, title: "t", body: "", attachments: [shared, own] });
    intake.createManual({ projectId: other, title: "t", body: "", attachments: [shared] });
    const paths = intake.attachmentPaths(projectId);
    expect(paths).toHaveLength(2);
    intake.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    expect(intake.deleteUnreferencedBlobs(paths)).toBe(1);
    const [a, b] = paths.sort();
    const still = [a, b].filter((p) => existsSync(p!));
    expect(still).toHaveLength(1);
    // Paths outside attachmentsDir are never touched.
    expect(intake.deleteUnreferencedBlobs([join(dir, "outside")])).toBe(0);
  });
});
