import { useEffect, useState } from "react";
import {
  Button,
  Disclosure,
  DisclosureTrigger,
  Field,
  Input,
  Option,
  Select,
  StatusBadge,
  Textarea,
} from "../components/ui";
import { actionBlock } from "./workflowState";
import {
  emptyCheck,
  formToProfile,
  parseArgv,
  profileToForm,
  type CheckRow,
  type ProfileForm,
} from "./profileForm";
type R = Record<string, any>;

export function ExecutionProfile({
  sindriProject,
  session,
  propose,
  api,
  reloadKey,
  saved,
}: {
  /** Sindri's record of the open project; undefined when only Mimir knows the project. */
  sindriProject: R | undefined;
  session: R;
  propose: (action: string, id: string, body?: R) => void;
  api: (path: string) => Promise<R>;
  /** Changes after every confirmed command, so the stored profile is read again. */
  reloadKey: number;
  /** The answer to the last confirmed profile change. */
  saved: { id: string; harness: R | null } | null;
}) {
  const id: string | undefined = sindriProject?.id;
  const [stored, setStored] = useState<R | null>(null),
    [form, setForm] = useState<ProfileForm>(() => profileToForm({})),
    [altered, setAltered] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!id) return;
    let gone = false;
    setStored(null);
    setError("");
    api("details/profile/" + id)
      .then((d) => {
        if (gone) return;
        setStored(d.profile ?? {});
        setForm(profileToForm(d.profile));
        setAltered(!!d.altered);
      })
      .catch((e) => {
        if (!gone) setError(e.message);
      });
    return () => {
      gone = true;
    };
  }, [id, reloadKey]);

  const intro = (
    <>
      <h3>Execution profile</h3>
      <p>
        The execution profile holds the checks that decide whether work on
        this project passes, and what agents and checks need from this
        machine: environment variables, extra PATH directories, directories
        an agent may write to, and network access.
      </p>
    </>
  );
  if (!id)
    return (
      <>
        {intro}
        <p className="warning">
          This project exists only in Mimir. A profile needs the project
          registered in Sindri: register its repository path under New work.
        </p>
      </>
    );

  const { profile, errors } = formToProfile(form);
  const unchanged =
    stored !== null &&
    JSON.stringify(profile) === JSON.stringify(formToProfile(profileToForm(stored)).profile);
  const blocked =
    actionBlock("project.profile", undefined, session) ||
    (stored === null ? "The stored profile has not loaded, so it cannot be replaced yet." : "") ||
    errors[0] ||
    (unchanged ? "Change the profile first." : "");
  const set = (patch: Partial<ProfileForm>) => setForm((old) => ({ ...old, ...patch }));
  const setCheck = (i: number, patch: Partial<CheckRow>) =>
    set({ checks: form.checks.map((row, j) => (j === i ? { ...row, ...patch } : row)) });
  const setEnv = (i: number, patch: { name?: string; value?: string }) =>
    set({ env: form.env.map((row, j) => (j === i ? { ...row, ...patch } : row)) });
  const storedChecks: R[] = stored?.checks ?? [];
  const harness = saved?.id === id ? saved.harness : null;

  return (
    <>
      {intro}
      {error && (
        <p role="alert" className="warning">
          The profile could not be read: {error}
        </p>
      )}
      {stored !== null && (
        <p>
          <StatusBadge
            value={
              storedChecks.length
                ? `${storedChecks.length} ${storedChecks.length === 1 ? "check" : "checks"}`
                : "built-in checks"
            }
          />{" "}
          {storedChecks.length
            ? harness
              ? `Checks are installed as harness ${harness.name}.`
              : storedChecks.map((c) => c.id).join(", ")
            : "No checks set: plans use the built-in checks, which assume a Node project."}
        </p>
      )}
      <Disclosure className="editor">
        <DisclosureTrigger>Edit execution profile</DisclosureTrigger>
        <p className="muted">
          Saving replaces the whole profile with what this form shows. Plans
          proposed earlier keep the checks they were approved with. New checks
          are written as a new harness; do not save them while a run is being
          verified, or that verification is blocked.
        </p>
        <p className="warning">
          Text is cleaned for display before it reaches this form, so
          angle-bracket tags or very long text in a stored value may already be
          removed or shortened. Check each value before saving.
          {altered &&
            " Heimdall also hid at least one value that looks like a credential; it shows as [redacted] and must be entered again."}
        </p>
        <h3>Checks</h3>
        {form.checks.map((row, i) => {
          const parsed = parseArgv(row.command);
          return (
            <fieldset key={i}>
              <legend>Check {i + 1}</legend>
              <div className="form-grid">
                <Field>
                  ID
                  <Input
                    placeholder="test"
                    value={row.id}
                    onChange={(e) => setCheck(i, { id: e.target.value })}
                  />
                </Field>
                <Field>
                  Label (optional)
                  <Input
                    value={row.title}
                    onChange={(e) => setCheck(i, { title: e.target.value })}
                  />
                </Field>
              </div>
              <Field>
                Command
                <Input
                  placeholder="make test"
                  value={row.command}
                  onChange={(e) => setCheck(i, { command: e.target.value })}
                />
              </Field>
              <p className="muted">
                Run directly, not through a shell: quotes group words, and
                pipes, variables and redirects do not work.{" "}
                {parsed.error ?? (
                  <>
                    Parts: <code>{JSON.stringify(parsed.argv)}</code>
                  </>
                )}
              </p>
              <div className="form-grid">
                <Field>
                  Working directory (relative to the repository, optional)
                  <Input
                    placeholder="src/service"
                    value={row.cwd}
                    onChange={(e) => setCheck(i, { cwd: e.target.value })}
                  />
                </Field>
                <Field>
                  Timeout in seconds (optional, default 600)
                  <Input
                    type="number"
                    min="1"
                    max="86400"
                    value={row.timeoutSeconds}
                    onChange={(e) => setCheck(i, { timeoutSeconds: e.target.value })}
                  />
                </Field>
              </div>
              <Field>
                <Input
                  type="checkbox"
                  checked={row.required}
                  onChange={(e) => setCheck(i, { required: e.target.checked })}
                />{" "}
                Required: work does not pass unless this check passes
              </Field>
              <Button
                aria-label={`Remove check ${i + 1}`}
                onClick={() => set({ checks: form.checks.filter((_, j) => j !== i) })}
              >
                Remove
              </Button>
            </fieldset>
          );
        })}
        {!form.checks.length && (
          <p className="muted">
            No checks set: plans use the built-in checks, which assume a Node
            project.
          </p>
        )}
        <Button onClick={() => set({ checks: [...form.checks, emptyCheck()] })}>
          Add check
        </Button>
        <Field>
          Check network
          <Select
            value={form.network}
            onValueChange={(value) => set({ network: value === "allow" ? "allow" : "deny" })}
          >
            <Option value="deny">Deny: checks run without network access</Option>
            <Option value="allow">Allow: checks may use the network</Option>
          </Select>
        </Field>
        <h3>Environment variables</h3>
        <p className="muted">
          Passed to the checks and the agents. Keep credentials out of the
          profile: variables that look like credentials are not passed to
          checks.
        </p>
        {form.env.map((row, i) => (
          <div className="form-grid profile-row" key={i}>
            <Field>
              Name
              <Input
                placeholder="GOCACHE"
                value={row.name}
                onChange={(e) => setEnv(i, { name: e.target.value })}
              />
            </Field>
            <Field>
              Value
              <Input value={row.value} onChange={(e) => setEnv(i, { value: e.target.value })} />
            </Field>
            <Button
              aria-label={`Remove variable ${row.name || i + 1}`}
              onClick={() => set({ env: form.env.filter((_, j) => j !== i) })}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button onClick={() => set({ env: [...form.env, { name: "", value: "" }] })}>
          Add variable
        </Button>
        <Field>
          PATH additions (one absolute directory per line, searched first)
          <Textarea
            placeholder="/Users/you/.local/share/mise/shims"
            value={form.pathPrepend}
            onChange={(e) => set({ pathPrepend: e.target.value })}
          />
        </Field>
        <h3>Agent sandbox (Codex)</h3>
        <Field>
          Writable directories besides the worktree (one absolute directory per line)
          <Textarea
            value={form.writableRoots}
            onChange={(e) => set({ writableRoots: e.target.value })}
          />
        </Field>
        <Field>
          <Input
            type="checkbox"
            checked={form.networkAccess}
            onChange={(e) => set({ networkAccess: e.target.checked })}
          />{" "}
          Allow network access
        </Field>
        <p className={form.networkAccess ? "warning" : "muted"}>
          Network access lets commands run by the agent reach the network,
          including downloading and sending data.
        </p>
        <Field>
          Verification timeout in minutes (optional)
          <Input
            type="number"
            min="0.017"
            max="1440"
            step="any"
            value={form.verificationMinutes}
            onChange={(e) => set({ verificationMinutes: e.target.value })}
          />
        </Field>
        {errors.length > 0 && (
          <ul role="alert" className="warning">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
        <Button
          disabled={!!blocked}
          title={blocked || undefined}
          onClick={() => propose("project.profile", id, profile)}
        >
          Review profile change
        </Button>
        {blocked && <p className="muted">{blocked}</p>}
      </Disclosure>
    </>
  );
}
