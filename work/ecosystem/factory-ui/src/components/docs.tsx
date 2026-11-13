import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "../icons.js";
import { cn, focusRing, headingSlug, Link } from "../lib.js";
import { ArchitectureDiagram } from "./architecture.js";
import { Button } from "./controls.js";
import { Badge } from "./status.js";

/* ------------------------------------------------------------------ Markdown */

const SAFE_HREF = /^(https?:|mailto:|\/|#|\.{1,2}\/|[^:]*$)/i;
const safeHref = (href: string) => (SAFE_HREF.test(href.trim()) ? href.trim() : undefined);

const INLINE_CODE = "`[^`]+`";
/** Opening code fence (``` or ~~~, 3+) at the start of a line: returns the fence run. */
const fenceOpen = (line: string) => /^(`{3,}|~{3,})/.exec(line)?.[1];
/** A closing fence uses the opening character, at least as many times, and nothing else. */
const fenceCloses = (line: string, open: string) =>
  new RegExp(`^${open[0] === "`" ? "`" : "~"}{${open.length},}\\s*$`).test(line);

/** Per line: inside a fenced code block (fence lines included), as `Markdown` parses them. */
function codeMask(lines: readonly string[]): boolean[] {
  let open: string | undefined;
  return lines.map((l) => {
    if (open) {
      if (fenceCloses(l, open)) open = undefined;
      return true;
    }
    open = fenceOpen(l);
    return Boolean(open);
  });
}

/** Inline: `code`, **bold**, *em* / _em_, [text](href). Never injects HTML. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(
    String.raw`(${INLINE_CODE})|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)`,
    "g",
  );
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) {
      const [, label = "", rawHref = ""] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok) ?? [];
      const href = safeHref(rawHref);
      const external = href ? /^https?:/i.test(href) : false;
      out.push(
        href ? (
          external ? (
            <a key={k} href={href} target="_blank" rel="noreferrer noopener">
              {inline(label, k)}
            </a>
          ) : (
            <Link key={k} href={href}>
              {inline(label, k)}
            </Link>
          )
        ) : (
          label
        ),
      );
    } else out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Unique heading anchor: `headingSlug`, with repeats getting `-1`, `-2` as `@factory/docs` does. */
function headingId(text: string, seen: Map<string, number>): string {
  const base = headingSlug(text);
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

/** Small, safe Markdown renderer for docs and guide answers (no raw HTML). */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const anchors = new Map<string, number>();
  const isBlockStart = (l: string) =>
    /^(#{1,6}\s|```|~~~|>\s?|\s*([-*]|\d+\.)\s|\||---+\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${n++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const lang = line.slice(fence.length).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !fenceCloses(lines[i]!, fence)) body.push(lines[i++]!);
      i++;
      if (lang === "factory-architecture") {
        blocks.push(<ArchitectureDiagram key={key} />);
        continue;
      }
      blocks.push(
        <pre key={key}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1]!.length, 4) as 1 | 2 | 3 | 4;
      const H = `h${level}` as const;
      blocks.push(
        <H key={key} id={headingId(h[2]!, anchors)}>
          {inline(h[2]!, key)}
        </H>,
      );
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      blocks.push(<hr key={key} className="border-line" />);
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">"))
        body.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(body.join(" "), key)}</blockquote>);
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1] && /^\s*\|?\s*:?-+/.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!));
      blocks.push(
        <table key={key}>
          <thead>
            <tr>
              {head.map((c, j) => (
                <th key={j}>{inline(c, `${key}h${j}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, j) => (
                  <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const list = /^\s*([-*]|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]!);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
        let item = lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, "");
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]!) &&
          !/^\s*([-*]|\d+\.)\s/.test(lines[i]!)
        )
          item += ` ${lines[i++]!.trim()}`;
        items.push(item);
      }
      const L = ordered ? "ol" : "ul";
      blocks.push(
        <L key={key}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${key}-${j}`)}</li>
          ))}
        </L>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !isBlockStart(lines[i]!)))
      para.push(lines[i++]!);
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return <div className={cn("fui-markdown text-md leading-relaxed", className)}>{blocks}</div>;
}

/* --------------------------------------------------------------- ResearchDoc */

export interface ResearchSource {
  id: string;
  kind: "file" | "url" | "lesson";
  ref: string;
  title?: string | undefined;
  private?: boolean | undefined;
}

export interface ResearchDocProps {
  markdown: string;
  /** Citation `[n]` refers to the source with id `n` (see `citationNumber`). */
  sources: readonly ResearchSource[];
  /** Omit private and lesson sources, and their citations, e.g. for a shared view. */
  hidePrivate?: boolean | undefined;
  fileHref?: ((ref: string) => string | undefined) | undefined;
  className?: string | undefined;
}

