import { useEffect, useState } from "react";
import type { Settings } from "../api/types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { Button, Card, Field, LoadState, inputClass } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";
import { MimirConnection } from "./MimirConnection.js";

export function SettingsScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const loaded = useLoad(() => api.getSettings(), []);
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [eraseEvidence, setEraseEvidence] = useState(false);
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [, setUnlockTick] = useState(0);
  const project = state.projects.find((p) => p.id === state.projectId) ?? null;

  useEffect(() => {
    if (loaded.state.status === "ready") setForm(loaded.state.data.settings);
  }, [loaded.state]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const notify = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Settings">
        <LoadState state={loaded.state} what="settings" onRetry={loaded.reload}>
          {({ tokenLocation }) =>
            form ? (
              <form
                aria-label="Settings"
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const clean: Settings = { ...form };
                    if (!clean.mimirUrl) delete clean.mimirUrl;
                    if (!clean.apiKeySecret) delete clean.apiKeySecret;
                    if (!clean.mimirTokenSecret) delete clean.mimirTokenSecret;
                    setForm(await api.putSettings(clean));
                    notify("Settings saved");
                  });
                }}
              >
                <Field label="LLM provider" id="s-provider">
                  <select
                    id="s-provider"
                    className={inputClass}
                    value={form.provider}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        provider: e.target.value as Settings["provider"],
                        ...(e.target.value.endsWith("-cli") ? { model: "default" } : {}),
                      })
                    }
                  >
                    <option value="codex-cli">Codex (existing login)</option>
                    <option value="claude-cli">Claude Code (existing login)</option>
                    <option value="anthropic">Anthropic API</option>
                    <option value="fake">Fake (tests)</option>
                    <option value="null">None (Director disabled)</option>
                  </select>
                </Field>
                {form.provider === "anthropic" ? (
                  <p className="rounded border border-amber-500 p-2 text-xs">
                    Requests, ticket text and repository excerpts will leave this machine and go to
                    Anthropic.
                    {form.localOnly ? " Turn off local-only mode to use a remote provider." : ""}
                  </p>
                ) : null}
                {form.provider.endsWith("-cli") ? (
                  <p className="text-xs">
                    Uses your installed CLI login. Planning context is sent to its model provider.
                    Set model to default to use the CLI default; turn offline mode off to enable
                    model calls.
                  </p>
                ) : null}
                {(["workerAgent", "reviewerAgent"] as const).map((key) => (
                  <Field
                    key={key}
                    label={key === "workerAgent" ? "Implementation agent" : "Review and QA agent"}
                    id={`s-${key}`}
                  >
                    <select
                      id={`s-${key}`}
                      className={inputClass}
                      value={form[key] ?? "claude"}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    >
                      <option value="codex">Codex</option>
                      <option value="claude">Claude Code</option>
                      <option value="opencode">OpenCode (experimental)</option>
                      <option value="gemini">Gemini CLI (experimental)</option>
                      <option value="pi">Pi (experimental)</option>
<option value="pi-signed">pi-signed (experimental; interactive backend)</option>
<option value="grok">grok (experimental; interactive backend)</option>
<option value="kimi">kimi (experimental; interactive backend)</option>
<option value="cursor">cursor (experimental; interactive backend)</option>
<option value="muse">muse (experimental; interactive backend)</option>
<option value="rovo">rovo (experimental; interactive backend)</option>
<option value="omp">omp (experimental; interactive backend)</option>
<option value="agy">agy (experimental; interactive backend)</option>
<option value="devin">devin (experimental; interactive backend)</option>
<option value="commandcode">commandcode (experimental; interactive backend)</option>

                    </select>
                  </Field>
                ))}
                <Field label="Model" id="s-model">
                  <input
                    id="s-model"
                    className={inputClass}
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                  />
                </Field>
                <Field
                  label="API key secret name"
                  id="s-key"
                  hint="The name of a SecretStore entry (for example anthropic.api-key), never the key itself."
                >
                  <input
                    id="s-key"
                    aria-describedby="s-key-hint"
                    className={inputClass}
                    value={form.apiKeySecret ?? ""}
                    onChange={(e) => setForm({ ...form, apiKeySecret: e.target.value })}
                  />
                </Field>
                <div className="flex items-start gap-2">
                  <input
                    id="s-local"
                    type="checkbox"
                    aria-describedby="s-local-hint"
                    className="mt-1 h-4 w-4"
                    checked={form.localOnly}
                    onChange={(e) => setForm({ ...form, localOnly: e.target.checked })}
                  />
                  <div>
                    <label htmlFor="s-local" className="text-sm font-medium">
                      Offline mode
                    </label>
                    <p id="s-local-hint" className="text-xs text-slate-600 dark:text-slate-300">
                      Blocks model-provider calls and external imports. Keep this off to use Codex
                      or Claude with their cloud models; the factory itself still runs locally.
                    </p>
                  </div>
                </div>
                <Field label="Mimir URL (optional)" id="s-mimir">
                  <input
                    id="s-mimir"
                    type="url"
                    className={inputClass}
                    value={form.mimirUrl ?? ""}
                    onChange={(e) => setForm({ ...form, mimirUrl: e.target.value })}
                  />
                </Field>
                <Field
                  label="Mimir token secret name"
                  id="s-mimir-token"
                  hint="The SecretStore entry holding Mimir's token (for example mimir.token)."
                >
                  <input
                    id="s-mimir-token"
                    aria-describedby="s-mimir-token-hint"
                    className={inputClass}
                    value={form.mimirTokenSecret ?? ""}
                    onChange={(e) => setForm({ ...form, mimirTokenSecret: e.target.value })}
                  />
                </Field>
                <div className="flex items-start gap-2">
                  <input
                    id="s-brokkr"
                    type="checkbox"
                    aria-describedby="s-brokkr-hint"
                    className="mt-1 h-4 w-4"
                    checked={form.brokkrEnabled ?? false}
                    onChange={(e) => setForm({ ...form, brokkrEnabled: e.target.checked })}
                  />
                  <div>
                    <label htmlFor="s-brokkr" className="text-sm font-medium">
                      Use Brokkr for harness selection
                    </label>
                    <p id="s-brokkr-hint" className="text-xs text-slate-600 dark:text-slate-300">
                      Off: plans use Sindri&apos;s built-in fixture harnesses. On: Brokkr resolves
                      harnesses (needs the Brokkr SDK).
                    </p>
                  </div>
                </div>
                <Button type="submit" disabled={busy}>
                  Save settings
                </Button>
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  API token location:{" "}
                  <span className="font-mono">{tokenLocation ?? "~/.sindri/auth-token"}</span>. The
                  browser keeps it in sessionStorage for this tab only.
                </p>
              </form>
            ) : (
              <p role="status">Loading settings…</p>
            )
          }
        </LoadState>
      </Card>
      <div className="space-y-4">
        <MimirConnection />
        <Card title="Export">
          <p className="text-sm">
            Download a zip with a snapshot of the Sindri database and settings (no secrets).
          </p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const blob = await api.exportData();
                const href = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = href;
                a.download = "sindri-export.zip";
                a.click();
                // Revoking immediately can cancel the download in some browsers.
                setTimeout(() => URL.revokeObjectURL(href), 1000);
                notify("Export downloaded");
              })
            }
          >
            Export data
          </Button>
        </Card>
        <Card title="Delete project data">
          {project ? (
            <form
              aria-label="Delete project data"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const { deleted } = eraseEvidence
                    ? await api.deleteProjectData(project.id, confirm, { eraseEvidence: true })
                    : await api.deleteProjectData(project.id, confirm);
                  dispatch({ type: "projects/remove", projectId: project.id });
                  setConfirm("");
                  setEraseEvidence(false);
                  setEraseConfirm("");
                  notify(
                    `Deleted all data for ${project.name}` +
                      (deleted.evidenceErased !== undefined
                        ? ` (${deleted.evidenceErased} evidence records erased)`
                        : ""),
                  );
                });
              }}
            >
              <p className="text-sm">
                Permanently deletes the index, inbox, specs and knowledge of{" "}
                <strong>{project.name}</strong>. The repository itself is not touched.
              </p>
              <Field label={`Type "${project.name}" to confirm`} id="delete-confirm">
                <input
                  id="delete-confirm"
                  className={inputClass}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </Field>
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-sm" htmlFor="delete-erase-evidence">
                  <input
                    id="delete-erase-evidence"
                    type="checkbox"
                    checked={eraseEvidence}
                    onChange={(e) => {
                      setEraseEvidence(e.target.checked);
                      setEraseConfirm("");
                    }}
                  />
                  <span>
                    Also erase immutable task evidence (test results, review and Brokkr records).
                    Only each record&apos;s id and hash are kept. Without this, a project with
                    evidence cannot be deleted.
                  </span>
                </label>
                {eraseEvidence && (
                  <Field label="Type ERASE EVIDENCE to confirm" id="delete-erase-confirm">
                    <input
                      id="delete-erase-confirm"
                      className={inputClass}
                      value={eraseConfirm}
                      onChange={(e) => setEraseConfirm(e.target.value)}
                    />
                  </Field>
                )}
              </div>
              <Button
                type="submit"
                variant="danger"
                disabled={
                  busy ||
                  confirm !== project.name ||
                  (eraseEvidence &&
                    (eraseConfirm !== "ERASE EVIDENCE" || !api.hasApprovalSession()))
                }
              >
                Delete project data
              </Button>
            </form>
          ) : (
            <p className="text-sm italic">Select a project to delete its data.</p>
          )}
          {project && eraseEvidence ? (
            // Erasing evidence is an approval (review I1); outside the form (no nested forms).
            <ApprovalUnlock
              id="erase-approval-code"
              onUnlocked={() => setUnlockTick((n) => n + 1)}
            />
          ) : null}
        </Card>
      </div>
    </div>
  );
}
