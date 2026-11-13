import { Callout, Switch } from "@factory/ui";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import type { Intake } from "../api/types.js";
import {
  REQUEST_NOTES_MAX_BYTES,
  utf8Bytes,
  type ProjectCandidate,
  type WorkFields,
} from "../api/work-types.js";
import { SkillPicker } from "../components/WorkKind.js";
import { Button, Field, inputClass, textareaClass } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

/** `https://github.com/<owner>/<repo>/pull/<n>`, optionally with a trailing path, query or hash. */
export const PR_URL =
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:\/[\w/-]*)?(?:[?#]\S*)?$/;

/** Notes and skills, sent only when set. */
function guidanceFields(notes: string, skillIds: string[]): Pick<WorkFields, "notes" | "skillIds"> {
  return {
    ...(notes.trim() ? { notes } : {}),
    ...(skillIds.length ? { skillIds } : {}),
  };
}

function NotesField(props: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  hint: string;
}) {
  const bytes = utf8Bytes(props.value);
  const over = bytes > REQUEST_NOTES_MAX_BYTES;
  return (
    <Field
      label="Notes (optional)"
      id={props.id}
      hint={`${props.hint} ${bytes} / ${REQUEST_NOTES_MAX_BYTES} bytes.`}
    >
      <textarea
        id={props.id}
        rows={3}
        aria-describedby={`${props.id}-hint`}
        aria-invalid={over || undefined}
        className={textareaClass}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Field>
  );
}

function useSkills() {
  const api = useApi();
  return useLoad(() => api.listSkills(), []);
}

/** A research question: sources to use, fact-check, notes and skills. */
export function ResearchForm({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: (intake: Intake) => void;
}) {
  const api = useApi();
  const report = useReportError();
  const skills = useSkills();
  const fg = useLoad(() => api.getProjectFeedbackGraph(projectId), [projectId], { live: false });
  const lessonsLinked =
    fg.state.status === "ready" &&
    fg.state.data.link.source !== "none" &&
    !!fg.state.data.link.projectKey;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [code, setCode] = useState(true);
  const [lessons, setLessons] = useState(false);
  const [web, setWeb] = useState(false);
  const [factCheck, setFactCheck] = useState(true);
  const [notes, setNotes] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const lessonsTouched = useRef(false);
  useEffect(() => {
    if (!lessonsTouched.current) setLessons(lessonsLinked);
  }, [lessonsLinked]);

  const reason = !title.trim()
    ? "Ask a question first."
    : !code && !(lessons && lessonsLinked) && !web
      ? "Pick at least one source."
      : utf8Bytes(notes) > REQUEST_NOTES_MAX_BYTES
        ? "Notes are too long."
        : undefined;

  return (
    <form
      aria-label="Research question"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason || busy) return;
        setBusy(true);
        api
          .createIntake({
            projectId,
            title: title.trim(),
            body,
            workKind: "research",
            research: {
              sources: { code, feedbackGraph: lessons && lessonsLinked, web },
              factCheck,
            },
            ...guidanceFields(notes, skillIds),
          })
          .then((intake) => {
            setTitle("");
            setBody("");
            setNotes("");
            setSkillIds([]);
            onCreated(intake);
          }, report)
          .finally(() => setBusy(false));
      }}
    >
      <Field label="Question" id="research-title">
        <input
          id="research-title"
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label="Background (optional)" id="research-body">
        <textarea
          id="research-body"
          rows={4}
          className={textareaClass}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <fieldset className="flex flex-col gap-2" aria-describedby="research-sources-hint">
        <legend className="mb-1 text-sm font-medium text-fg">Sources</legend>
        <SourceCheck
          id="research-src-code"
          label="Project code"
          checked={code}
          onChange={setCode}
        />
        <SourceCheck
          id="research-src-lessons"
          label="Lessons from your feedback history"
          checked={lessons && lessonsLinked}
          disabled={!lessonsLinked}
          onChange={(v) => {
            lessonsTouched.current = true;
            setLessons(v);
          }}
          description={
            lessonsLinked
              ? "Private: citations of lessons are removed when you copy the document."
              : fg.state.status === "loading"
                ? "Checking the project's lessons link…"
                : "This project is not linked to a lessons source. Link it in Project settings."
          }
        />
        <SourceCheck
          id="research-src-web"
          label="Web"
          checked={web}
          onChange={setWeb}
          description="Lets the agent search and fetch public web pages."
        />
        <p id="research-sources-hint" className="text-xs text-muted">
          Pick at least one. Every claim in the document cites one of these.
        </p>
      </fieldset>
      <Switch
        id="research-fact-check"
        label="Fact-check the document"
        description="A second agent spot-checks claims against their sources."
        checked={factCheck}
        onCheckedChange={setFactCheck}
      />
      <NotesField
        id="research-notes"
        value={notes}
        onChange={setNotes}
        hint="Extra guidance for this question only."
      />
      <LoadedSkills
        state={skills.state}
        id="research-skills"
        value={skillIds}
        onChange={setSkillIds}
      />
      <div>
        <Button
          type="submit"
          loading={busy}
          {...(!busy && reason ? { disabledReason: reason } : {})}
        >
          Ask
        </Button>
      </div>
    </form>
  );
}

