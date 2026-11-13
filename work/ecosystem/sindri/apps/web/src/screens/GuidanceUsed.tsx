import { Disclosure, type ResearchSource } from "@factory/ui";
import type { GuidanceUsed, ResearchSourceRef } from "../api/work-types.js";
import { digestPrefix } from "../components/WorkKind.js";
import { Badge, Card, Empty } from "../components/ui.js";

/** An unknown source kind is listed as plain text (a non-http "url" renders unlinked). */
export function asDocSource(s: ResearchSourceRef): ResearchSource {
  const kind: ResearchSource["kind"] =
    s.kind === "file" ? "file" : s.kind === "lesson" ? "lesson" : "url";
  return {
    id: s.id,
    kind,
    ref: kind === "url" && s.kind !== "url" ? `${s.kind}: ${s.ref}` : s.ref,
    ...(s.title ? { title: s.title } : {}),
    ...(s.private ? { private: true } : {}),
  };
}

/** The skills and notes a delivery's briefs carried, by name and digest. */
export function GuidanceUsedCard({ guidance }: { guidance: GuidanceUsed | undefined }) {
  if (!guidance)
    return (
      <Card title="Guidance used">
        <Empty>No operator guidance was recorded for this run.</Empty>
      </Card>
    );
  const notes: [string, string | undefined, string | null][] = [
    ["Project notes", guidance.projectNotes, guidance.projectNotesDigest],
    ["Request notes", guidance.requestNotes, guidance.requestNotesDigest],
  ];
  return (
    <Card
      title="Guidance used"
      description="Skills and notes the agents were given, with the digest of the exact text."
    >
      <section aria-label="Skills used" className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">Skills</h4>
        {guidance.skills.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {guidance.skills.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <code className="text-xs text-muted">{digestPrefix(s.digest)}</code>
              </li>
            ))}
          </ul>
        )}
        {guidance.omitted?.length ? (
          <p className="text-sm text-muted">
            Left out (over the size cap): {guidance.omitted.map((s) => s.name).join(", ")}
          </p>
        ) : null}
      </section>
      <section aria-label="Notes used" className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">Notes</h4>
        <ul className="flex flex-col gap-2 text-sm">
          {notes.map(([label, text, digest]) => (
            <li key={label} className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                {label}
                {digest ? (
                  <code className="text-xs text-muted">{digestPrefix(digest)}</code>
                ) : (
                  <Badge>None</Badge>
                )}
              </span>
              {digest && text ? (
                <Disclosure title={`Show ${label.toLowerCase()}`}>
                  <pre className="font-sans text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {text}
                  </pre>
                </Disclosure>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}