export const isPrivateSource = (s: ResearchSource) => s.private === true || s.kind === "lesson";

/** `[n]` cites the source whose id is `n`; a non-numeric id falls back to its 1-based position. */
export const citationNumber = (s: ResearchSource, index: number) =>
  /^[1-9]\d*$/.test(s.id) ? Number(s.id) : index + 1;

const SOURCES_HEADING = /^(#{1,6})\s+(?:sources|references|bibliography)\b/i;
const HEADING = /^(#{1,6})\s/;
const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
// Not after a word, `]` or `)` (so `items[3]` and `[a][1]` stay); not a `[n](url)` link.
const CITATION_RUN = /(\s*)(?<![\w\])])((?:\[\d+(?:\s*,\s*\d+)*\](?!\())+)/g;

const finish = (out: string[], original: string) => {
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out.join("\n") + (/\n$/.test(original) && out.length ? "\n" : "");
};

/**
 * Remove the last "Sources" / "References" / "Bibliography" heading section (to the next heading
 * of the same or a higher level). `ResearchDoc` lists sources itself.
 */
export function withoutSourcesSection(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const code = codeMask(lines);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (!code[i] && SOURCES_HEADING.test(lines[i]!)) start = i;
  if (start < 0) return markdown;
  const level = SOURCES_HEADING.exec(lines[start]!)![1]!.length;
  let end = start + 1;
  while (
    end < lines.length &&
    !(!code[end] && (HEADING.exec(lines[end]!)?.[1]?.length ?? 7) <= level)
  )
    end++;
  if (end < lines.length) return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  return finish(lines.slice(0, start), markdown);
}

/**
 * For copying or sharing: drop the Markdown's own Sources section, `[n]` citations of
 * private/lesson sources outside code (`[1, 3]` → `[1]`), and their `[n]: …` definitions.
 * Numbers are not renumbered.
 */
export function stripPrivateCitations(
  markdown: string,
  sources: readonly ResearchSource[],
): string {
  const doc = withoutSourcesSection(markdown);
  const hidden = new Set(
    sources.flatMap((s, i) => (isPrivateSource(s) ? [citationNumber(s, i)] : [])),
  );
  if (!hidden.size) return doc;
  const lines = doc.replace(/\r\n?/g, "\n").split("\n");
  const code = codeMask(lines);

  // A run like `[1][3]` is one citation: drop the space before it only if all of it goes.
  const strip = (text: string) =>
    text.replace(CITATION_RUN, (_match, ws: string, run: string) => {
      const kept = run.replace(MARKER, (m: string, list: string) => {
        const nums = list.split(",").map((n) => n.trim());
        const keep = nums.filter((n) => !hidden.has(Number(n)));
        if (keep.length === nums.length) return m;
        return keep.length ? `[${keep.join(", ")}]` : "";
      });
      return kept ? ws + kept : "";
    });

  const out: string[] = [];
  lines.forEach((line, i) => {
    if (code[i]) return out.push(line);
    const def = /^\s*\[(\d+)\]:\s/.exec(line);
    if (def && hidden.has(Number(def[1]))) return;
    // Odd parts are inline code spans and stay as written.
    out.push(
      line
        .split(new RegExp(`(${INLINE_CODE})`))
        .map((part, j) => (j % 2 ? part : strip(part)))
        .join(""),
    );
  });
  return out.join("\n");
}

function SourceEntry({
  source: s,
  fileHref,
}: {
  source: ResearchSource;
  fileHref?: ((ref: string) => string | undefined) | undefined;
}) {
  const linkClass = cn("text-accent-fg hover:underline [overflow-wrap:anywhere]", focusRing);
  if (s.kind === "lesson")
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Badge tone="forest">Private lesson</Badge>
        <span className="[overflow-wrap:anywhere]">{s.title ?? s.ref}</span>
      </span>
    );
  const privateBadge = s.private ? <Badge>Private</Badge> : null;
  if (s.kind === "file") {
    const raw = fileHref?.(s.ref);
    const href = raw ? safeHref(raw) : undefined;
    const ref = <code className="[overflow-wrap:anywhere]">{s.ref}</code>;
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        {s.title && <span>{s.title}</span>}
        {href ? (
          <Link href={href} className={linkClass}>
            {ref}
          </Link>
        ) : (
          ref
        )}
        {privateBadge}
      </span>
    );
  }
  const href = /^https?:\/\/[^/\s]/i.test(s.ref.trim()) ? s.ref.trim() : undefined;
  const label = s.title ?? s.ref;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className={linkClass}>
          {label}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="[overflow-wrap:anywhere]">{label}</span>
      )}
      {s.title && <span className="text-xs text-muted [overflow-wrap:anywhere]">{s.ref}</span>}
      {privateBadge}
    </span>
  );
}