function SourceCheck(props: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  description?: string;
}) {
  return (
    <div
      className="flex items-start gap-2.5"
      title={props.disabled ? props.description : undefined}
    >
      <input
        id={props.id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)] disabled:cursor-not-allowed"
        checked={props.checked}
        disabled={props.disabled}
        aria-describedby={props.description ? `${props.id}-d` : undefined}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <div className="min-w-0">
        <label htmlFor={props.id} className="text-sm text-fg">
          {props.label}
        </label>
        {props.description ? (
          <p id={`${props.id}-d`} className="text-xs text-muted">
            {props.description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LoadedSkills(props: {
  state: ReturnType<typeof useSkills>["state"];
  id: string;
  value: string[];
  onChange: (ids: string[]) => void;
  hint?: string;
}) {
  if (props.state.status === "loading")
    return (
      <p role="status" className="text-sm text-muted">
        Loading skills…
      </p>
    );
  if (props.state.status === "error")
    return <p className="text-sm text-muted">Skills could not be loaded: {props.state.error}</p>;
  return (
    <SkillPicker
      id={props.id}
      skills={props.state.data}
      value={props.value}
      onChange={props.onChange}
      {...(props.hint ? { hint: props.hint } : {})}
    />
  );
}

function candidatesOf(err: ApiError, fallback: readonly ProjectCandidate[]): ProjectCandidate[] {
  const d = err.details as
    | { candidates?: ProjectCandidate[]; projects?: ProjectCandidate[] }
    | ProjectCandidate[]
    | undefined;
  const list = Array.isArray(d) ? d : (d?.candidates ?? d?.projects);
  return list?.length ? list : [...fallback];
}

/** A GitHub PR to review locally; the server picks the project, or asks when it cannot. */
export function PrReviewForm({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: (intake: Intake) => void;
}) {
  const api = useApi();
  const report = useReportError();
  const { state } = useStore();
  const skills = useSkills();
  const guidance = useLoad(() => api.getGuidance(projectId), [projectId], { live: false });
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<ProjectCandidate[] | null>(null);
  const [pick, setPick] = useState("");
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || guidance.state.status !== "ready") return;
    seeded.current = true;
    setSkillIds(guidance.state.data.defaultSkillIds);
  }, [guidance.state]);

  const trimmed = url.trim();
  const urlInvalid = trimmed !== "" && !PR_URL.test(trimmed);
  const reason = !trimmed
    ? "Paste a pull request URL first."
    : urlInvalid
      ? "Use a github.com pull request URL."
      : candidates && !pick
        ? "Choose the project first."
        : utf8Bytes(notes) > REQUEST_NOTES_MAX_BYTES
          ? "Notes are too long."
          : undefined;

  return (
    <form
      aria-label="Review a pull request"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason || busy) return;
        setBusy(true);
        api
          .importIntake({
            url: trimmed,
            workKind: "pr_review",
            ...(candidates && pick ? { projectId: pick } : {}),
            ...guidanceFields(notes, skillIds),
          })
          .then(
            (intake) => {
              setUrl("");
              setNotes("");
              setCandidates(null);
              setPick("");
              onCreated(intake);
            },
            (err: unknown) => {
              if (err instanceof ApiError && err.code === "project_required") {
                setCandidates(candidatesOf(err, state.projects));
                setPick("");
              } else report(err);
            },
          )
          .finally(() => setBusy(false));
      }}
    >
      <Field
        label="Pull request URL"
        id="pr-url"
        hint="https://github.com/<owner>/<repo>/pull/<number>. Read with your gh login; nothing is posted until you approve."
      >
        <input
          id="pr-url"
          type="url"
          inputMode="url"
          aria-describedby={urlInvalid ? "pr-url-error pr-url-hint" : "pr-url-hint"}
          aria-invalid={urlInvalid || undefined}
          className={inputClass}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setCandidates(null);
          }}
        />
      </Field>
      {urlInvalid ? (
        <p id="pr-url-error" className="-mt-2 text-xs text-danger-fg">
          This is not a GitHub pull request URL.
        </p>
      ) : null}
      {candidates ? (
        <Callout tone="warning" title="Which project is this pull request for?">
          <Field
            label="Project"
            id="pr-project"
            hint="No registered project's git remote matches this repository."
          >
            <select
              id="pr-project"
              aria-describedby="pr-project-hint"
              className={inputClass}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">Choose a project…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </Callout>
      ) : null}
      <NotesField
        id="pr-notes"
        value={notes}
        onChange={setNotes}
        hint="What to look for in this pull request. Kept local."
      />
      <LoadedSkills
        state={skills.state}
        id="pr-skills"
        value={skillIds}
        onChange={setSkillIds}
        hint="Pre-selected with the project's default review skills."
      />
      <div>
        <Button
          type="submit"
          loading={busy}
          {...(!busy && reason ? { disabledReason: reason } : {})}
        >
          {candidates ? "Import for this project" : "Import pull request"}
        </Button>
      </div>
    </form>
  );
}
