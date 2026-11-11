import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "../icons.js";
import { cn, focusRing, Link } from "../lib.js";
import { Button } from "./controls.js";
import { glossarySlug } from "./overlay.js";

/* ------------------------------------------------------------------ Markdown */

const SAFE_HREF = /^(https?:|mailto:|\/|#|\.{1,2}\/|[^:]*$)/i;
const safeHref = (href: string) => (SAFE_HREF.test(href.trim()) ? href.trim() : undefined);

/** Inline: `code`, **bold**, *em* / _em_, [text](href). Never injects HTML. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
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

/** Small, safe Markdown renderer for docs and guide answers (no raw HTML). */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const isBlockStart = (l: string) => /^(#{1,6}\s|```|>\s?|\s*([-*]|\d+\.)\s|\||---+\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${n++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
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
        <H key={key} id={glossarySlug(h[2]!)}>
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
      <article className="min-w-0 max-w-[72ch]">
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
