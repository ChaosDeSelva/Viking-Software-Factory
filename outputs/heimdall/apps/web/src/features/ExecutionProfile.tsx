// A project's execution profile (checks, environment, sandbox), in the project inspector. The form
// logic is in profileForm.ts; saving replaces the whole profile through a project.profile command.
import { useEffect, useState } from "react";
import {
  Button,
  Callout,
  Checkbox,
  Cluster,
  Disclosure,
  Field,
  Grid,
  GridItem,
  IconButton,
  InfoHint,
  Input,
  Select,
  Stack,
  Textarea,
} from "@factory/ui";
import { useHeimdall } from "../app/context";
import type { R } from "../lib/api";
import { actionBlock } from "./workflowState";
import {
  emptyCheck,
  formToProfile,
  parseArgv,
  profileToForm,
  type CheckRow,
  type ProfileForm,
} from "./profileForm";

const Heading = ({ children, term }: { children: string; term?: string }) => (
  <h4 className="inline-flex items-center gap-1 text-sm font-semibold text-fg">
    {children}
    {term && <InfoHint term={term} />}
  </h4>
);

/** `sindriProject` is Sindri's record of the open project; undefined when only Mimir knows it. */
export function ExecutionProfile({
  sindriProject,
}: {
  sindriProject: R | undefined;
}) {
  const { session, propose, api, reloadKey, profileSaved } = useHeimdall();
  const id: string | undefined = sindriProject?.id;
  const [stored, setStored] = useState<R | null>(null),
    [form, setForm] = useState<ProfileForm>(() => profileToForm({})),
    [altered, setAltered] = useState(false),
    [error, setError] = useState("");
  // Re-read after every confirmed command (reloadKey), so the form shows what Sindri stored.
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
      <h3 className="inline-flex items-center gap-1 text-base font-semibold text-fg">
        Execution profile <InfoHint term="Execution profile" />
      </h3>
      <p className="text-sm text-muted">
        The checks that decide whether work on this project passes, and what
        agents and checks need from this machine: environment variables, extra
        PATH directories, directories an agent may write to, and network access.
      </p>
    </>
  );
  if (!id)
    return (
      <Stack gap={3}>
        {intro}
        <Callout tone="warning">
          This project exists only in Mimir. A profile needs the project
          registered in Sindri: register its repository path under New work.
        </Callout>
      </Stack>
    );

  const { profile, errors } = formToProfile(form);
  const unchanged =
    stored !== null &&
    JSON.stringify(profile) ===
      JSON.stringify(formToProfile(profileToForm(stored)).profile);
  const blocked =
    actionBlock("project.profile", undefined, session) ||
    (stored === null
      ? "The stored profile has not loaded, so it cannot be replaced yet."
      : "") ||
    errors[0] ||
    (unchanged ? "Change the profile first." : "");
  const set = (patch: Partial<ProfileForm>) =>
    setForm((old) => ({ ...old, ...patch }));
  const setCheck = (i: number, patch: Partial<CheckRow>) =>
    set({
      checks: form.checks.map((row, j) =>
        j === i ? { ...row, ...patch } : row,
      ),
    });
  const setEnv = (i: number, patch: { name?: string; value?: string }) =>
    set({
      env: form.env.map((row, j) => (j === i ? { ...row, ...patch } : row)),
    });
  const storedChecks: R[] = stored?.checks ?? [];
  const harness = profileSaved?.id === id ? profileSaved.harness : null;

  return (
    <Stack gap={3}>
      {intro}
      {error && (
        <Callout tone="danger" title="The profile could not be read">
          {error}
        </Callout>
      )}
      {stored !== null && (
        <p className="text-sm break-words">
          <span className="font-medium">
            {storedChecks.length
              ? `${storedChecks.length} ${storedChecks.length === 1 ? "check" : "checks"}`
              : "Built-in checks"}
            :
          </span>{" "}
          {storedChecks.length
            ? harness
              ? `Checks are installed as harness ${harness.name}.`
              : storedChecks.map((c) => c.id).join(", ")
            : "No checks set: plans use the built-in checks, which assume a Node project."}
        </p>
      )}
      <Disclosure title="Edit execution profile">
        <Stack gap={5}>
          <p className="text-sm text-muted">
            Saving replaces the whole profile with what this form shows. Plans
            proposed earlier keep the checks they were approved with. New checks
            are written as a new harness; do not save them while a run is being
            verified, or that verification is blocked.
          </p>
          <Callout tone="warning">
            Text is cleaned for display before it reaches this form, so
            angle-bracket tags or very long text in a stored value may already
            be removed or shortened. Check each value before saving.
            {altered &&
              " Heimdall also hid at least one value that looks like a credential; it shows as [redacted] and must be entered again."}
          </Callout>

          <Stack gap={3}>
            <Heading term="Checks">Checks</Heading>
            {form.checks.map((row, i) => {
              const parsed = parseArgv(row.command);
              return (
                <fieldset
                  key={i}
                  className="flex min-w-0 flex-col gap-4 rounded-md border border-line p-4"
                >
                  <legend className="px-1 text-sm font-medium">
                    Check {i + 1}
                  </legend>
                  <Grid gap={4}>
                    <GridItem span={6}>
                      <Field label="ID">
                        <Input
                          placeholder="test"
                          value={row.id}
                          onChange={(e) => setCheck(i, { id: e.target.value })}
                        />
                      </Field>
                    </GridItem>
                    <GridItem span={6}>
                      <Field label="Label (optional)">
                        <Input
                          value={row.title}
                          onChange={(e) =>
                            setCheck(i, { title: e.target.value })
                          }
                        />
                      </Field>
                    </GridItem>
                  </Grid>
                  <Field
                    label="Command"
                    hint={
                      <>
                        Run directly, not through a shell: quotes group words,
                        and pipes, variables and redirects do not work.{" "}
                        {parsed.error ?? (
                          <>
                            Parts:{" "}
                            <code className="break-all">
                              {JSON.stringify(parsed.argv)}
                            </code>
                          </>
                        )}
                      </>
                    }
                  >
                    <Input
                      placeholder="make test"
                      value={row.command}
                      onChange={(e) => setCheck(i, { command: e.target.value })}
                    />
                  </Field>
                  <Grid gap={4}>
                    <GridItem span={6}>
                      <Field label="Working directory (relative to the repository, optional)">
                        <Input
                          placeholder="src/service"
                          value={row.cwd}
                          onChange={(e) => setCheck(i, { cwd: e.target.value })}
                        />
                      </Field>
                    </GridItem>
                    <GridItem span={6}>
                      <Field label="Timeout in seconds (optional, default 600)">
                        <Input
                          type="number"
                          min="1"
                          max="86400"
                          value={row.timeoutSeconds}
                          onChange={(e) =>
                            setCheck(i, { timeoutSeconds: e.target.value })
                          }
                        />
                      </Field>
                    </GridItem>
                  </Grid>
                  <Cluster gap={3} justify="between">
                    <Checkbox
                      label="Required: work does not pass unless this check passes"
                      checked={row.required}
                      onChange={(e) =>
                        setCheck(i, { required: e.target.checked })
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove check ${i + 1}`}
                      onClick={() =>
                        set({ checks: form.checks.filter((_, j) => j !== i) })
                      }
                    >
                      Remove
                    </Button>
                  </Cluster>
                </fieldset>
              );
            })}
            {!form.checks.length && (
              <p className="text-sm text-muted">
                No checks set: plans use the built-in checks, which assume a
                Node project.
              </p>
            )}
            <Cluster>
              <Button
                icon="plus"
                onClick={() => set({ checks: [...form.checks, emptyCheck()] })}
              >
                Add check
              </Button>
            </Cluster>
            <Field label="Check network" term="Check network">
              <Select
                value={form.network}
                onValueChange={(value) =>
                  set({ network: value === "allow" ? "allow" : "deny" })
                }
                options={[
                  {
                    value: "deny",
                    label: "Deny: checks run without network access",
                  },
                  {
                    value: "allow",
                    label: "Allow: checks may use the network",
                  },
                ]}
              />
            </Field>
          </Stack>

          <Stack gap={3}>
            <Heading>Environment variables</Heading>
            <p className="text-sm text-muted">
              Passed to the checks and the agents. Keep credentials out of the
              profile: variables that look like credentials are not passed to
              checks.
            </p>
            {form.env.map((row, i) => (
              <div key={i} className="flex min-w-0 items-end gap-2">
                <Field label="Name" className="flex-1">
                  <Input
                    placeholder="GOCACHE"
                    value={row.name}
                    onChange={(e) => setEnv(i, { name: e.target.value })}
                  />
                </Field>
                <Field label="Value" className="flex-1">
                  <Input
                    value={row.value}
                    onChange={(e) => setEnv(i, { value: e.target.value })}
                  />
                </Field>
                <IconButton
                  icon="x"
                  variant="ghost"
                  label={`Remove variable ${row.name || i + 1}`}
                  onClick={() =>
                    set({ env: form.env.filter((_, j) => j !== i) })
                  }
                />
              </div>
            ))}
            <Cluster>
              <Button
                icon="plus"
                onClick={() =>
                  set({ env: [...form.env, { name: "", value: "" }] })
                }
              >
                Add variable
              </Button>
            </Cluster>
            <Field
              label="PATH additions (one absolute directory per line, searched first)"
              term="PATH additions"
            >
              <Textarea
                placeholder="/Users/you/.local/share/mise/shims"
                value={form.pathPrepend}
                onChange={(e) => set({ pathPrepend: e.target.value })}
              />
            </Field>
          </Stack>

          <Stack gap={3}>
            <Heading term="Codex sandbox">Agent sandbox (Codex)</Heading>
            <Field
              label="Writable directories besides the worktree (one absolute directory per line)"
              term="Writable roots"
            >
              <Textarea
                value={form.writableRoots}
                onChange={(e) => set({ writableRoots: e.target.value })}
              />
            </Field>
            <Checkbox
              label="Allow network access"
              description={
                <span
                  className={form.networkAccess ? "text-warning-fg" : undefined}
                >
                  Network access lets commands run by the agent reach the
                  network, including downloading and sending data.
                </span>
              }
              checked={form.networkAccess}
              onChange={(e) => set({ networkAccess: e.target.checked })}
            />
            <Field
              label="Verification timeout in minutes (optional)"
              term="Verification timeout"
            >
              <Input
                type="number"
                min="0.017"
                max="1440"
                step="any"
                value={form.verificationMinutes}
                onChange={(e) => set({ verificationMinutes: e.target.value })}
              />
            </Field>
          </Stack>

          {errors.length > 0 && (
            <Callout tone="danger" title="Fix these before saving">
              <ul className="list-disc pl-5">
                {errors.map((message) => (
                  <li key={message} className="break-words">
                    {message}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          <Stack gap={2}>
            <Cluster>
              <Button
                variant="primary"
                disabledReason={blocked || undefined}
                onClick={() => propose("project.profile", id, profile)}
              >
                Review profile change
              </Button>
            </Cluster>
            {blocked && !errors.includes(blocked) && (
              <p className="text-sm text-muted">{blocked}</p>
            )}
          </Stack>
        </Stack>
      </Disclosure>
    </Stack>
  );
}
