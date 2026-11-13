import { RESEARCH_DOCUMENT, RESEARCH_SECTION_TITLES, RESEARCH_SOURCES } from "@sindri/mimir-client";
import { z } from "zod";
import type { GateFailure } from "./brokkr-report.js";
import {
  isTrusted,
  readVerifiedArtifact,
  type EvidenceTrust,
  type RecordedArtifact,
} from "./evidence.js";
import type {
  ArtifactContentReader,
  ExecutionEventView,
  MimirActions,
  ResearchSourcesView,
} from "./ports.js";

/** Files a research task writes to `.mimir/artifacts/` (see `@sindri/mimir-client`). */
export const RESEARCH_DOCUMENT_FILE = RESEARCH_DOCUMENT;
export const RESEARCH_SOURCES_FILE = RESEARCH_SOURCES;
/** Mimir's artifact kind for a collected `*.md`. */
export const REPORT_ARTIFACT_KIND = "report";
export const REQUIRED_RESEARCH_SECTIONS = RESEARCH_SECTION_TITLES;

/** Gate ids of the research checks (one per rule, so a failure says which rule broke). */
export const RESEARCH_GATES = {
  document: "research-document",
  sources: "research-sources",
  citations: "research-citations",
  files: "research-file-sources",
  policy: "research-source-policy",
} as const;

export const ResearchSourceSchema = z
  .object({
    id: z.string().regex(/^\d{1,4}$/),
    kind: z.enum(["file", "url", "lesson"]),
    ref: z.string().min(1).max(2000),
    title: z.string().max(500).optional(),
  })
  .strip();
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

export interface ResearchArtifacts {
  document: { text: string; artifactId: string } | null;
  sources: { text: string; artifactId: string } | null;
}

/** Text outside fenced code blocks (``` or ~~~), so code samples never count as citations. */
export function outsideCodeFences(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const mark = m[1]!;
      if (fence === null) fence = mark;
      // A closing fence is the opening character, at least as many times, and nothing else.
      else if (
        mark[0] === fence[0] &&
        mark.length >= fence.length &&
        line.trim() === line.trim()[0]!.repeat(line.trim().length)
      )
        fence = null;
      continue;
    }
    if (fence === null) out.push(line);
  }
  return out.join("\n");
}

/**
 * Citation runs, the rule `@factory/ui` `stripPrivateCitations` uses: `[1]`, `[1, 2]` or `[1][3]`,
 * not after a word character, `]` or `)` (so `items[0]` is code, not a citation), and not a
 * `[n](url)` link.
 */
const CITATION_RUN = /(?<![\w\])])((?:\[\d+(?:\s*,\s*\d+)*\](?!\())+)/g;
const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
/** `[1-3]` in citation position: ranges are not a supported citation form. */
const CITATION_RANGE = /(?<![\w\])])\[\d+\s*[-–]\s*\d+\](?!\()/g;

/** Headings of the sections that list sources rather than cite them. */
const SOURCE_LIST_HEADING = /^(?:sources|references|bibliography|citations|works cited)$/i;

/**
 * The document without its source-list sections (`## Sources`, `## References`, ...): a heading
 * of that name and everything up to the next heading of the same or a higher level. `[1] ref`
 * lines there list sources; they never count as citations.
 */
export function withoutSourceLists(markdown: string): string {
  const out: string[] = [];
  let skipLevel = 0;
  for (const line of markdown.split("\n")) {
    const h = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && SOURCE_LIST_HEADING.test(h[2]!.replace(/[*_:]/g, "").trim())) {
        skipLevel = level;
        continue;
      }
    }
    if (!skipLevel) out.push(line);
  }
  return out.join("\n");
}

