import { describe, expect, it } from "vitest";
import { VerificationReportSchema, type VerificationReport } from "@brokkr/core";
import {
  checkStateLabel,
  escapeHtml,
  formatDuration,
  mdText,
  networkAllowances,
  renderHtml,
  renderMarkdown,
} from "./index.js";

const check = {
  id: "unit",
  required: true,
  state: "passed" as const,
  command: ["pnpm", "test"],
  cwd: ".",
  from: ["h@1.0.0"],
  durationMs: 10,
};

/** A minimal report: no task, trust mode, tree digest, reasons, decisions, exceptions, evidence or warnings. */
function bare(over: Partial<VerificationReport> = {}): VerificationReport {
  return VerificationReportSchema.parse({
    schemaVersion: "1.0",
    id: "run_1",
    harness: { name: "h", version: "1.0.0", lockDigest: `sha256:${"a".repeat(64)}` },
    harnesses: [],
    repository: { commitSha: "abc" },
    startedAt: "2026-10-14T12:00:00.000Z",
    completedAt: "2026-10-14T12:00:05.000Z",
    verdict: "passed",
    reasons: [],
    checks: [check],
    policyDecisions: [],
    exceptions: [],
    evidence: [],
    summary: { passed: 1, failed: 0, skipped: 0, errored: 0 },
    environment: { brokkrVersion: "0.1.0", node: "v25", platform: "linux", arch: "x64" },
    warnings: [],
    ...over,
  });
}

describe("formatDuration", () => {
  it("formats milliseconds, seconds and minutes", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(125_000)).toBe("2m5s");
  });

  it("never prints a rounded-up unit boundary (1000ms, 60.0s, 1m60s)", () => {
    expect(formatDuration(999.7)).toBe("1.0s");
    expect(formatDuration(59_960)).toBe("1m0s");
    expect(formatDuration(119_600)).toBe("2m0s");
  });
});

describe("checkStateLabel", () => {
  it("labels not-applicable without a message and other skip reasons", () => {
    const skipped = { ...check, state: "skipped" as const };
    expect(checkStateLabel({ ...skipped, reason: "not_applicable" })).toBe(
      "skipped (not applicable)",
    );
    expect(checkStateLabel({ ...skipped, reason: "missing_script" })).toBe(
      "skipped (missing_script)",
    );
    expect(checkStateLabel(skipped)).toBe("skipped");
  });
});

describe("mdText never produces a link", () => {
  it("defangs GFM www. autolinks as well as http(s)://", () => {
    expect(mdText("see www.evil.example/login now")).toBe("see www\\[.\\]evil.example/login now");
    expect(mdText("WWW.Evil.example")).toBe("WWW\\[.\\]Evil.example");
    expect(mdText("aww.example")).toBe("aww.example");
  });

  it("in the rendered report too", () => {
    const md = renderMarkdown(bare({ warnings: ["visit www.evil.example"] }));
    expect(md).toContain("- visit www\\[.\\]evil.example");
    expect(md).not.toMatch(/www\.evil/);
  });
});

describe("renderers on a minimal report", () => {
  it("markdown omits optional lines and shows None. for empty sections", () => {
    const md = renderMarkdown(bare());
    expect(md).not.toContain("Trust mode");
    expect(md).not.toContain("- Task:");
    expect(md).not.toContain("(tree ");
    expect(md).not.toContain("## Verdict reasons");
    expect(md).not.toContain("## Policy sources");
    expect(md).not.toContain("## Warnings");
    expect(md).toContain("- Harness: none");
    expect(md).toContain("1/1 required gates passed");
    expect(md).toContain("## Policy decisions\n\nNone.");
    expect(md).toContain("## Exceptions\n\nNone.");
    expect(md).toContain("## Evidence\n\nNone.");
    expect(md).toContain("| unit | required | passed | 10ms | `pnpm test` |  |");
  });

  it("html omits optional rows and shows None. for empty lists", () => {
    const html = renderHtml(bare());
    expect(html).not.toContain("<th>Trust mode</th>");
    expect(html).not.toContain("<th>Task</th>");
    expect(html).toContain("<tr><th>Harnesses</th><td>none</td></tr>");
    expect(html).toContain("<tr><th>Tree digest</th><td><code>n/a</code></td></tr>");
    expect(html).not.toContain("<h2>Verdict reasons</h2>");
    expect(html).not.toContain("<h2>Warnings</h2>");
    expect(html).not.toContain("interrupted");
    expect(html).toContain('<h2>Evidence</h2>\n<p class="muted">None.</p>');
  });

  it("an empty policySources list adds no section", () => {
    expect(renderMarkdown(bare({ policySources: [] }))).not.toContain("## Policy sources");
    expect(renderHtml(bare({ policySources: [] }))).not.toContain("<h2>Policy sources</h2>");
  });
});

