import { StickyActionBar } from "@factory/ui";
import { useEffect, useRef, useState } from "react";
import type { Project } from "../api/types.js";
import { PROJECT_NOTES_MAX_BYTES, utf8Bytes, type ProjectGuidance } from "../api/work-types.js";
import { SkillPicker } from "../components/WorkKind.js";
import { Button, Card, Field, LoadState, textareaClass } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

interface Form {
  notes: string;
  defaultSkillIds: string[];
}
const formOf = (g: ProjectGuidance): Form => ({
  notes: g.notes,
  defaultSkillIds: g.defaultSkillIds,
});
const same = (a: Form, b: Form) =>
  a.notes === b.notes && a.defaultSkillIds.join("\n") === b.defaultSkillIds.join("\n");

/** Standing review notes and default skills that every brief of this project carries. */
export function GuidanceCard({ project }: { project: Project }) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const guidance = useLoad(() => api.getGuidance(project.id), [project.id]);
  const skills = useLoad(() => api.listSkills(), []);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  // A live refresh replaces the form only while it still equals what it was seeded from.
  const seeded = useRef<Form | null>(null);
  useEffect(() => {
    if (guidance.state.status !== "ready") return;
    const next = formOf(guidance.state.data);
    const prev = seeded.current;
    seeded.current = next;
    setForm((f) => (f === null || (prev && same(f, prev)) ? next : f));
  }, [guidance.state]);

  const bytes = form ? utf8Bytes(form.notes) : 0;
  const over = bytes > PROJECT_NOTES_MAX_BYTES;
  const reason = over
    ? "The notes are over 16 KB."
    : form && seeded.current && same(form, seeded.current)
      ? "No changes to save."
      : undefined;

  return (
    <Card
      title="Guidance"
      description="Given to every research and review brief of this project, next to each request's own notes and skills."
    >
      <LoadState state={guidance.state} what="guidance" onRetry={guidance.reload}>
        {() =>
          form ? (
            <form
              aria-label="Project guidance"
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (reason || busy) return;
                setBusy(true);
                api
                  .putGuidance(project.id, form)
                  .then((saved) => {
                    const next = formOf(saved);
                    seeded.current = next;
                    setForm(next);
                    dispatch({
                      type: "notice",
                      notice: { kind: "info", text: "Guidance saved" },
                    });
                  }, report)
                  .finally(() => setBusy(false));
              }}
            >
              <Field
                label="Standing review notes"
                id="guidance-notes"
                hint={`What reviewers and researchers should always keep in mind for this project. ${bytes} / ${PROJECT_NOTES_MAX_BYTES} bytes.`}
              >
                <textarea
                  id="guidance-notes"
                  rows={8}
                  aria-describedby="guidance-notes-hint"
                  aria-invalid={over || undefined}
                  className={textareaClass}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </Field>
              {skills.state.status === "ready" ? (
                <SkillPicker
                  id="guidance-skills"
                  legend="Default skills"
                  hint="Pre-selected for every pull request review of this project."
                  skills={skills.state.data}
                  value={form.defaultSkillIds}
                  onChange={(defaultSkillIds) => setForm({ ...form, defaultSkillIds })}
                />
              ) : skills.state.status === "error" ? (
                <p className="text-sm text-muted">
                  Skills could not be loaded: {skills.state.error}
                </p>
              ) : (
                <p role="status" className="text-sm text-muted">
                  Loading skills…
                </p>
              )}
              <StickyActionBar status="Saved guidance applies to new briefs only.">
                <Button
                  type="submit"
                  loading={busy}
                  {...(!busy && reason ? { disabledReason: reason } : {})}
                >
                  Save guidance
                </Button>
              </StickyActionBar>
            </form>
          ) : null
        }
      </LoadState>
    </Card>
  );
}
