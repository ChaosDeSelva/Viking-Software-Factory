import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The fixture "ticket" `sindri demo` imports as a manual intake. */
export const DEMO_TICKET = {
  title: "Add CSV export to the reports page",
  body: [
    "As a finance user I want to download the invoices on the reports page as CSV.",
    "",
    "Acceptance:",
    "- GET /api/reports.csv returns text/csv with a header row `id,customer,total`.",
    "- The reports page shows a 'Download CSV' link.",
    "- Totals keep two decimals.",
  ].join("\n"),
} as const;

export interface DemoRepo {
  /** `<root>/repo`: a committed git repository. */
  repoPath: string;
  /** `<root>/ticket.json`: the ticket fixture (outside the repo). */
  ticketPath: string;
  /** Repo-relative path of the planted failing test, or null without the flag. */
  failingTest: string | null;
  /** `<root>/planted-failure.flag` while the planted failure is armed. */
  flagPath: string | null;
}

const FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "sindri-demo-reports",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { start: "node api/server.js", test: "node --test" },
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    },
    null,
    2,
  ),
  "README.md": [
    "# Reports demo",
    "",
    "A tiny full-stack sample created by `sindri demo`.",
    "",
    "- `api/`: a Node HTTP API (`GET /api/reports`) with no dependencies.",
    "- `web/`: a React page that lists the invoices and their total.",
    "- Tests: `npm test` (node:test, no install needed).",
    "",
  ].join("\n"),
  "api/reports.js": [
    "export const INVOICES = [",
    '  { id: "inv-1", customer: "Acme", total: 120.5 },',
    '  { id: "inv-2", customer: "Globex", total: 80 },',
    "];",
    "",
    "/** The sum of invoice totals, rounded to cents. */",
    "export function grandTotal(rows) {",
    "  return Math.round(rows.reduce((s, r) => s + r.total, 0) * 100) / 100;",
    "}",
    "",
  ].join("\n"),
  "api/server.js": [
    'import { createServer } from "node:http";',
    'import { INVOICES, grandTotal } from "./reports.js";',
    "",
    "export function handle(req, res) {",
    '  if (req.url === "/api/reports") {',
    '    res.writeHead(200, { "content-type": "application/json" });',
    "    return res.end(JSON.stringify({ invoices: INVOICES, total: grandTotal(INVOICES) }));",
    "  }",
    "  res.writeHead(404);",
    "  res.end();",
    "}",
    "",
    "if (import.meta.url === `file://${process.argv[1]}`) {",
    '  createServer(handle).listen(3000, "127.0.0.1");',
    "}",
    "",
  ].join("\n"),
  "web/ReportsPage.jsx": [
    'import { useEffect, useState } from "react";',
    'import { formatMoney } from "./format.js";',
    "",
    "export function ReportsPage() {",
    "  const [data, setData] = useState(null);",
    "  useEffect(() => {",
    '    fetch("/api/reports").then((r) => r.json()).then(setData);',
    "  }, []);",
    "  if (!data) return <p>Loading…</p>;",
    "  return (",
    "    <main>",
    "      <h1>Reports</h1>",
    "      <ul>",
    "        {data.invoices.map((i) => (",
    "          <li key={i.id}>{i.customer}: {formatMoney(i.total)}</li>",
    "        ))}",
    "      </ul>",
    "      <p>Total: {formatMoney(data.total)}</p>",
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n"),
  "web/format.js": [
    "/** Two decimals, no currency symbol. */",
    "export const formatMoney = (n) => n.toFixed(2);",
    "",
  ].join("\n"),
  "test/reports.test.js": [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { INVOICES, grandTotal } from "../api/reports.js";',
    'import { formatMoney } from "../web/format.js";',
    "",
    'test("grand total sums invoices", () => {',
    "  assert.equal(grandTotal(INVOICES), 200.5);",
    "});",
    "",
    'test("money keeps two decimals", () => {',
    '  assert.equal(formatMoney(80), "80.00");',
    "});",
    "",
  ].join("\n"),
  ".gitignore": "node_modules/\n",
};

/**
 * The planted test fails while the flag file (outside the repo, so every worktree sees the same
 * one) exists, and disarms it as it fails: the next run passes. With a fake agent runtime nothing
 * edits the code, so this one-shot flag stands in for the repair an agent would make.
 */
const plantedTest = (flagPath: string) =>
  [
    'import assert from "node:assert/strict";',
    'import { existsSync, rmSync } from "node:fs";',
    'import { test } from "node:test";',
    "",
    "// Planted by `sindri demo --with-failing-test`: fails once, while this flag exists.",
    `const FLAG = ${JSON.stringify(flagPath)};`,
    "",
    'test("CSV export header (planted failure)", () => {',
    "  if (existsSync(FLAG)) {",
    "    rmSync(FLAG, { force: true });",
    '    assert.fail("planted failure: CSV export is missing");',
    "  }",
    "});",
    "",
  ].join("\n");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Sindri demo",
  GIT_AUTHOR_EMAIL: "demo@localhost",
  GIT_COMMITTER_NAME: "Sindri demo",
  GIT_COMMITTER_EMAIL: "demo@localhost",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });

/** Writes the demo repo under `<root>/repo` (one commit on `main`) and the ticket fixture. */
export function writeDemoRepo(root: string, o: { failingTest?: boolean } = {}): DemoRepo {
  const repoPath = join(root, "repo");
  const files = { ...FILES };
  const flagPath = o.failingTest ? join(root, "planted-failure.flag") : null;
  if (flagPath) files["test/planted.test.js"] = plantedTest(flagPath);
  for (const [rel, text] of Object.entries(files)) {
    const p = join(repoPath, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text.endsWith("\n") ? text : text + "\n");
  }
  if (flagPath) writeFileSync(flagPath, "armed\n");
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-q", "-m", "Reports demo"]);
  const ticketPath = join(root, "ticket.json");
  writeFileSync(ticketPath, JSON.stringify(DEMO_TICKET, null, 2) + "\n");
  return {
    repoPath,
    ticketPath,
    failingTest: flagPath ? "test/planted.test.js" : null,
    flagPath,
  };
}
