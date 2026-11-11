import { Callout, InfoHint, Page, Stack, StickyActionBar } from "@factory/ui";
import { useEffect, useState } from "react";
import type { Settings } from "../api/types.js";
import { Button, Field, LoadState, ScreenHeader, inputClass, Card } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";
import { MimirConnection } from "./MimirConnection.js";

export function SettingsScreen() {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const loaded = useLoad(() => api.getSettings(), []);
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);

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
    <Page>
      <ScreenHeader
        screen="settings"
        title="Settings"
        global
        description="Machine-wide settings: the model provider, the agents that do the work, and the Mimir, Brokkr and Feedback Graph connections. Per-project settings are on the Project settings tab."
      />
      <div className="grid gap-group lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <LoadState state={loaded.state} what="settings" onRetry={loaded.reload}>
          {({ tokenLocation }) =>
            form ? (
              <form
                aria-label="Settings"
                className="flex min-w-0 flex-col gap-group"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const clean: Settings = { ...form };
                    if (!clean.mimirUrl) delete clean.mimirUrl;
                    if (!clean.apiKeySecret) delete clean.apiKeySecret;
                    if (!clean.mimirTokenSecret) delete clean.mimirTokenSecret;
                    // An untouched, empty Feedback Graph section is left out rather than saved.
                    const fg = clean.feedbackGraph;
                    if (fg && !fg.url.trim() && !fg.tokenSecret.trim() && !fg.enabled)
                      delete clean.feedbackGraph;
                    setForm(await api.putSettings(clean));
                    notify("Settings saved");
                  });
                }}
              >
                <Card
                  title="Model provider"
                  description="The model the Director, planner, steward and Guide use."
                >
                  <div className="flex flex-col gap-field">
                    <Field label="LLM provider" id="s-provider" term="Local factory">
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
                      <Callout tone="warning">
                        Requests, ticket text and repository excerpts will leave this machine and go
                        to Anthropic.
                        {form.localOnly
                          ? " Turn off local-only mode to use a remote provider."
                          : ""}
                      </Callout>
                    ) : null}
                    {form.provider.endsWith("-cli") ? (
                      <p className="text-xs text-muted">
                        Uses your installed CLI login. Planning context is sent to its model
                        provider. Set model to default to use the CLI default; turn offline mode off
                        to enable model calls.
                      </p>
                    ) : null}
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
                    <CheckField
                      id="s-local"
                      label="Offline mode"
                      term="Local-only mode"
                      checked={form.localOnly}
                      onChange={(localOnly) => setForm({ ...form, localOnly })}
                      hint="Blocks model-provider calls and external imports. Keep this off to use Codex or Claude with their cloud models; the factory itself still runs locally."
                    />
                  </div>
                </Card>
                <Card
                  title="Agents"
                  term="Agent kind"
                  description="Which coding agent implements tasks, and which reviews and tests them."
                >
                  <div className="grid gap-field sm:grid-cols-2">
                    {(["workerAgent", "reviewerAgent"] as const).map((key) => (
                      <Field
                        key={key}
                        label={
                          key === "workerAgent" ? "Implementation agent" : "Review and QA agent"
                        }
                        id={`s-${key}`}
                      >
                        <select
                          id={`s-${key}`}
                          className={inputClass}
                          value={form[key] ?? "claude"}
                          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                        >
                          {AGENTS.map(([value, text]) => (
                            <option key={value} value={value}>
                              {text}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ))}
                  </div>
                </Card>
                <Card
                  title="Mimir and Brokkr"
                  description="Runs execute through Mimir; Brokkr resolves and verifies harnesses."
                >
                  <div className="flex flex-col gap-field">
                    <Field label="Mimir URL (optional)" id="s-mimir" term="Mimir">
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
                    <CheckField
                      id="s-brokkr"
                      label="Use Brokkr for harness selection"
                      term="Brokkr"
                      checked={form.brokkrEnabled ?? false}
                      onChange={(brokkrEnabled) => setForm({ ...form, brokkrEnabled })}
                      hint="Off: plans use Sindri's built-in fixture harnesses. On: Brokkr resolves harnesses (needs the Brokkr SDK)."
                    />
                  </div>
                </Card>
                <FeedbackGraphSettings
                  value={form.feedbackGraph}
                  onChange={(feedbackGraph) => setForm({ ...form, feedbackGraph })}
                />
                <StickyActionBar status="Saved settings apply to every project.">
                  <Button type="submit" loading={busy}>
                    Save settings
                  </Button>
                </StickyActionBar>
                <p className="text-xs text-muted">
                  API token location:{" "}
                  <span className="font-mono break-all">
                    {tokenLocation ?? "~/.sindri/auth-token"}
                  </span>
                  . The browser keeps it in sessionStorage for this tab only.
                </p>
              </form>
            ) : (
              <p role="status">Loading settings…</p>
            )
          }
        </LoadState>
        <Stack gap={4}>
          <MimirConnection />
          <Card
            title="Export"
            description="Download a zip with a snapshot of the Sindri database and settings (no secrets)."
          >
            <Button
              variant="secondary"
              icon="arrowRight"
              loading={busy}
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
          <Card
            title="Project data"
            description="Deleting one project's data moved to its Project settings (Danger zone)."
          >
            <Button
              variant="secondary"
              onClick={() => dispatch({ type: "navigate", view: "project-settings" })}
            >
              Open Project settings
            </Button>
          </Card>
        </Stack>
      </div>
    </Page>
  );
}

