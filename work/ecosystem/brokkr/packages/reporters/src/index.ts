import type { CheckResult, VerificationReport } from "@brokkr/core";

export type ReportFormat = "json" | "md" | "html";
export const REPORT_FORMATS: readonly ReportFormat[] = ["json", "md", "html"];

/** Canonical machine-readable form (spec §10.5). */
export function renderJson(report: VerificationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** `passed`, `failed`, ... or `skipped (exception <id>)` for waived checks: never "passed". */
export function checkStateLabel(check: CheckResult): string {
  if (check.state === "skipped" && check.exceptionId)
    return `skipped (exception ${check.exceptionId})`;
  if (check.state === "skipped" && check.reason === "not_applicable")
    return `skipped (not applicable${check.message ? `: ${check.message}` : ""})`;
  if (check.state === "skipped" && check.reason) return `skipped (${check.reason})`;
  return check.state;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`;
}

function summaryLine(r: VerificationReport): string {
  const s = r.summary;
  return `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped, ${s.errored} errored`;
}

/** Required checks skipped because their `when` guard was not met (and not demanded by policy). */
export function notApplicableRequired(r: VerificationReport): VerificationReport["checks"] {
  return r.checks.filter(
    (c) =>
      c.required &&
      c.state === "skipped" &&
      c.reason === "not_applicable" &&
      c.requiredBy !== "policy",
  );
}

function requiredGates(r: VerificationReport): string {
  const na = notApplicableRequired(r);
  const required = r.checks.filter((c) => c.required && !na.includes(c));
  const passed = required.filter((c) => c.state === "passed").length;
  const note =
    na.length === 0
      ? ""
      : ` (${na.length} required check${na.length === 1 ? "" : "s"} not applicable)`;
  return `${passed}/${required.length} required gates passed${note}`;
}

/** Checks granted network access despite a deny (allowNetworkFor or a check-bound approval). */
export function networkAllowances(r: VerificationReport): Array<{ checkId: string; by: string }> {
  return r.policyDecisions
    .filter((d) => d.policy === "network-access" && d.outcome === "approved" && d.checkId)
    .map((d) => ({
      checkId: d.checkId!,
      by: d.exceptionId ? `exception ${d.exceptionId}` : d.layer,
    }));
}

/** Remove C0/C1 control characters (terminal escapes) except newline and tab. */
export function stripControl(value: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Defang `http(s)://` so untrusted text never becomes a link or remote image. */
function defangUrls(value: string): string {
  return value.replace(/(https?):\/\//gi, "$1[:]//");
}

/**
 * Untrusted text for Markdown: one line, control characters removed, URLs
 * defanged and every Markdown/HTML-significant character escaped, so it can
 * never start a heading, image, link, HTML tag or table cell.
 */
export function mdText(value: string): string {
  return defangUrls(stripControl(value).replace(/\r?\n/g, " ")).replace(
    /[\\`*_[\](){}#!<>|~]/g,
    "\\$&",
  );
}

/** Untrusted text inside an inline code span (commands, paths, digests). */
function mdCode(value: string): string {
  return `\`${defangUrls(stripControl(value).replace(/\r?\n/g, " ")).replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
}

/** Markdown variant of `checkStateLabel` with untrusted parts escaped. */
function mdStateLabel(check: CheckResult): string {
  if (check.state === "skipped" && check.exceptionId)
    return `skipped (exception ${mdText(check.exceptionId)})`;
  if (check.state === "skipped" && check.reason === "not_applicable")
    return `skipped (not applicable${check.message ? `: ${mdText(check.message)}` : ""})`;
  if (check.state === "skipped" && check.reason) return `skipped (${check.reason})`;
  return check.state;
}

/**
 * PR-ready Markdown (spec §10.5). Every value that can come from the
 * workspace, a check or an exception file goes through `mdText`/`mdCode`.
 */
export function renderMarkdown(r: VerificationReport): string {
  const t = mdText;
  const c = mdCode;
  const lines: string[] = [];
  lines.push(`# Brokkr verification: ${r.verdict.toUpperCase()}`, "");
  lines.push(`- Run: ${c(r.id)}`);
  if (r.trustMode) lines.push(`- Trust mode: ${c(r.trustMode)}`);
  if (r.taskId) lines.push(`- Task: ${c(r.taskId)}`);
  lines.push(
    `- Harness: ${t(r.harnesses.map((h) => `${h.name}@${h.version}`).join(", ") || "none")}`,
  );
  lines.push(`- Lock digest: ${c(r.harness.lockDigest)}`);
  lines.push(
    `- Repository: ${c(r.repository.commitSha)}${r.repository.dirtyTreeDigest ? ` (tree ${c(r.repository.dirtyTreeDigest)})` : ""}`,
  );
  lines.push(`- Started: ${t(r.startedAt)} · Completed: ${t(r.completedAt)}`);
  if (r.interrupted) lines.push("- **Interrupted**: the run was cancelled before completion");
  lines.push(`- Summary: ${summaryLine(r)} · ${requiredGates(r)}`);
  const net = networkAllowances(r);
  if (net.length > 0)
    lines.push(
      `- Network allowed for: ${net.map((n) => `${c(n.checkId)} (${t(n.by)})`).join(", ")}`,
    );
  lines.push("");
  if (r.reasons.length > 0) {
    lines.push("## Verdict reasons", "", ...r.reasons.map((x) => `- ${t(x)}`), "");
  }
  const na = notApplicableRequired(r);
  if (na.length > 0) {
    lines.push(
      "## Required checks not applicable",
      "",
      "These required checks did not run because their `when` guard was not met. Confirm the guard files were not removed to avoid them.",
      "",
      ...na.map((x) => `- ${c(x.id)}: ${t(x.message ?? "guard not met")}`),
      "",
    );
  }
  lines.push("## Checks", "");
  lines.push("| Check | Gate | Result | Duration | Command | Details |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const x of r.checks) {
    const details = [
      x.exitCode !== undefined && x.exitCode !== null ? `exit ${x.exitCode}` : "",
      x.message ? t(x.message) : "",
      x.log ? `log: ${t(x.log)}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    lines.push(
      `| ${t(x.id)} | ${x.required ? "required" : "optional"} | ${mdStateLabel(x)} | ${formatDuration(x.durationMs)} | ${c(x.command.join(" "))} | ${details} |`,
    );
  }
  lines.push("", "## Policy decisions", "");
  if (r.policyDecisions.length === 0) lines.push("None.");
  for (const d of r.policyDecisions) {
    lines.push(
      `- **${d.outcome}** ${c(d.policy)} (${d.stage}, ${d.layer}${d.checkId ? `, check ${t(d.checkId)}` : ""}): ${t(d.message)}`,
    );
  }
  lines.push("", "## Exceptions", "");
  if (r.exceptions.length === 0) lines.push("None.");
  for (const e of r.exceptions) {
    lines.push(
      `- ${c(e.id)} waives ${c(e.policy)}${e.appliedTo.checkId ? ` (check ${t(e.appliedTo.checkId)})` : ""}: ${t(e.reason)} — approved by ${t(e.approvedBy)} at ${t(e.approvedAt)}, expires ${t(e.expiresAt)}${e.origin ? `, origin ${e.origin === "workspace_supplied" ? "**workspace\\_supplied**" : "external"}` : ""}; harnesses ${t(e.appliedTo.harnesses.join(", "))}`,
    );
  }
  if (r.policySources && r.policySources.length > 0) {
    lines.push("", "## Policy sources", "");
    for (const p of r.policySources)
      lines.push(
        `- ${p.kind}: ${c(p.path)} — ${p.origin === "workspace_supplied" ? "**workspace_supplied** (inside the verified workspace)" : "external"} ${c(p.digest)}`,
      );
  }
  lines.push("", "## Evidence", "");
  if (r.evidence.length === 0) lines.push("None.");
  for (const e of r.evidence) {
    lines.push(`- ${c(e.path)} (${e.kind}, ${e.bytes} bytes, ${t(e.producedBy)}) ${c(e.sha256)}`);
  }
  if (r.warnings.length > 0)
    lines.push("", "## Warnings", "", ...r.warnings.map((w) => `- ${t(w)}`));
  lines.push("", "## Environment", "");
  lines.push(
    `Brokkr ${t(r.environment.brokkrVersion)} · Node ${t(r.environment.node)} · ${t(r.environment.platform)}/${t(r.environment.arch)}`,
    "",
  );
  return lines.join("\n");
}

/** Escape text for HTML and defuse `http(s)://` so no text can become a remote reference. */
/** Only run-relative evidence paths become links (never schemes such as javascript: or data:). */
function safeHref(path: string): string | undefined {
  if (!/^(logs|test-results|screenshots)\/[A-Za-z0-9._/-]+$/.test(path) || path.includes(".."))
    return undefined;
  return `./${path}`;
}

function evidenceLink(path: string): string {
  const href = safeHref(path);
  return href
    ? `<a href="${escapeHtml(href)}">${escapeHtml(path)}</a>`
    : `<code>${escapeHtml(path)}</code>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/(https?):\/\//gi, "$1&#58;//");
}

const CSS = `
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#1f2328;background:#fff}
h1{font-size:1.6rem;margin:0 0 .5rem}h2{font-size:1.15rem;margin:2rem 0 .5rem;border-bottom:1px solid #d0d7de}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:.35rem .5rem;text-align:left;vertical-align:top}
th{background:#f6f8fa}code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;word-break:break-all}
.verdict{display:inline-block;padding:.15rem .6rem;border-radius:1rem;font-weight:600;color:#fff}
.passed{background:#1a7f37}.failed{background:#cf222e}.incomplete{background:#9a6700}.blocked{background:#8250df}
.state-passed{color:#1a7f37}.state-failed,.state-errored,.state-timed_out{color:#cf222e}.state-skipped,.state-cancelled{color:#9a6700}
ul{padding-left:1.25rem}.muted{color:#59636e}
`;

function htmlList(items: string[], empty = "None."): string {
  return items.length === 0
    ? `<p class="muted">${empty}</p>`
    : `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
}

/** Self-contained offline HTML: inline CSS, no scripts, no external resources (spec §17.3). */
export function renderHtml(r: VerificationReport): string {
  const e = escapeHtml;
  const rows = r.checks
    .map(
      (c) =>
        `<tr><td><code>${e(c.id)}</code></td><td>${c.required ? "required" : "optional"}</td><td class="state-${c.state}">${e(checkStateLabel(c))}</td><td>${formatDuration(c.durationMs)}</td><td><code>${e(c.command.join(" "))}</code></td><td>${[
          c.exitCode !== undefined && c.exitCode !== null ? `exit ${c.exitCode}` : "",
          c.message ? e(c.message) : "",
          c.log ? evidenceLink(c.log) : "",
        ]
          .filter(Boolean)
          .join("<br>")}</td></tr>`,
    )
    .join("");
  const decisions = r.policyDecisions.map(
    (d) =>
      `<strong>${e(d.outcome)}</strong> <code>${e(d.policy)}</code> <span class="muted">(${e(d.stage)}, ${e(d.layer)}${d.checkId ? `, check ${e(d.checkId)}` : ""})</span>: ${e(d.message)}`,
  );
  const exceptions = r.exceptions.map(
    (x) =>
      `<code>${e(x.id)}</code> waives <code>${e(x.policy)}</code>${x.appliedTo.checkId ? ` (check ${e(x.appliedTo.checkId)})` : ""}: ${e(x.reason)}. Approved by ${e(x.approvedBy)} at ${e(x.approvedAt)}, expires ${e(x.expiresAt)}. Harnesses: ${e(x.appliedTo.harnesses.join(", "))}`,
  );
  const evidence = r.evidence.map(
    (x) =>
      `${evidenceLink(x.path)} <span class="muted">${e(x.kind)}, ${x.bytes} bytes, ${e(x.producedBy)}</span> <code>${e(x.sha256)}</code>`,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'">
<title>Brokkr verification ${e(r.id)}: ${e(r.verdict)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>Brokkr verification <span class="verdict ${r.verdict}">${e(r.verdict)}</span></h1>
<p>${e(summaryLine(r))} · ${e(requiredGates(r))}${r.interrupted ? " · <strong>interrupted</strong>" : ""}</p>
${
  networkAllowances(r).length > 0
    ? `<p><strong>Network allowed for: ${networkAllowances(r)
        .map((n) => `<code>${e(n.checkId)}</code> (${e(n.by)})`)
        .join(", ")}</strong></p>`
    : ""
}
<h2>Summary</h2>
<table>
<tr><th>Run</th><td><code>${e(r.id)}</code></td></tr>
${r.trustMode ? `<tr><th>Trust mode</th><td><code>${e(r.trustMode)}</code></td></tr>` : ""}
${r.taskId ? `<tr><th>Task</th><td><code>${e(r.taskId)}</code></td></tr>` : ""}
<tr><th>Harnesses</th><td>${e(r.harnesses.map((h) => `${h.name}@${h.version}`).join(", ") || "none")}</td></tr>
<tr><th>Lock digest</th><td><code>${e(r.harness.lockDigest)}</code></td></tr>
<tr><th>Commit</th><td><code>${e(r.repository.commitSha)}</code></td></tr>
<tr><th>Tree digest</th><td><code>${e(r.repository.dirtyTreeDigest ?? "n/a")}</code></td></tr>
<tr><th>Started</th><td>${e(r.startedAt)}</td></tr>
<tr><th>Completed</th><td>${e(r.completedAt)}</td></tr>
</table>
${r.reasons.length > 0 ? `<h2>Verdict reasons</h2>${htmlList(r.reasons.map(e))}` : ""}
${
  notApplicableRequired(r).length > 0
    ? `<h2>Required checks not applicable</h2><p>These required checks did not run because their <code>when</code> guard was not met. Confirm the guard files were not removed to avoid them.</p>${htmlList(notApplicableRequired(r).map((c) => `<code>${e(c.id)}</code>: ${e(c.message ?? "guard not met")}`))}`
    : ""
}
<h2>Checks</h2>
<table><tr><th>Check</th><th>Gate</th><th>Result</th><th>Duration</th><th>Command</th><th>Details</th></tr>${rows}</table>
<h2>Policy decisions</h2>
${htmlList(decisions)}
<h2>Exceptions</h2>
${htmlList(exceptions)}
${
  r.policySources && r.policySources.length > 0
    ? `<h2>Policy sources</h2>${htmlList(
        r.policySources.map(
          (p) =>
            `${e(p.kind)}: <code>${e(p.path)}</code> — ${p.origin === "workspace_supplied" ? "<strong>workspace_supplied</strong> (inside the verified workspace)" : "external"} <code>${e(p.digest)}</code>`,
        ),
      )}`
    : ""
}
<h2>Evidence</h2>
${htmlList(evidence)}
${r.warnings.length > 0 ? `<h2>Warnings</h2>${htmlList(r.warnings.map(e))}` : ""}
<h2>Environment</h2>
<p>Brokkr ${e(r.environment.brokkrVersion)} · Node ${e(r.environment.node)} · ${e(r.environment.platform)}/${e(r.environment.arch)}</p>
</body>
</html>
`;
}

export function renderReport(report: VerificationReport, format: ReportFormat): string {
  switch (format) {
    case "json":
      return renderJson(report);
    case "md":
      return renderMarkdown(report);
    case "html":
      return renderHtml(report);
    default:
      throw new Error(`unknown report format '${String(format)}' (expected json, md or html)`);
  }
}