describe("renderers on a full report", () => {
  const full = bare({
    trustMode: "workspace-untrusted",
    interrupted: true,
    checks: [
      { ...check, required: false, exitCode: null },
      {
        ...check,
        id: "a11y",
        state: "skipped",
        reason: "not_applicable",
        requiredBy: "harness",
      },
      {
        ...check,
        id: "e2e",
        state: "skipped",
        reason: "not_applicable",
        message: "no playwright config",
        requiredBy: "harness",
      },
      {
        ...check,
        id: "visual",
        state: "skipped",
        reason: "not_applicable",
        message: "guard",
        requiredBy: "policy",
      },
    ],
    policyDecisions: [
      { policy: "network", stage: "before", outcome: "deny", layer: "system", message: "denied" },
      {
        policy: "network-access",
        stage: "before",
        outcome: "approved",
        layer: "project",
        checkId: "unit",
        exceptionId: "x-net",
        message: "approved",
      },
    ],
    exceptions: [
      {
        id: "x-net",
        policy: "network-access:unit",
        scope: {},
        reason: "needs registry",
        approvedBy: "owner",
        approvedAt: "2026-10-14T12:00:00Z",
        expiresAt: "2026-10-15T12:00:00Z",
        evidence: [],
        appliedTo: { harnesses: ["h@1.0.0"] },
        origin: "external",
      },
      {
        id: "x-ws",
        policy: "install-dependencies",
        scope: {},
        reason: "r",
        approvedBy: "owner",
        approvedAt: "2026-10-14T12:00:00Z",
        expiresAt: "2026-10-15T12:00:00Z",
        evidence: [],
        appliedTo: { harnesses: ["h@1.0.0"] },
        origin: "workspace_supplied",
      },
    ],
    policySources: [
      {
        kind: "exceptions",
        path: ".brokkr/exceptions.yaml",
        origin: "workspace_supplied",
        digest: `sha256:${"e".repeat(64)}`,
      },
      {
        kind: "organization-policy",
        path: "/etc/brokkr/org.yaml",
        origin: "external",
        digest: `sha256:${"f".repeat(64)}`,
      },
    ],
    evidence: [
      {
        path: "logs/a b.log",
        sha256: `sha256:${"d".repeat(64)}`,
        bytes: 1,
        producedBy: "unit",
        kind: "log",
      },
    ],
  });

  it("names the approving exception for a network allowance", () => {
    expect(networkAllowances(full)).toEqual([{ checkId: "unit", by: "exception x-net" }]);
  });

  it("markdown shows trust mode, interruption, plural not-applicable, origins and sources", () => {
    const md = renderMarkdown(full);
    expect(md).toContain("- Trust mode: `workspace-untrusted`");
    expect(md).toContain("- **Interrupted**: the run was cancelled before completion");
    expect(md).toContain("0/1 required gates passed (2 required checks not applicable)");
    expect(md).toContain("- `a11y`: guard not met");
    expect(md).toContain("| unit | optional | passed | 10ms | `pnpm test` |  |");
    expect(md).toContain("- **deny** `network` (before, system): denied");
    expect(md).toMatch(/`x-net` waives `network-access:unit`: needs registry .*, origin external;/);
    expect(md).toMatch(/`x-ws` waives .*, origin \*\*workspace\\_supplied\*\*;/);
    expect(md).toContain(
      "- exceptions: `.brokkr/exceptions.yaml` — **workspace_supplied** (inside the verified workspace)",
    );
    expect(md).toContain("- organization-policy: `/etc/brokkr/org.yaml` — external");
  });

  it("html shows the same, and an evidence path outside the safe set is not linked", () => {
    const html = renderHtml(full);
    expect(html).toContain("<tr><th>Trust mode</th><td><code>workspace-untrusted</code></td></tr>");
    expect(html).toContain(" · <strong>interrupted</strong>");
    expect(html).toContain("<code>a11y</code>: guard not met");
    expect(html).toContain("(before, system)</span>: denied");
    expect(html).toContain("<code>x-net</code> waives <code>network-access:unit</code>: needs");
    expect(html).toContain(
      "exceptions: <code>.brokkr/exceptions.yaml</code> — <strong>workspace_supplied</strong>",
    );
    expect(html).toContain("organization-policy: <code>/etc/brokkr/org.yaml</code> — external");
    expect(html).toContain("<code>logs/a b.log</code>");
    expect(html).not.toContain('href="./logs/a b.log"');
  });

  it("escapeHtml defuses quotes and URLs", () => {
    expect(escapeHtml(`"a" 'b' https://x`)).toBe("&quot;a&quot; &#39;b&#39; https&#58;//x");
  });
});
