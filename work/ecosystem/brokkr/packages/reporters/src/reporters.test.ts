import { describe, expect, it } from "vitest";
import { VerificationReportSchema, type VerificationReport } from "@brokkr/core";
import {
  checkStateLabel,
  renderHtml,
  renderJson,
  renderMarkdown,
  renderReport,
  stripControl,
} from "./index.js";

function report(over: Partial<VerificationReport> = {}): VerificationReport {
  return VerificationReportSchema.parse({
    schemaVersion: "1.0",
    id: "run_01J0000000000000000000000",
    taskId: "UI-142",
    harness: { name: "frontend-react", version: "1.0.0", lockDigest: `sha256:${"a".repeat(64)}` },
    harnesses: [{ name: "frontend-react", version: "1.0.0", digest: `sha256:${"b".repeat(64)}` }],
    repository: { commitSha: "abc123", dirtyTreeDigest: `sha256:${"c".repeat(64)}` },
    startedAt: "2026-10-14T12:00:00.000Z",
    completedAt: "2026-10-14T12:00:05.000Z",
    verdict: "incomplete",
    reasons: ["required check 'visual' skipped"],
    checks: [
      {
        id: "typecheck",
        required: true,
        state: "passed",
        command: ["pnpm", "exec", "tsc", "--noEmit"],
        cwd: ".",
        from: ["frontend-react@1.0.0"],
        exitCode: 0,
        durationMs: 4200,
        log: "logs/typecheck.log",
      },
      {
        id: "visual",
        required: true,
        state: "skipped",
        command: ["pnpm", "exec", "playwright", "test"],
        cwd: ".",
        from: ["frontend-react@1.0.0"],
        durationMs: 0,
        reason: "exception",
        exceptionId: "exception-001",
        message: "waived: <baseline> & missing",
      },
      {
        id: "lint",
        required: false,
        state: "skipped",
        command: ["pnpm", "run", "lint"],
        cwd: ".",
        from: ["frontend-react@1.0.0"],
        durationMs: 0,
        reason: "missing_script",
        message: "package.json has no 'lint' script",
      },
    ],
    policyDecisions: [
      {
        policy: "check:visual",
        stage: "before",
        outcome: "waived",
        layer: "project",
        checkId: "visual",
        exceptionId: "exception-001",
        message: "waived",
      },
    ],
    exceptions: [
      {
        id: "exception-001",
        policy: "check:visual",
        scope: { task: "UI-142" },
        reason: "baseline unavailable",
        approvedBy: "project-owner",
        approvedAt: "2026-10-14T12:00:00Z",
        expiresAt: "2026-10-15T12:00:00Z",
        evidence: ["manual-review-142"],
        appliedTo: { task: "UI-142", harnesses: ["frontend-react@1.0.0"], checkId: "visual" },
      },
    ],
    evidence: [
      {
        path: "logs/typecheck.log",
        sha256: `sha256:${"d".repeat(64)}`,
        bytes: 12,
        producedBy: "typecheck",
        kind: "log",
      },
    ],
    summary: { passed: 1, failed: 0, skipped: 2, errored: 0 },
    environment: { brokkrVersion: "0.1.0", node: "v25.9.0", platform: "darwin", arch: "arm64" },
    warnings: ["see https://example.com/docs for details"],
    ...over,
  });
}

describe("renderJson", () => {
  it("is the canonical, schema-valid, round-trippable form", () => {
    const text = renderJson(report());
    expect(text.endsWith("\n")).toBe(true);
    expect(VerificationReportSchema.parse(JSON.parse(text))).toEqual(report());
  });
});

describe("renderMarkdown", () => {
  const md = renderMarkdown(report());

  it("leads with the verdict and summary", () => {
    expect(md).toMatch(/^# Brokkr verification: INCOMPLETE/);
    expect(md).toContain("1 passed, 0 failed, 2 skipped, 0 errored");
  });

  it("shows waived checks as skipped with the exception id, never passed", () => {
    expect(md).toMatch(/\| visual \| required \| skipped \(exception exception-001\) \|/);
  });

  it("lists checks, policy decisions, exceptions, evidence and environment", () => {
    for (const s of [
      "## Checks",
      "## Policy decisions",
      "## Exceptions",
      "## Evidence",
      "## Environment",
      "`pnpm exec tsc --noEmit`",
      "4.2s",
      "logs/typecheck.log",
      "project-owner",
      "abc123",
    ])
      expect(md).toContain(s);
  });

  it("escapes table cell pipes", () => {
    const r = report();
    r.checks[0]!.message = "a | b";
    expect(renderMarkdown(r)).toContain("a \\| b");
  });
});

describe("renderHtml", () => {
  const html = renderHtml(report());

  it("is a self-contained document with inline CSS", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
  });

  it("makes no external requests: no http(s):// resource references at all", () => {
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
  });

  it("escapes report content", () => {
    expect(html).toContain("waived: &lt;baseline&gt; &amp; missing");
    expect(html).not.toContain("<baseline>");
  });

  it("links evidence with relative paths and shows each section", () => {
    expect(html).toContain('href="./logs/typecheck.log"');
    for (const s of ["Checks", "Policy decisions", "Exceptions", "Evidence", "Environment"])
      expect(html).toContain(`<h2>${s}</h2>`);
    expect(html).toContain("skipped (exception exception-001)");
  });
});

