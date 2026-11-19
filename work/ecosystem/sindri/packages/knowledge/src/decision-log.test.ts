import { describe, expect, it } from "vitest";
import { openKnowledge } from "./knowledge.js";
import { openDatabase } from "./db.js";
import {
  decideProjectDecision,
  projectDecisionLog,
  projectDecisionLogSnapshot,
  proposeProjectDecision,
} from "./decision-log.js";

describe("project design decisions", () => {
  it("retains historical ADRs and the dated, stable transition from one accepted rule to its replacement", () => {
    const k = openKnowledge(":memory:", { now: () => new Date("2025-01-01") });
    try {
      const p = k.projects.create({ name: "Project", repoPath: "/project" }).id;
      const other = k.projects.create({ name: "Other", repoPath: "/other" }).id;
      const legacy = k.decisions.record({
        projectId: p,
        title: "First",
        adrMarkdown:
          "## Context\n\nRuns locally.\n\n## Decision\n\nUse files.\n\n## Sources\n\nprivate-evidence",
        status: "accepted",
        approver: "private-name",
      });
      const initial = projectDecisionLogSnapshot(k.db, p);
      const body = {
        title: "Replace files",
        decision: "Use SQLite!",
        rationale: "Concurrent edits",
        source: "private-ticket",
        supersedesId: legacy.id,
      };
      expect(() => proposeProjectDecision(k.db, other, body, "Director")).toThrow(/not found/);
      const first = proposeProjectDecision(k.db, p, body, "Director", "2025-02-01T00:00:00Z");
      const stale = proposeProjectDecision(
        k.db,
        p,
        { ...body, title: "Alternative" },
        "Director",
        "2025-02-02T00:00:00Z",
      );
      expect(projectDecisionLogSnapshot(k.db, p)).toEqual(initial);
      decideProjectDecision(k.db, p, first, "accepted", "private-name", "2025-02-03T00:00:00Z");
      expect(() => decideProjectDecision(k.db, p, stale, "accepted", "private-name")).toThrow(
        /current accepted/,
      );
      decideProjectDecision(k.db, p, stale, "rejected", "private-name");
      const snapshot = projectDecisionLogSnapshot(k.db, p);
      expect(snapshot.map((x) => x.id)).toEqual([
        legacy.id + ":accepted",
        legacy.id + ":superseded",
        first + ":accepted",
      ]);
      expect(snapshot[0]).toEqual(initial[0]);
      expect(snapshot[1]?.markdown).toContain("Replaced by: Replace files");
      expect(snapshot[1]?.markdown).toContain("Concurrent edits");
      expect(snapshot[2]?.markdown).toContain("Replaces: First");
      const privateHistory = projectDecisionLog(k.db, p).markdown;
      expect(privateHistory.indexOf("2025-01-01 · accepted")).toBeLessThan(
        privateHistory.indexOf("2025-02-01 · proposed"),
      );
      expect(privateHistory.indexOf("2025-02-02 · proposed")).toBeLessThan(
        privateHistory.indexOf("2025-02-03 · superseded"),
      );
      expect(JSON.stringify(snapshot)).not.toMatch(/private-|Alternative/);
      expect(projectDecisionLog(k.db, p).entries.map((e) => e.status)).toEqual([
        "superseded",
        "accepted",
        "rejected",
      ]);
      expect(projectDecisionLog(k.db, other).entries).toEqual([]);
      k.projects.purge(p);
      expect(k.db.prepare("SELECT COUNT(*) AS n FROM decision_transitions").get()).toEqual({
        n: 0,
      });
    } finally {
      k.close();
    }
  });
  it("keeps private sources, local paths, actor names and credential values out of a project patch", () => {
    const k = openKnowledge(":memory:");
    try {
      const p = k.projects.create({ name: "test", repoPath: "/test" }).id;
      const add = (title: string, decision: string) => {
        const id = proposeProjectDecision(
          k.db,
          p,
          { title, decision, rationale: "Reduce copies", source: "artifact:private-record" },
          "private-name",
        );
        decideProjectDecision(k.db, p, id, "accepted", "private-approver");
      };
      add("Local fixture", "Use /Users/alice/demo");
      add("Citation", "See lesson:example");
      add("Public choice", "Use a single file");
      const before = projectDecisionLog(k.db, p).entries;
      const blocked = before.find((e) => e.title === "Local fixture")!;
      expect(blocked.exportBlockedReason).toMatch(/statement/);
      expect(before.find((e) => e.title === "Public choice")?.exportBlockedReason).toBeNull();
      const replacement = proposeProjectDecision(
        k.db,
        p,
        {
          title: "Use a repository fixture",
          decision: "Load test data from fixtures/",
          rationale: "Portable across machines",
          source: "artifact:private-record",
          supersedesId: blocked.id,
        },
        "Director",
      );
      decideProjectDecision(k.db, p, replacement, "accepted", "private-approver");
      expect(projectDecisionLogSnapshot(k.db, p)).toHaveLength(2);
      expect(projectDecisionLogSnapshot(k.db, p).map((e) => e.id)).toContain(
        replacement + ":accepted",
      );
      expect(JSON.stringify(projectDecisionLogSnapshot(k.db, p))).not.toMatch(
        /alice|lesson:|private-/,
      );
      const token = "ghp_" + "A".repeat(35);
      add("Redaction", "Use " + token + " locally");
      expect(JSON.stringify(projectDecisionLog(k.db, p))).not.toContain(token);
      expect(JSON.stringify(projectDecisionLogSnapshot(k.db, p))).not.toContain(token);
      const old = k.decisions.record({
        projectId: p,
        title: "Previous proposal",
        adrMarkdown: "Old format",
        status: "proposed",
      });
      decideProjectDecision(k.db, p, old.id, "accepted", "operator");
      expect(
        projectDecisionLog(k.db, p)
          .entries.find((e) => e.id === old.id)
          ?.history.map((h) => h.status),
      ).toEqual(["proposed", "accepted"]);
    } finally {
      k.close();
    }
  });

  it("keeps contact details and per-user temporary paths in the private journal", () => {
    const k = openKnowledge(":memory:");
    try {
      const project = k.projects.create({ name: "Project", repoPath: "/project" }).id;
      const mailbox = "operator+review@example.invalid";
      const path = "/var/folders/xx/example/T/report";
      const proposal = {
        title: "Package version",
        decision: "Pin formatter@1.2.3",
        rationale: "Keep formatting consistent",
        source: `See ${path} or email ${mailbox}`,
      };
      const accept = (input: typeof proposal) => {
        const id = proposeProjectDecision(k.db, project, input, mailbox);
        decideProjectDecision(k.db, project, id, "accepted", mailbox);
        return id;
      };
      const publicId = accept(proposal);
      const personalTitle = accept({ ...proposal, title: `Ask ${mailbox} for review` });
      const personalStatement = accept({ ...proposal, decision: `Read ${path} before review` });
      const personalReason = accept({
        ...proposal,
        rationale: `The owner (<${mailbox}>) requested it.`,
      });
      const canonicalPath = accept({ ...proposal, decision: `Read /private${path}` });
      const { entries, markdown } = projectDecisionLog(k.db, project);
      expect(entries.find((e) => e.id === publicId)).toMatchObject({
        actor: mailbox,
        decidedBy: mailbox,
        source: proposal.source,
        exportBlockedReason: null,
      });
      expect(markdown.replaceAll("\\", "")).toContain(mailbox);
      expect(markdown).toContain(path);
      for (const [id, field] of [
        [personalTitle, "title"],
        [personalStatement, "statement"],
        [personalReason, "rationale"],
        [canonicalPath, "statement"],
      ] as const) {
        expect(entries.find((e) => e.id === id)?.exportBlockedReason).toContain(field);
      }
      const published = projectDecisionLogSnapshot(k.db, project);
      expect(published.map((e) => e.id)).toEqual([publicId + ":accepted"]);
      const publicText = published[0]!.markdown.replaceAll("\\", "");
      expect(publicText).toContain("formatter@1.2.3");
      expect(publicText).not.toContain(mailbox);
      expect(publicText).not.toContain(path);
    } finally {
      k.close();
    }
  });

  it("works with delivery-only databases", () => {
    const db = openDatabase(":memory:");
    try {
      expect(projectDecisionLogSnapshot(db, "test")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