const AGENTS: [string, string][] = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["opencode", "OpenCode (experimental)"],
  ["gemini", "Gemini CLI (experimental)"],
  ["pi", "Pi (experimental)"],
  ["pi-signed", "pi-signed (experimental; interactive backend)"],
  ["grok", "grok (experimental; interactive backend)"],
  ["kimi", "kimi (experimental; interactive backend)"],
  ["cursor", "cursor (experimental; interactive backend)"],
  ["muse", "muse (experimental; interactive backend)"],
  ["rovo", "rovo (experimental; interactive backend)"],
  ["omp", "omp (experimental; interactive backend)"],
  ["agy", "agy (experimental; interactive backend)"],
  ["devin", "devin (experimental; interactive backend)"],
  ["commandcode", "commandcode (experimental; interactive backend)"],
];

/** Checkbox with label, hint (`{id}-hint`) and glossary InfoHint. */
function CheckField(props: {
  id: string;
  label: string;
  hint: string;
  term?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={props.id}
        type="checkbox"
        aria-describedby={`${props.id}-hint`}
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <label htmlFor={props.id} className="text-sm font-medium">
            {props.label}
          </label>
          {props.term ? <InfoHint term={props.term} label={`About ${props.label}`} /> : null}
        </span>
        <p id={`${props.id}-hint`} className="text-xs text-muted">
          {props.hint}
        </p>
      </div>
    </div>
  );
}

type FeedbackGraphSetting = NonNullable<Settings["feedbackGraph"]>;

/** Where Feedback Graph runs and which SecretStore entry holds its token (never the token). */
function FeedbackGraphSettings(props: {
  value: Settings["feedbackGraph"];
  onChange: (v: FeedbackGraphSetting) => void;
}) {
  const v: FeedbackGraphSetting = props.value ?? { url: "", tokenSecret: "", enabled: false };
  const set = (patch: Partial<FeedbackGraphSetting>) => props.onChange({ ...v, ...patch });
  return (
    <Card
      title="Feedback Graph"
      term="Feedback Graph"
      description="Lessons from past reviews that the steward and planner can use."
    >
      <fieldset className="flex flex-col gap-field">
        <legend className="sr-only">Feedback Graph</legend>
        <p className="text-xs text-muted">
          Store the token with{" "}
          <code className="font-mono [overflow-wrap:anywhere]">
            security add-generic-password -s sindri -a feedback-graph.token -w
          </code>{" "}
          and enter <span className="font-mono">feedback-graph.token</span> as the secret name.
        </p>
        <div className="flex items-start gap-3">
          <input
            id="s-fg-enabled"
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--accent)]"
            checked={v.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          <label htmlFor="s-fg-enabled" className="text-sm font-medium">
            Use Feedback Graph lessons
          </label>
        </div>
        <Field label="Feedback Graph URL" id="s-fg-url" hint="Usually http://127.0.0.1:8787.">
          <input
            id="s-fg-url"
            type="url"
            aria-describedby="s-fg-url-hint"
            className={inputClass}
            placeholder="http://127.0.0.1:8787"
            value={v.url}
            onChange={(e) => set({ url: e.target.value })}
          />
        </Field>
        <Field
          label="Feedback Graph token secret name"
          id="s-fg-token"
          hint="The SecretStore entry holding the token (for example feedback-graph.token)."
        >
          <input
            id="s-fg-token"
            aria-describedby="s-fg-token-hint"
            className={inputClass}
            value={v.tokenSecret}
            onChange={(e) => set({ tokenSecret: e.target.value })}
          />
        </Field>
      </fieldset>
    </Card>
  );
}
