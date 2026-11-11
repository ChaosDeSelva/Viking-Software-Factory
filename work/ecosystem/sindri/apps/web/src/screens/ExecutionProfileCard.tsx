import { useState, type ReactNode } from "react";
import { ApiError } from "../api/client.js";
import {
  newCheckRow,
  newEnvRow,
  parseArgv,
  problemsOf,
  toForm,
  toProfile,
  type CheckRow,
  type EnvRow,
  type ProfileForm,
  type ProfileProblems,
} from "../api/profile-form.js";
import type { ExecutionProfile, Project } from "../api/types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { Badge, Button, Card, Field, inputClass, LoadState } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

/** A project's execution profile: its checks and what checks and agents need from this machine. */
export function ExecutionProfileCard({ project }: { project: Project }) {
  const api = useApi();
  const loaded = useLoad(() => api.getProfile(project.id), [project.id]);
  return (
    <Card title="Execution profile">
      <p className="text-sm">
        How <strong>{project.name}</strong> is checked and what its tools need. The checks are the
        commands that decide whether work on this project passes. The other settings say what the
        checks and the agents need from this machine: environment variables, directories on PATH,
        directories an agent may write to, and network access.
      </p>
      <LoadState state={loaded.state} what="execution profile" onRetry={loaded.reload}>
        {(profile) => (
          <ProfileEditor projectId={project.id} initial={profile} onReset={loaded.reload} />
        )}
      </LoadState>
    </Card>
  );
}

/** The server's validation issues (`[{ path, message }]`) as lines; other shapes give none. */
function issueLines(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((d: unknown) => {
    if (typeof d !== "object" || d === null) return [];
    const { path, message } = d as { path?: unknown; message?: unknown };
    if (typeof message !== "string") return [];
    const where = Array.isArray(path) ? path.map(String).join(".") : "";
    return [where ? `${where}: ${message}` : message];
  });
}

function Problem({ id, text }: { id: string; text: string | undefined }) {
  return text ? (
    <p id={id} className="text-xs text-red-800 dark:text-red-300">
      {text}
    </p>
  ) : null;
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
      <h3 className="font-semibold">{props.title}</h3>
      {props.children}
    </section>
  );
}

