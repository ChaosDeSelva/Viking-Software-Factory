// New work for the research and PR review kinds, as in Sindri's Inbox. Both send through the
// command dialog like every other control; Sindri validates and decides the project of a PR.
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Disclosure,
  Field,
  Input,
  Select,
  Stack,
  Switch,
  Textarea,
} from "@factory/ui";
import { useEffect, useRef, useState } from "react";
import { useHeimdall } from "../app/context";
import { Reasons } from "../components/app";
import type { R } from "../lib/api";
import {
  PR_URL,
  PLAN_REFERENCES_MAX,
  PLAN_TEXT_MAX_CHARS,
  REQUEST_NOTES_MAX_BYTES,
  detectProjects,
  planBlock,
  planBody,
  kindBadge,
  lessonsLinked,
  localOnlyOf,
  prReviewBlock,
  prReviewBody,
  projectCandidates,
  researchBlock,
  researchBody,
  utf8Bytes,
  webSourceBlock,
} from "./workKinds";
import { actionBlock } from "./workflowState";

type Load<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: string };

/**
 * One Sindri read through Heimdall, again after each confirmed command and whenever `key` changes.
 * A re-read keeps showing the last answer for the same path until the new one arrives.
 */
export function useDetail<T>(
  path: string | null,
  pick: (r: R) => T,
  key = "",
): Load<T> {
  const { api, reloadKey } = useHeimdall();
  const [state, setState] = useState<{ path: string | null; load: Load<T> }>({
    path: null,
    load: { status: "loading" },
  });
  useEffect(() => {
    if (!path) return;
    let gone = false;
    setState((old) =>
      old.path === path && old.load.status === "ready"
        ? old
        : { path, load: { status: "loading" } },
    );
    api(path)
      .then(
        (r) =>
          !gone && setState({ path, load: { status: "ready", data: pick(r) } }),
      )
      .catch(
        (e) =>
          !gone &&
          setState({
            path,
            load: { status: "error", error: (e as Error).message },
          }),
      );
    return () => {
      gone = true;
    };
  }, [path, reloadKey, key]);
  return path && state.path === path ? state.load : { status: "loading" };
}

const useSkills = () =>
  useDetail<R[]>("details/skills", (r) =>
    Array.isArray(r.skills) ? r.skills : [],
  );

/**
 * A badge for the kind of an intake, run or delivery; unknown kinds read "Other". No tooltip: it
 * sits inside row buttons, where a focusable badge would nest controls.
 */
export function WorkKindBadge({ kind }: { kind: unknown }) {
  const b = kindBadge(kind);
  return (
    // Relative, so its screen-reader text cannot stretch a scrolling stage column past the page.
    <Badge tone={b.tone} className="relative">
      <span className="sr-only">Kind: </span>
      {b.text}
    </Badge>
  );
}

function NotesField({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  hint: string;
}) {
  const bytes = utf8Bytes(value);
  return (
    <Field
      label="Notes (optional)"
      hint={`${hint} ${bytes} / ${REQUEST_NOTES_MAX_BYTES} bytes.`}
      error={
        bytes > REQUEST_NOTES_MAX_BYTES
          ? `Notes are limited to ${REQUEST_NOTES_MAX_BYTES} bytes.`
          : undefined
      }
    >
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function SkillPicker({
  id,
  state,
  value,
  onChange,
  hint,
}: {
  id: string;
  state: Load<R[]>;
  value: string[];
  onChange: (ids: string[]) => void;
  hint: string;
}) {
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2"
      aria-describedby={`${id}-hint`}
    >
      <legend className="mb-1 text-sm font-medium text-fg">Skills</legend>
      {state.status === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading skills…
        </p>
      ) : state.status === "error" ? (
        <p className="text-sm text-muted">
          Skills could not be loaded: {state.error}
        </p>
      ) : state.data.length === 0 ? (
        <p className="text-sm text-muted">
          No skills imported yet. Import SKILL.md folders in Sindri under
          Settings → Skills.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {state.data.map((s) => (
            <li key={s.id}>
              <Checkbox
                id={`${id}-${s.id}`}
                checked={value.includes(s.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...value, s.id]
                      : value.filter((v) => v !== s.id),
                  )
                }
                label={
                  <span className="font-medium [overflow-wrap:anywhere]">
                    {s.name ?? s.id}
                  </span>
                }
                description={s.description || undefined}
              />
            </li>
          ))}
        </ul>
      )}
      <p id={`${id}-hint`} className="text-xs text-muted">
        {hint}
      </p>
    </fieldset>
  );
}