/** Document text that can hold citations: outside code fences, inline code and source lists. */
const citable = (markdown: string) =>
  withoutSourceLists(outsideCodeFences(markdown)).replace(/`[^`\n]*`/g, "");

/** The distinct citation numbers of a document. */
export function citationIds(markdown: string): string[] {
  const ids = new Set<string>();
  for (const run of citable(markdown).matchAll(CITATION_RUN))
    for (const m of run[1]!.matchAll(MARKER))
      for (const n of m[1]!.split(",")) ids.add(String(Number(n.trim())));
  return [...ids];
}

/** Range citations such as `[1-3]`, which the gate refuses. */
export const citationRanges = (markdown: string): string[] => [
  ...new Set([...citable(markdown).matchAll(CITATION_RANGE)].map((m) => m[0])),
];

/** Level-2 headings of a document, outside code fences. */
export const sectionsOf = (markdown: string): string[] =>
  [...outsideCodeFences(markdown).matchAll(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((m) =>
    m[1]!.trim(),
  );

/** `path:line` or `path:start-end` (paths relative to the repository root). */
export function parseFileRef(ref: string): { path: string; start: number; end: number } | null {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref.trim());
  if (!m) return null;
  const path = m[1]!.replace(/^\.\//, "");
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (!path || path.startsWith("/") || path.split("/").includes("..") || /[\0\n]/.test(path))
    return null;
  if (start < 1 || end < start) return null;
  return { path, start, end };
}

const isHttpUrl = (ref: string) => {
  try {
    const u = new URL(ref);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
};

export interface ResearchCheckInput {
  artifacts: ResearchArtifacts;
  allowed: ResearchSourcesView;
  /** Lesson refs the task was given (`lesson:<id>`). */
  lessonRefs: ReadonlySet<string>;
  /** Line count of a file at the task's base commit; absent when no repository is readable. */
  lineCount?: (path: string) => Promise<number | null>;
}

export interface ResearchCheck {
  failures: GateFailure[];
  sources: ResearchSource[];
}

/**
 * The research gates over the recorded document and sources: required sections, parseable
 * sources, every citation resolving to a source, file sources that exist at the base commit with
 * valid line ranges, and only the kinds of sources the request allowed.
 */
export async function checkResearch(input: ResearchCheckInput): Promise<ResearchCheck> {
  const failures: GateFailure[] = [];
  const fail = (gateId: string, reason: string, evidenceRef?: string) =>
    failures.push({ gateId, reason, ...(evidenceRef ? { evidenceRef } : {}) });
  const { document, sources: sourcesFile } = input.artifacts;

  if (!document) fail(RESEARCH_GATES.document, "document_missing");
  else {
    const have = new Set(sectionsOf(document.text).map((s) => s.toLowerCase()));
    for (const s of REQUIRED_RESEARCH_SECTIONS)
      if (!have.has(s.toLowerCase()))
        fail(RESEARCH_GATES.document, `section_missing:${s}`, document.artifactId);
  }

  let sources: ResearchSource[] = [];
  let parsedSources = false;
  if (!sourcesFile) fail(RESEARCH_GATES.sources, "sources_missing");
  else {
    let raw: unknown;
    try {
      raw = JSON.parse(sourcesFile.text);
    } catch {
      raw = undefined;
    }
    const parsed = z.array(ResearchSourceSchema).max(500).safeParse(raw);
    if (!parsed.success)
      fail(RESEARCH_GATES.sources, "sources_unparseable", sourcesFile.artifactId);
    else {
      parsedSources = true;
      sources = parsed.data.map((s) => ({ ...s, id: String(Number(s.id)) }));
      const seen = new Set<string>();
      for (const s of sources) {
        if (seen.has(s.id))
          fail(RESEARCH_GATES.sources, `source_duplicate:${s.id}`, sourcesFile.artifactId);
        seen.add(s.id);
      }
    }
  }

  if (sourcesFile && parsedSources && sources.length === 0)
    fail(RESEARCH_GATES.sources, "no_sources", sourcesFile.artifactId);
  if (document) {
    const ids = new Set(sources.map((s) => s.id));
    const cited = citationIds(document.text);
    if (cited.length === 0) fail(RESEARCH_GATES.citations, "no_citations", document.artifactId);
    if (parsedSources)
      for (const n of cited)
        if (!ids.has(n))
          fail(RESEARCH_GATES.citations, `citation_unresolved:${n}`, document.artifactId);
    for (const r of citationRanges(document.text))
      fail(
        RESEARCH_GATES.citations,
        `citation_range_unsupported:${r}: cite each source, as [1] or [1, 2]`,
        document.artifactId,
      );
  }

  const ref = sourcesFile?.artifactId;
  for (const s of sources) {
    switch (s.kind) {
      case "url":
        if (!isHttpUrl(s.ref)) fail(RESEARCH_GATES.policy, `url_invalid:${s.id}`, ref);
        else if (!input.allowed.web) fail(RESEARCH_GATES.policy, `web_not_allowed:${s.id}`, ref);
        break;
      case "lesson":
        if (!input.allowed.feedbackGraph)
          fail(RESEARCH_GATES.policy, `lesson_not_allowed:${s.id}`, ref);
        else if (!input.lessonRefs.has(s.ref))
          fail(RESEARCH_GATES.policy, `lesson_unknown:${s.id}`, ref);
        break;
      case "file": {
        if (!input.allowed.code) {
          fail(RESEARCH_GATES.policy, `code_not_allowed:${s.id}`, ref);
          break;
        }
        const f = parseFileRef(s.ref);
        if (!f) {
          fail(RESEARCH_GATES.files, `file_ref_invalid:${s.id}`, ref);
          break;
        }
        if (!input.lineCount) {
          fail(RESEARCH_GATES.files, `file_unverifiable:${s.id}:no_base_commit`, ref);
          break;
        }
        let lines: number | null;
        try {
          lines = await input.lineCount(f.path);
        } catch (e) {
          // The repository reader names why (`commit_unresolvable`, `repo_unavailable`, ...).
          const why = e instanceof Error && /^[a-z_]{1,40}$/.test(e.message) ? e.message : "error";
          fail(RESEARCH_GATES.files, `file_unverifiable:${s.id}:${why}`, ref);
          break;
        }
        if (lines === null) fail(RESEARCH_GATES.files, `file_not_found:${s.id}`, ref);
        else if (f.end > lines) fail(RESEARCH_GATES.files, `line_range_invalid:${s.id}`, ref);
        break;
      }
    }
  }
  return { failures, sources };
}

/**
 * The latest trusted research document and sources file of a task lineage, read through Mimir
 * and checked against their recorded hashes. Never taken from agent text.
 */
export async function readResearchArtifacts(
  mimir: Pick<MimirActions, "getArtifact">,
  content: ArtifactContentReader,
  artifacts: readonly RecordedArtifact[],
): Promise<ResearchArtifacts & { unreadable: GateFailure[] }> {
  const unreadable: GateFailure[] = [];
  const read = async (pick: RecordedArtifact | undefined, gateId: string) => {
    if (!pick) return null;
    const r = await readVerifiedArtifact(mimir, content, pick.artifactId, {
      taskId: pick.taskId,
      kind: pick.kind,
    });
    if (!r.ok) {
      unreadable.push({ gateId, reason: r.reason, evidenceRef: pick.artifactId });
      return null;
    }
    return { text: r.text, artifactId: pick.artifactId };
  };
  const doc = artifacts
    .filter(
      (a) =>
        a.name === RESEARCH_DOCUMENT_FILE || (a.name === null && a.kind === REPORT_ARTIFACT_KIND),
    )
    .at(-1);
  const src = artifacts.filter((a) => a.name === RESEARCH_SOURCES_FILE).at(-1);
  return {
    document: await read(doc, RESEARCH_GATES.document),
    sources: await read(src, RESEARCH_GATES.sources),
    unreadable,
  };
}

/** The base commit Mimir recorded for the first worktree of a task lineage. */
export function baseCommitOf(
  events: readonly ExecutionEventView[],
  lineage: ReadonlySet<string>,
  trust: EvidenceTrust,
): string | null {
  for (const e of events) {
    if (e.type !== "git.worktree_created" || !e.mimirTaskId || !lineage.has(e.mimirTaskId))
      continue;
    if (!isTrusted(e, trust)) continue;
    const p = e.payload as { baseSha?: unknown } | null;
    if (p && typeof p.baseSha === "string" && /^[0-9a-f]{7,64}$/i.test(p.baseSha)) return p.baseSha;
  }
  return null;
}

/** Lesson refs (`lesson:<id>`) for a task's planned `fg:<id>` lessons. */
export const lessonRefsOf = (lessons: readonly { id: string }[] = []): Set<string> =>
  new Set(lessons.map((l) => `lesson:${l.id.replace(/^fg:/, "")}`));