function ProfileEditor(props: {
  projectId: string;
  initial: ExecutionProfile;
  onReset: () => void;
}) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const [form, setForm] = useState<ProfileForm>(() => toForm(props.initial));
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [harness, setHarness] = useState<{ name: string; version: string } | null>(null);
  const [, setUnlockTick] = useState(0);

  const found = problemsOf(form);
  // Shown once a save was tried, so a row just added is not marked wrong while it is typed.
  const problems: ProfileProblems = attempted ? found : { checks: {}, env: {}, count: 0 };
  const set = (patch: Partial<ProfileForm>) => setForm((f) => ({ ...f, ...patch }));
  const setCheck = (key: number, patch: Partial<CheckRow>) =>
    setForm((f) => ({
      ...f,
      checks: f.checks.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    }));
  const setEnv = (key: number, patch: Partial<EnvRow>) =>
    setForm((f) => ({ ...f, env: f.env.map((e) => (e.key === key ? { ...e, ...patch } : e)) }));

  const save = () => {
    setAttempted(true);
    if (found.count > 0) return;
    setBusy(true);
    setIssues([]);
    api
      .putProfile(props.projectId, toProfile(form))
      .then(
        (res) => {
          setForm(toForm(res.profile));
          setHarness(res.harness);
          setAttempted(false);
          dispatch({ type: "notice", notice: { kind: "info", text: "Execution profile saved" } });
        },
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 422) setIssues(issueLines(e.details));
          report(e);
        },
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <form
        aria-label="Execution profile"
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Section title="Checks">
          {form.checks.length === 0 ? (
            <p className="text-sm">
              No checks set: plans use the built-in checks, which assume a Node project.
            </p>
          ) : null}
          {form.checks.map((row, i) => {
            const id = `profile-check-${row.key}`;
            const p = problems.checks[row.key] ?? {};
            const parsed = parseArgv(row.command);
            return (
              <fieldset
                key={row.key}
                className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-700"
              >
                <legend className="px-1 text-sm font-medium">
                  Check {i + 1} {row.title ? <Badge>{row.title}</Badge> : null}
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Id" id={`${id}-id`} hint="Lowercase letters, digits, . _ -">
                    <input
                      id={`${id}-id`}
                      aria-describedby={`${id}-id-hint ${id}-id-error`}
                      aria-invalid={p.id ? true : undefined}
                      className={`${inputClass} font-mono`}
                      value={row.id}
                      onChange={(e) => setCheck(row.key, { id: e.target.value })}
                    />
                    <Problem id={`${id}-id-error`} text={p.id} />
                  </Field>
                  <Field
                    label="Working directory"
                    id={`${id}-cwd`}
                    hint="Optional. Relative to the repository root."
                  >
                    <input
                      id={`${id}-cwd`}
                      aria-describedby={`${id}-cwd-hint ${id}-cwd-error`}
                      aria-invalid={p.cwd ? true : undefined}
                      className={`${inputClass} font-mono`}
                      value={row.cwd}
                      onChange={(e) => setCheck(row.key, { cwd: e.target.value })}
                    />
                    <Problem id={`${id}-cwd-error`} text={p.cwd} />
                  </Field>
                </div>
                <Field
                  label="Command"
                  id={`${id}-command`}
                  hint="Run directly, not through a shell: no pipes, variables or &&. Use quotes for an argument that contains spaces."
                >
                  <input
                    id={`${id}-command`}
                    aria-describedby={`${id}-command-hint ${id}-command-argv ${id}-command-error`}
                    aria-invalid={p.command ? true : undefined}
                    className={`${inputClass} font-mono`}
                    value={row.command}
                    onChange={(e) => setCheck(row.key, { command: e.target.value })}
                  />
                  {parsed.argv.length > 0 ? (
                    <p id={`${id}-command-argv`} className="text-xs">
                      Will run: <code className="break-all">{JSON.stringify(parsed.argv)}</code>
                    </p>
                  ) : null}
                  <Problem id={`${id}-command-error`} text={p.command} />
                </Field>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-40">
                    <Field
                      label="Timeout (seconds)"
                      id={`${id}-timeout`}
                      hint="Optional. 600 if empty."
                    >
                      <input
                        id={`${id}-timeout`}
                        inputMode="numeric"
                        aria-describedby={`${id}-timeout-hint ${id}-timeout-error`}
                        aria-invalid={p.timeout ? true : undefined}
                        className={inputClass}
                        value={row.timeoutSeconds}
                        onChange={(e) => setCheck(row.key, { timeoutSeconds: e.target.value })}
                      />
                      <Problem id={`${id}-timeout-error`} text={p.timeout} />
                    </Field>
                  </div>
                  <label
                    className="flex items-center gap-2 pb-2 text-sm"
                    htmlFor={`${id}-required`}
                  >
                    <input
                      id={`${id}-required`}
                      type="checkbox"
                      checked={row.required}
                      onChange={(e) => setCheck(row.key, { required: e.target.checked })}
                    />
                    Required
                  </label>
                  <Button
                    variant="secondary"
                    className="mb-1"
                    onClick={() => set({ checks: form.checks.filter((c) => c.key !== row.key) })}
                  >
                    Remove <span className="sr-only">check {i + 1}</span>
                  </Button>
                </div>
              </fieldset>
            );
          })}
          <Button
            variant="secondary"
            onClick={() => set({ checks: [...form.checks, newCheckRow()] })}
          >
            Add check
          </Button>
        </Section>

        <Section title="Check network">
          <Field
            label="Network for checks"
            id="profile-network"
            hint="Deny points the checks' proxy settings at an unreachable address. It is not a sandbox."
          >
            <select
              id="profile-network"
              aria-describedby="profile-network-hint"
              className={inputClass}
              value={form.network}
              onChange={(e) => set({ network: e.target.value === "allow" ? "allow" : "deny" })}
            >
              <option value="deny">Deny</option>
              <option value="allow">Allow</option>
            </select>
          </Field>
        </Section>

        <Section title="Environment variables">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Variables the checks and the agents need. Do not put credentials here.
          </p>
          {form.env.map((row, i) => {
            const id = `profile-env-${row.key}`;
            return (
              <div key={row.key} className="space-y-1">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-56">
                    <Field label={`Variable ${i + 1} name`} id={`${id}-name`}>
                      <input
                        id={`${id}-name`}
                        aria-describedby={`${id}-error`}
                        aria-invalid={problems.env[row.key] ? true : undefined}
                        className={`${inputClass} font-mono`}
                        value={row.name}
                        onChange={(e) => setEnv(row.key, { name: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="min-w-0 flex-1">
                    <Field label={`Variable ${i + 1} value`} id={`${id}-value`}>
                      <input
                        id={`${id}-value`}
                        className={`${inputClass} font-mono`}
                        value={row.value}
                        onChange={(e) => setEnv(row.key, { value: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => set({ env: form.env.filter((e) => e.key !== row.key) })}
                  >
                    Remove <span className="sr-only">variable {i + 1}</span>
                  </Button>
                </div>
                <Problem id={`${id}-error`} text={problems.env[row.key]} />
              </div>
            );
          })}
          <Button variant="secondary" onClick={() => set({ env: [...form.env, newEnvRow()] })}>
            Add variable
          </Button>
        </Section>

        <Section title="PATH additions">
          <Field
            label="Directories put first on PATH"
            id="profile-path"
            hint="One absolute directory per line."
          >
            <textarea
              id="profile-path"
              rows={3}
              aria-describedby="profile-path-hint profile-path-error"
              aria-invalid={problems.pathPrepend ? true : undefined}
              className={`${inputClass} font-mono`}
              value={form.pathPrepend}
              onChange={(e) => set({ pathPrepend: e.target.value })}
            />
            <Problem id="profile-path-error" text={problems.pathPrepend} />
          </Field>
        </Section>

        <Section title="Agent sandbox (Codex)">
          <Field
            label="Writable directories"
            id="profile-roots"
            hint="Directories a Codex agent may write to besides its worktree. One absolute path per line."
          >
            <textarea
              id="profile-roots"
              rows={3}
              aria-describedby="profile-roots-hint profile-roots-error"
              aria-invalid={problems.writableRoots ? true : undefined}
              className={`${inputClass} font-mono`}
              value={form.writableRoots}
              onChange={(e) => set({ writableRoots: e.target.value })}
            />
            <Problem id="profile-roots-error" text={problems.writableRoots} />
          </Field>
          <label className="flex items-center gap-2 text-sm" htmlFor="profile-agent-network">
            <input
              id="profile-agent-network"
              type="checkbox"
              aria-describedby="profile-agent-network-warning"
              checked={form.networkAccess}
              onChange={(e) => set({ networkAccess: e.target.checked })}
            />
            Allow network access
          </label>
          <p id="profile-agent-network-warning" className="text-xs">
            <Badge tone="warn">Warning</Badge> This lets commands run by the agent reach the
            network.
          </p>
        </Section>

        <Section title="Verification timeout">
          <div className="w-56">
            <Field
              label="Verification timeout (minutes)"
              id="profile-timeout"
              hint="Optional. The limit for one verification run, up to 1440 minutes."
            >
              <input
                id="profile-timeout"
                inputMode="decimal"
                aria-describedby="profile-timeout-hint profile-timeout-error"
                aria-invalid={problems.timeoutMinutes ? true : undefined}
                className={inputClass}
                value={form.timeoutMinutes}
                onChange={(e) => set({ timeoutMinutes: e.target.value })}
              />
              <Problem id="profile-timeout-error" text={problems.timeoutMinutes} />
            </Field>
          </div>
        </Section>

        {attempted && found.count > 0 ? (
          <p role="alert" className="text-sm text-red-800 dark:text-red-300">
            Fix the marked {found.count === 1 ? "field" : "fields"} before saving.
          </p>
        ) : null}
        {issues.length > 0 ? (
          <div
            role="alert"
            aria-label="The server did not accept the profile"
            className="space-y-1 rounded border border-red-400 p-3 text-sm dark:border-red-500"
          >
            <p>The server did not accept the profile:</p>
            <ul className="ml-4 list-disc font-mono text-xs">
              {issues.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {harness ? (
          <p className="text-sm">
            Checks are installed as harness <span className="font-mono">{harness.name}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
          <Button type="submit" disabled={busy || !api.hasApprovalSession()}>
            {busy ? "Saving profile…" : "Save profile"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={props.onReset}>
            Reset
          </Button>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Saving replaces the whole profile. Plans proposed earlier keep the checks they were
            approved with. Reset discards your edits and loads the saved profile.
          </p>
        </div>
      </form>
      <ApprovalUnlock id="profile-approval-code" onUnlocked={() => setUnlockTick((n) => n + 1)} />
    </>
  );
}