/** A research write-up: safe Markdown, then the numbered sources its `[n]` citations point to. */
export function ResearchDoc({
  markdown,
  sources,
  hidePrivate = false,
  fileHref,
  className,
}: ResearchDocProps) {
  const headingId = useId();
  const listed = sources
    .map((source, i) => ({ source, n: citationNumber(source, i) }))
    .filter(({ source }) => !(hidePrivate && isPrivateSource(source)))
    .sort((a, b) => a.n - b.n);
  return (
    <div className={cn("flex min-w-0 flex-col gap-6", className)}>
      <Markdown
        source={
          hidePrivate ? stripPrivateCitations(markdown, sources) : withoutSourcesSection(markdown)
        }
      />
      {listed.length > 0 && (
        <section aria-labelledby={headingId} className="border-t border-line pt-4">
          <h2 id={headingId} className="text-md font-semibold">
            Sources
          </h2>
          <ol className="mt-2 flex list-decimal flex-col gap-2 pl-6 text-sm">
            {listed.map(({ source, n }) => (
              <li key={source.id} value={n}>
                <SourceEntry source={source} fileHref={fileHref} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ DocsView */

export interface DocsSection {
  title: string;
  pages: readonly { slug: string; title: string }[];
}

/** Docs page inside the app shell: table of contents left (a disclosure ≤768px), article right. */
export function DocsView({
  sections,
  activeSlug,
  hrefFor,
  children,
  markdown,
  title = "Docs",
}: {
  sections: readonly DocsSection[];
  activeSlug: string;
  hrefFor: (slug: string) => string;
  /** Rendered content; or pass `markdown`. */
  children?: ReactNode | undefined;
  markdown?: string | undefined;
  title?: string | undefined;
}) {
  const activeTitle = sections.flatMap((s) => s.pages).find((p) => p.slug === activeSlug)?.title;
  const toc = (
    <nav aria-label={`${title} contents`} className="flex flex-col gap-5">
      {sections.map((s) => (
        <div key={s.title} className="flex flex-col gap-1">
          <p className="px-3 text-xs font-semibold tracking-wide text-muted uppercase">{s.title}</p>
          <ul className="flex flex-col">
            {s.pages.map((p) => {
              const active = p.slug === activeSlug;
              return (
                <li key={p.slug}>
                  <Link
                    href={hrefFor(p.slug)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-accent-soft font-medium text-accent-fg"
                        : "text-muted hover:bg-hover hover:text-fg",
                      focusRing,
                    )}
                  >
                    {p.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
  return (
    <div className="grid min-w-0 gap-6 md:grid-cols-[240px_minmax(0,1fr)] md:gap-10">
      <aside className="md:sticky md:top-[calc(var(--topbar-height)+24px)] md:max-h-[calc(100dvh-var(--topbar-height)-var(--bottombar-height)-48px)] md:self-start md:overflow-y-auto">
        <details className="group rounded-md border border-line bg-surface md:hidden">
          <summary
            className={cn(
              "flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden",
              focusRing,
            )}
          >
            <span>
              <span className="text-muted">Contents · </span>
              {activeTitle}
            </span>
            <Icon name="chevronDown" className="transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-line py-3">{toc}</div>
        </details>
        <div className="hidden md:block">{toc}</div>
      </aside>
      <article className="min-w-0">
        {markdown != null ? <Markdown source={markdown} /> : children}
      </article>
    </div>
  );
}

/* ----------------------------------------------------------------- GuideChat */

export interface GuideAnswer {
  answer: string;
  links: readonly { label: string; href: string }[];
}
interface Message {
  id: number;
  role: "user" | "guide";
  text: string;
  links?: GuideAnswer["links"] | undefined;
  error?: boolean | undefined;
}

/**
 * Read-only "Guide" chat (not the Director): asks the docs-backed endpoint and shows answers
 * with links. It never performs actions; answers point to where in the UI to act.
 */
export function GuideChat<C>({
  ask,
  context,
  suggestions = [],
  title = "Ask the guide",
  intro = "Ask what something means or what to do next. The guide reads the docs and this project's state; it cannot make changes.",
  maxLength = 2000,
  className,
}: {
  ask: (question: string, context: C) => Promise<GuideAnswer>;
  context: C;
  suggestions?: readonly string[] | undefined;
  title?: string | undefined;
  intro?: ReactNode | undefined;
  maxLength?: number | undefined;
  className?: string | undefined;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const nextId = useRef(1);
  const inputId = useId();
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [messages, pending]);

  const send = async (question: string) => {
    const q = question.trim().slice(0, maxLength);
    if (!q || pending) return;
    setDraft("");
    setMessages((m) => [...m, { id: nextId.current++, role: "user", text: q }]);
    setPending(true);
    try {
      const res = await ask(q, context);
      setMessages((m) => [
        ...m,
        { id: nextId.current++, role: "guide", text: res.answer, links: res.links },
      ]);
    } catch (err) {
      const reason =
        err instanceof Error && err.message ? err.message : "The guide is unavailable.";
      setMessages((m) => [
        ...m,
        {
          id: nextId.current++,
          role: "guide",
          text: `${reason} Try again in a moment.`,
          error: true,
        },
      ]);
    } finally {
      setPending(false);
    }
  };
  const lastQuestion = [...messages].reverse().find((m) => m.role === "user")?.text;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  return (
    <section aria-label={title} className={cn("flex min-h-0 min-w-0 flex-col gap-4", className)}>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-forest-soft text-forest">
          <Icon name="guide" size={18} />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted">{intro}</p>
        </div>
      </div>

      {messages.length === 0 && suggestions.length > 0 && (
        <ul aria-label="Suggested questions" className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => void send(s)}
                className={cn(
                  "rounded-full border border-line bg-surface px-3 py-1.5 text-left text-sm text-fg transition-colors hover:border-line-strong hover:bg-hover",
                  focusRing,
                )}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}

      {(messages.length > 0 || pending) && (
        <div
          ref={log}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          className="flex max-h-[480px] min-h-0 flex-col gap-3 overflow-y-auto"
        >
          {messages.map((m) =>
            m.role === "user" ? (
              <div
                key={m.id}
                className="ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-accent-soft px-3.5 py-2.5 text-sm text-fg"
              >
                <span className="sr-only">You asked: </span>
                {m.text}
              </div>
            ) : (
              <div
                key={m.id}
                className={cn(
                  "max-w-[95%] rounded-lg rounded-bl-sm border px-4 py-3",
                  m.error ? "border-danger-border bg-danger-bg" : "border-line bg-surface",
                )}
              >
                <span className="sr-only">Guide: </span>
                {m.error ? (
                  <div className="flex flex-col items-start gap-2 text-sm">
                    <p className="text-danger-fg">{m.text}</p>
                    {lastQuestion && (
                      <Button size="sm" icon="refresh" onClick={() => void send(lastQuestion)}>
                        Retry
                      </Button>
                    )}
                  </div>
                ) : (
                  <Markdown source={m.text} className="text-sm" />
                )}
                {m.links && m.links.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                    {m.links.map((l) => (
                      <li key={l.href + l.label}>
                        <Link
                          href={l.href}
                          className={cn(
                            "inline-flex items-center gap-1 text-sm font-medium text-accent-fg hover:underline",
                            focusRing,
                          )}
                        >
                          {l.label}
                          <Icon name="arrowRight" size={14} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ),
          )}
          {pending && (
            <div role="status" className="flex items-center gap-2 text-sm text-muted">
              <span className="flex gap-1" aria-hidden>
                <span className="fui-pulse size-1.5 rounded-full bg-current" />
                <span className="fui-pulse size-1.5 rounded-full bg-current [animation-delay:200ms]" />
                <span className="fui-pulse size-1.5 rounded-full bg-current [animation-delay:400ms]" />
              </span>
              The guide is looking this up…
            </div>
          )}
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="sr-only">
          Your question
        </label>
        <div className="flex items-end gap-2 rounded-md border border-line bg-sunken p-1.5 focus-within:border-focus">
          <textarea
            id={inputId}
            rows={1}
            value={draft}
            maxLength={maxLength}
            placeholder="Ask a question…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft);
              }
            }}
            className="max-h-32 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-fg placeholder:text-subtle focus:outline-none"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon="send"
            loading={pending}
            disabled={!draft.trim()}
          >
            Ask
          </Button>
        </div>
        <p className="flex justify-between text-xs text-muted">
          <span>Enter to send · Shift+Enter for a new line</span>
          {draft.length > maxLength * 0.8 && (
            <span>
              {draft.length}/{maxLength}
            </span>
          )}
        </p>
      </form>
    </section>
  );
}