export function ResearchForm({ projectId }: { projectId: string }) {
  const { session, propose } = useHeimdall();
  const skills = useSkills();
  const fg = useDetail<R | null>(
    projectId ? `details/feedback-graph/${projectId}` : null,
    (r) => r,
  );
  const linked = fg.status === "ready" && lessonsLinked(fg.data);
  const github = useDetail<boolean>("details/github-status", localOnlyOf);
  const localOnly = github.status === "ready" && github.data;
  const webBlock = webSourceBlock(localOnly);
  const [question, setQuestion] = useState(""),
    [background, setBackground] = useState(""),
    [code, setCode] = useState(true),
    [lessons, setLessons] = useState(false),
    [web, setWeb] = useState(false),
    [factCheck, setFactCheck] = useState(true),
    [notes, setNotes] = useState(""),
    [skillIds, setSkillIds] = useState<string[]>([]);
  const lessonsTouched = useRef(false);
  useEffect(() => {
    if (!lessonsTouched.current) setLessons(linked);
  }, [linked]);
  const input = {
    projectId,
    question,
    background,
    code,
    lessons,
    lessonsAvailable: linked,
    web,
    localOnly,
    factCheck,
    notes,
    skillIds,
  };
  const why =
    actionBlock("intake.create", undefined, session) || researchBlock(input);
  return (
    <Stack gap={4}>
      <Field label="Question">
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} />
      </Field>
      <Field
        label="Background (optional)"
        hint={`Paste anything the agent should read: a call transcript, notes, a ticket. ${background.length.toLocaleString("en-US")} characters.`}
      >
        <Textarea
          value={background}
          rows={8}
          onChange={(e) => setBackground(e.target.value)}
        />
      </Field>
      <fieldset
        className="flex min-w-0 flex-col gap-2"
        aria-describedby="research-sources-hint"
      >
        <legend className="mb-1 text-sm font-medium text-fg">Sources</legend>
        <Checkbox
          id="research-src-code"
          label="Project code"
          checked={code}
          onChange={(e) => setCode(e.target.checked)}
        />
        <Checkbox
          id="research-src-lessons"
          label="Lessons from your feedback history"
          checked={lessons && linked}
          disabled={!linked}
          onChange={(e) => {
            lessonsTouched.current = true;
            setLessons(e.target.checked);
          }}
          description={
            linked
              ? "Private: citations of lessons are removed when you copy the document."
              : fg.status === "loading" && projectId
                ? "Checking the project's lessons link…"
                : "This project is not linked to a lessons source. Link it from the project on the Projects page first."
          }
        />
        <Checkbox
          id="research-src-web"
          label="Web"
          checked={web && !localOnly}
          disabled={localOnly}
          onChange={(e) => setWeb(e.target.checked)}
          description={
            webBlock || "Lets the agent search and fetch public web pages."
          }
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
        value={notes}
        onChange={setNotes}
        hint="Extra guidance for this question only."
      />
      <SkillPicker
        id="research-skills"
        state={skills}
        value={skillIds}
        onChange={setSkillIds}
        hint="Each selected skill's SKILL.md is given to the agent as guidance."
      />
      <div>
        <Button
          variant="primary"
          disabledReason={why || undefined}
          onClick={() =>
            propose(
              "intake.create",
              "new",
              // Saved and drafted in one step; the spec is then approved and planned in one.
              { ...researchBody(input), thenDraft: true },
              {},
              {
                onSent: () => {
                  setQuestion("");
                  setBackground("");
                  setNotes("");
                  setSkillIds([]);
                },
                onSuccess: () => {
                  setQuestion("");
                  setBackground("");
                  setNotes("");
                  setSkillIds([]);
                },
              },
            )
          }
        >
          Save and draft spec
        </Button>
      </div>
      <Reasons reasons={[why]} />
    </Stack>
  );
}

