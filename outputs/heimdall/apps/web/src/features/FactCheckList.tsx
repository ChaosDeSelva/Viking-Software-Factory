// A fact-check's findings as a readable list: each finding's long prose gets the full width,
// with its severity and a short location above it and its "Fix:" set apart.
import { Badge, SeverityBadge, sortFindings, type Finding } from "@factory/ui";
import type { ReactNode } from "react";
import { findingParts, shortLocation } from "./workKinds";

/** `like this` as inline code; the rest as text. */
function withCode(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code
        key={i}
        className="rounded bg-surface-2 px-1 font-mono text-[0.85em] [overflow-wrap:anywhere]"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

export function FactCheckList({
  findings,
  caption,
  emptyText,
}: {
  findings: readonly Finding[];
  caption: string;
  emptyText: string;
}) {
  if (findings.length === 0) return <p className="text-sm text-muted">{emptyText}</p>;
  return (
    <ol aria-label={caption} className="flex flex-col gap-3">
      {sortFindings(findings).map((f) => {
        const { problem, fix } = findingParts(f.message);
        const where = shortLocation(f);
        return (
          <li
            key={f.id}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={f.severity} />
              {where && (
                <Badge>
                  <span className="font-mono" title={where.full}>
                    {where.short}
                  </span>
                </Badge>
              )}
              {f.category && <span className="text-xs text-muted">{f.category}</span>}
            </div>
            <p className="text-sm leading-relaxed [overflow-wrap:anywhere]">{withCode(problem)}</p>
            {fix && (
              <p className="border-l-2 border-border pl-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
                <span className="font-semibold">Fix: </span>
                {withCode(fix)}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
