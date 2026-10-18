#!/usr/bin/env node
// Brokkr security-baseline scanner. Dependency-free (Node >= 18).
// Usage: node scan.mjs [--kind secrets|config|code|all] [--root DIR] [--patterns FILE]
// Output: one JSON document on stdout. Matched values are never printed.
// Exit: 1 when any result is tagged "finding", otherwise 0. "heuristic" results never fail the run.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const kind = opt("--kind", "all");
const root = resolve(opt("--root", process.cwd()));
const patternsFile = resolve(opt("--patterns", join(here, "..", "patterns", "patterns.json")));
if (!["all", "secrets", "config", "code"].includes(kind)) {
  console.error(`unknown --kind '${kind}'`);
  process.exit(2);
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".turbo", ".next", ".brokkr", ".godot"]);
const SKIP_FILES = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|.*\.min\.js|.*\.map)$/;
const MAX_BYTES = 1_000_000;

const rules = JSON.parse(readFileSync(patternsFile, "utf8")).rules
  .filter((r) => kind === "all" || r.kind === kind)
  .map((r) => ({ ...r, re: new RegExp(r.pattern, r.flags ?? "") }));

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const findings = [];
let scanned = 0;
for (const file of walk(root)) {
  const rel = relative(root, file).split("\\").join("/");
  if (SKIP_FILES.test(rel) || statSync(file).size > MAX_BYTES) continue;
  const text = readFileSync(file, "utf8");
  if (text.includes("\0")) continue;
  scanned += 1;
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of rules) {
      if (rule.re.test(line)) {
        findings.push({ rule: rule.id, kind: rule.kind, confidence: rule.confidence, file: rel, line: index + 1, description: rule.description });
      }
    }
  });
}

const confirmed = findings.filter((f) => f.confidence === "finding").length;
const heuristics = findings.length - confirmed;
process.stdout.write(`${JSON.stringify({ kind, scannedFiles: scanned, summary: { finding: confirmed, heuristic: heuristics }, findings }, null, 2)}\n`);
process.exit(confirmed > 0 ? 1 : 0);