/** A GitHub pull request to review locally; Sindri picks the project, or asks when it cannot. */
export function PrReviewForm({ projectId }: { projectId: string }) {
  const { session, propose, scope, notify } = useHeimdall();
  const skills = useSkills();
  const [url, setUrl] = useState(""),
    [notes, setNotes] = useState(""),
    [skillIds, setSkillIds] = useState<string[]>([]),
    [candidates, setCandidates] = useState<
      { id: string; name: string }[] | null
    >(null),
    [pick, setPick] = useState("");
  // Defaults come from the project the import will land in: the one chosen after Sindri asked.
  const guidanceProject = pick || projectId;
  const guidance = useDetail<R | null>(
    guidanceProject ? `details/guidance/${guidanceProject}` : null,
    (r) => r.guidance ?? null,
  );
  // That project's default review skills, until the operator changes the selection.
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current || guidance.status !== "ready") return;
    const ids = guidance.data?.defaultSkillIds;
    setSkillIds(Array.isArray(ids) ? ids : []);
  }, [guidance]);
  const input = { url, notes, skillIds, candidates, pick };
  const trimmed = url.trim();
  const invalid = trimmed !== "" && !PR_URL.test(trimmed);
  const why =
    actionBlock("intake.import", undefined, session) || prReviewBlock(input);
  return (
    <Stack gap={4}>
      <Field
        label="Pull request URL"
        hint="https://github.com/<owner>/<repo>/pull/<number>. Read with your gh login; nothing is posted from Heimdall."
        error={invalid ? "This is not a GitHub pull request URL." : undefined}
      >
        <Input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setCandidates(null);
            setPick("");
          }}
        />
      </Field>
      {candidates && (
        <Callout tone="warning" title="Which project is this pull request for?">
          <Field
            label="Project for this pull request"
            hint="No single registered project's git remote matches this repository."
          >
            <Select
              value={pick}
              onValueChange={setPick}
              options={[
                { value: "", label: "Choose a project…" },
                ...candidates.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </Field>
        </Callout>
      )}
      <NotesField
        value={notes}
        onChange={setNotes}
        hint="What to look for in this pull request. Kept local."
      />
      <SkillPicker
        id="pr-skills"
        state={skills}
        value={skillIds}
        onChange={(ids) => {
          touched.current = true;
          setSkillIds(ids);
        }}
        hint="Pre-selected with the project's default review skills."
      />
      <div>
        <Button
          variant="primary"
          disabledReason={why || undefined}
          onClick={() =>
            propose(
              "intake.import",
              "new",
              prReviewBody(input),
              {},
              {
                onSuccess: () => {
                  setUrl("");
                  setNotes("");
                  setCandidates(null);
                  setPick("");
                },
                onError: (e) => {
                  if (e.code !== "project_required") return false;
                  setCandidates(
                    projectCandidates(e.details, scope.sindriProjects),
                  );
                  setPick("");
                  notify(
                    "Sindri could not tell which project this pull request is for. Choose one, then send again.",
                    "warning",
                  );
                  return true;
                },
              },
            )
          }
        >
          {candidates
            ? "Review import for this project"
            : "Review pull request import"}
        </Button>
      </div>
      <Reasons reasons={[why]} />
    </Stack>
  );
}

/**
 * A plan from pasted text: the factory researches each project the text names (the operator
 * confirms which), then writes a readable proposal and an engineering appendix.
 */
