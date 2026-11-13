import type { SkillSummary, WorkKind } from "../api/work-types.js";
import { Badge, Empty } from "./ui.js";

const LABELS: Record<WorkKind, { text: string; tone: "neutral" | "info" | "ok"; hint: string }> = {
  change: { text: "Change", tone: "neutral", hint: "A code change delivered as a patch" },
  research: { text: "Research", tone: "info", hint: "A research document with cited sources" },
  pr_review: { text: "PR review", tone: "ok", hint: "A local review of a GitHub pull request" },
};

export const isWorkKind = (k: unknown): k is WorkKind =>
  typeof k === "string" && Object.hasOwn(LABELS, k);

/** `kind` absent means a record from before work kinds (a change); unknown values show "Other". */
export function WorkKindBadge({ kind, tooltip = true }: { kind: unknown; tooltip?: boolean }) {
  const k = kind ?? "change";
  const known = isWorkKind(k) ? LABELS[k] : null;
  return (
    <Badge
      tone={known?.tone ?? "neutral"}
      {...(tooltip
        ? { tooltip: known?.hint ?? `A kind of work this version does not know (${String(k)})` }
        : {})}
    >
      {known?.text ?? "Other"}
    </Badge>
  );
}

const digestPrefix = (d: string) => d.replace(/^sha256:/, "").slice(0, 12);
export { digestPrefix };

/** Multi-select of library skills as a checkbox group. */
export function SkillPicker(props: {
  id: string;
  skills: readonly SkillSummary[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  legend?: string;
  hint?: string;
}) {
  const legend = props.legend ?? "Skills";
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={`${props.id}-hint`}>
      <legend className="mb-1 text-sm font-medium text-fg">{legend}</legend>
      {props.skills.length === 0 ? (
        <Empty body="Import SKILL.md folders under Settings → Skills.">
          No skills imported yet.
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {props.skills.map((s) => {
            const id = `${props.id}-${s.id}`;
            const checked = props.value.includes(s.id);
            return (
              <li key={s.id} className="flex items-start gap-2.5">
                <input
                  id={id}
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                  checked={checked}
                  onChange={(e) =>
                    props.onChange(
                      e.target.checked
                        ? [...props.value, s.id]
                        : props.value.filter((v) => v !== s.id),
                    )
                  }
                />
                <label htmlFor={id} className="min-w-0 text-sm [overflow-wrap:anywhere]">
                  <span className="font-medium">{s.name}</span>
                  {s.description ? <span className="text-muted"> · {s.description}</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <p id={`${props.id}-hint`} className="text-xs text-muted">
        {props.hint ?? "Each selected skill's SKILL.md is given to the agent as guidance."}
      </p>
    </fieldset>
  );
}
