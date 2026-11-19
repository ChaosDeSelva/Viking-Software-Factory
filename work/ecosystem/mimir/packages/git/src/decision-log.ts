import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionLogEntry } from "@mimir/protocol";

function logSection(text: string): { start: number; end: number } | undefined {
  let start: number | undefined;
  let fence = "";
  let previous = "";
  let previousOffset = 0;
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = (match.index === 0 ? match[0].replace(/^\uFEFF/, "") : match[0]).replace(
      /\r?\n$/,
      "",
    );
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const [, run, tail] = marker;
      if (!fence) fence = run!;
      else if (run![0] === fence[0] && run!.length >= fence.length && !tail!.trim()) fence = "";
      previous = "";
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}(#{1,2})(?:[ \t]+(.*)|$)/.exec(line);
    const underline = previous.trim() && /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (heading || underline) {
      if (start !== undefined) return { start, end: heading ? match.index : previousOffset };
      const title = heading ? (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "") : previous;
      if (
        (heading ? heading[1] === "##" : underline && underline[1]![0] === "-") &&
        title.trim().toLowerCase() === "decision log"
      ) {
        start = match.index + match[0].length;
      }
      previous = "";
    } else {
      previous = line;
      previousOffset = match.index;
    }
  }
  return start === undefined ? undefined : { start, end: text.length };
}

export function appendDecisions(text: string, entries: readonly DecisionLogEntry[]): string {
  const section = logSection(text);
  const existing = section ? text.slice(section.start, section.end) : "";
  const recorded = new Set(
    existing.match(/^<!-- decision:[a-f0-9]{64} -->\r?$/gm)?.map((line) => line.trimEnd()),
  );
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const additions: string[] = [];
  for (const entry of entries) {
    const digest = createHash("sha256").update(entry.id).digest("hex");
    const marker = `<!-- decision:${digest} -->`;
    if (recorded.has(marker)) continue;
    recorded.add(marker);
    additions.push(marker + newline + entry.markdown.trim().replace(/\r?\n/g, newline));
  }
  if (!additions.length) return text;
  const insert = section?.end ?? text.length;
  const before = text.slice(0, insert);
  const space =
    before.endsWith(newline + newline) || !before
      ? ""
      : before.endsWith(newline)
        ? newline
        : newline + newline;
  const heading = section ? "" : "## Decision log" + newline + newline;
  return (
    before +
    space +
    heading +
    additions.join(newline + newline) +
    newline +
    (insert < text.length ? newline + text.slice(insert) : "")
  );
}

export async function updateDecisionLog(
  dir: string,
  entries: readonly DecisionLogEntry[],
): Promise<void> {
  const file = join(dir, "SPEC.md");
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  let original = "";
  let mode = 0o644;
  if (handle) {
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("SPEC.md must be a regular Markdown file.");
      mode = info.mode & 0o777;
      original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await handle.readFile(),
      );
      if (original.includes("\0")) throw new Error("SPEC.md must be a UTF-8 Markdown file.");
    } finally {
      await handle.close();
    }
  }
  const updated = appendDecisions(original, entries);
  if (updated === original) return;
  const temp = join(dir, `.spec-${randomUUID()}.tmp`);
  const out = await open(temp, "wx", mode);
  try {
    try {
      await out.writeFile(updated);
      await out.chmod(mode);
    } finally {
      await out.close();
    }
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