export function PlanForm({
  projectId,
  projects,
}: {
  projectId: string;
  projects: R[];
}) {
  const { session, propose } = useHeimdall();
  const skills = useSkills();
  const github = useDetail<boolean>("details/github-status", localOnlyOf);
  const localOnly = github.status === "ready" && github.data;
  const [text, setText] = useState(""),
    [title, setTitle] = useState(""),
    [web, setWeb] = useState(false),
    [factCheck, setFactCheck] = useState(true),
    [notes, setNotes] = useState(""),
    [skillIds, setSkillIds] = useState<string[]>([]),
    // Projects the operator ticked or unticked by hand win over detection.
    [picked, setPicked] = useState<Record<string, boolean>>({});
  const others = projects.filter((p) => p.id !== projectId);
  const detected = detectProjects(text, others);
  const isDetected = (id: string) => detected.some((d) => d.projectId === id);
  const ticked = (id: string) =>
    picked[id] ?? detected.some((d) => d.projectId === id && !d.weak);
  const referenceProjectIds = others
    .map((p) => String(p.id))
    .filter((id) => ticked(id));
  const input = {
    projectId,
    title,
    text,
    referenceProjectIds,
    web,
    localOnly,
    factCheck,
    notes,
    skillIds,
  };
  const why =
    actionBlock("intake.create", undefined, session) || planBlock(input);
  const clear = () => {
    setText("");
    setTitle("");
    setNotes("");
    setSkillIds([]);
    setPicked({});
  };
  const projectBox = (p: R) => {
    const d = detected.find((x) => x.projectId === p.id);
    return (
      <li key={p.id}>
        <Checkbox
          id={`plan-project-${p.id}`}
          checked={ticked(String(p.id))}
          onChange={(e) =>
            setPicked((old) => ({ ...old, [String(p.id)]: e.target.checked }))
          }
          label={<span className="font-medium">{p.name ?? p.id}</span>}
          description={
            d
              ? `Named ${d.mentions === 1 ? "once" : `${d.mentions} times`} in the text${d.weak ? ", but only by an everyday word: tick it if the text means this project" : ""}.`
              : undefined
          }
        />
      </li>
    );
  };
  return (
    <Stack gap={4}>
      <Field
        label="Text to plan from"
        hint={`Paste a call transcript, notes or a brief. ${text.length.toLocaleString("en-US")} of ${PLAN_TEXT_MAX_CHARS.toLocaleString("en-US")} characters.`}
      >
        <Textarea
          value={text}
          rows={14}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Field label="Title (optional)" hint="Defaults to the text's first line.">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <fieldset
        className="flex min-w-0 flex-col gap-2"
        aria-describedby="plan-projects-hint"
      >
        <legend className="mb-1 text-sm font-medium text-fg">
          Other projects to read
        </legend>
        <p id="plan-projects-hint" className="text-xs text-muted">
          The plan belongs to the project chosen above, and its code is always
          read. Each project ticked here is researched too, in parallel, from a
          read-only copy. Up to {PLAN_REFERENCES_MAX}.
        </p>
        {detected.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {others.filter((p) => isDetected(String(p.id))).map(projectBox)}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            {text.trim()
              ? "The text names no other project."
              : "Projects the text names will appear here."}
          </p>
        )}
        {others.some((p) => !isDetected(String(p.id))) && (
          <Disclosure title="Add another project">
            <ul className="flex flex-col gap-2">
              {others.filter((p) => !isDetected(String(p.id))).map(projectBox)}
            </ul>
          </Disclosure>
        )}
      </fieldset>
      <Checkbox
        id="plan-src-web"
        label="Let the research use the web"
        checked={web && !localOnly}
        disabled={localOnly}
        onChange={(e) => setWeb(e.target.checked)}
        description={
          webSourceBlock(localOnly) ||
          "Public web pages, for libraries and services the projects use."
        }
      />
      <Switch
        id="plan-fact-check"
        label="Fact-check the plan"
        description="A second agent checks the appendix against the code and that the proposal claims nothing it doesn't support."
        checked={factCheck}
        onCheckedChange={setFactCheck}
      />
      <NotesField
        value={notes}
        onChange={setNotes}
        hint="Extra guidance for this plan only, such as dates or who it is for."
      />
      <SkillPicker
        id="plan-skills"
        state={skills}
        value={skillIds}
        onChange={setSkillIds}
        hint="Each selected skill's SKILL.md is given to the agents as guidance."
      />
      <div>
        <Button
          variant="primary"
          disabledReason={why || undefined}
          onClick={() =>
            propose(
              "intake.create",
              "new",
              { ...planBody(input), thenDraft: true },
              {},
              { onSent: clear, onSuccess: clear },
            )
          }
        >
          Save and draft spec
        </Button>
      </div>
      <p className="text-xs text-muted">
        After the spec is approved, the plan researches every ticked project,
        then writes the proposal (sections, tickets with Ticket 0 as a spike, a
        week-by-week demo plan and diagrams) and its engineering appendix.
      </p>
      <Reasons reasons={[why]} />
    </Stack>
  );
}