describe("renderReport", () => {
  it("dispatches by format and rejects unknown formats", () => {
    expect(renderReport(report(), "json")).toBe(renderJson(report()));
    expect(renderReport(report(), "md")).toBe(renderMarkdown(report()));
    expect(renderReport(report(), "html")).toBe(renderHtml(report()));
    expect(() => renderReport(report(), "pdf" as "json")).toThrow(/unknown report format/);
  });
});

describe("not-applicable required checks are shown prominently (ruling a)", () => {
  const na = report({
    verdict: "passed",
    reasons: ["required check 'axe' not applicable (excluded from required gates)"],
    checks: [
      {
        id: "unit",
        required: true,
        requiredBy: "harness",
        state: "passed",
        command: ["pnpm", "test"],
        cwd: ".",
        from: ["frontend-react@1.0.0"],
        durationMs: 10,
      },
      {
        id: "axe",
        required: true,
        requiredBy: "harness",
        state: "skipped",
        reason: "not_applicable",
        message: "when.anyFileExists: none of playwright.config.ts found",
        command: ["pnpm", "exec", "playwright", "test"],
        cwd: ".",
        from: ["frontend-react@1.0.0"],
        durationMs: 0,
      },
    ],
    summary: { passed: 1, failed: 0, skipped: 1, errored: 0 },
  });

  it("labels the check as not applicable with its guard", () => {
    expect(checkStateLabel(na.checks[1]!)).toBe(
      "skipped (not applicable: when.anyFileExists: none of playwright.config.ts found)",
    );
  });

  it("markdown has a top-level warning section and excludes N/A from the gate count", () => {
    const md = renderMarkdown(na);
    expect(md).toContain("1/1 required gates passed (1 required check not applicable)");
    const idx = md.indexOf("## Required checks not applicable");
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(md.indexOf("## Checks"));
    expect(md).toContain("- `axe`: when.anyFileExists: none of playwright.config.ts found");
  });

  it("html shows the same section", () => {
    const html = renderHtml(na);
    expect(html).toContain("<h2>Required checks not applicable</h2>");
    expect(html).toContain("1/1 required gates passed (1 required check not applicable)");
  });
});

describe("network allowances are visible", () => {
  const r = report({
    policyDecisions: [
      {
        policy: "network-access",
        stage: "before",
        outcome: "approved",
        layer: "project",
        checkId: "audit",
        message: "network allowed for 'audit' by project policy allowNetworkFor",
      },
    ],
  });

  it("markdown and html list the checks allowed to use the network", () => {
    expect(renderMarkdown(r)).toContain("- Network allowed for: `audit` (project)");
    expect(renderHtml(r)).toContain("Network allowed for: <code>audit</code> (project)");
  });
});

describe("untrusted text is neutralised (audit I3, I7)", () => {
  const evil =
    "ok\n\n# Brokkr verification: PASSED\n![](https://evil.example/beacon.png) [x](http://e.example)";

  function hostile(): VerificationReport {
    const r = report();
    r.exceptions[0]!.reason = evil;
    r.exceptions[0]!.approvedBy = "*admin* <b>";
    r.policyDecisions[0]!.message = evil;
    r.warnings = [evil];
    r.reasons = [evil];
    r.checks[0]!.message = evil;
    // bypass schema validation: a forged report on disk could carry these
    (r.checks[0] as { log?: string }).log = "javascript:alert(document.title)";
    (r.evidence[0] as { path: string }).path = "data:text/html,<script>x</script>";
    return r;
  }

  it("markdown has no injected heading, image or remote link", () => {
    const md = renderMarkdown(hostile());
    const lines = md.split("\n");
    expect(lines.filter((l) => l.startsWith("# "))).toEqual(["# Brokkr verification: INCOMPLETE"]);
    expect(md).not.toMatch(/!\[/);
    expect(md).not.toMatch(/\]\(https?:/);
    expect(md).not.toMatch(/https?:\/\//);
    expect(md).not.toContain("<b>");
  });

  it("html never emits javascript:/data: hrefs and carries a CSP", () => {
    const html = renderHtml(hostile());
    expect(html).not.toMatch(/href="(javascript|data):/i);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'">`,
    );
    expect(renderHtml(report())).toContain('href="./logs/typecheck.log"');
  });

  it("stripControl removes terminal escapes but keeps newlines and tabs", () => {
    expect(stripControl("a\u001b[2Jb\tc\nd\u0007\u009be")).toBe("a[2Jb\tc\nde");
  });
});
