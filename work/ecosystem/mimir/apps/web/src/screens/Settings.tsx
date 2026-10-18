import { useSession } from "../api/session.js";
import { PageTitle, Section } from "../components/Section.js";
import { ErrorState, LoadingState } from "../components/StateViews.js";
import type { ThemePref } from "../lib/theme.js";
import { useAsync } from "../lib/useAsync.js";
import { useShortcutsEnabled } from "../lib/shortcutsPref.js";
import { useThemePref } from "../lib/useTheme.js";
import { useStore } from "../store/StoreProvider.js";

const THEMES: readonly { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function Runtime() {
  const { client } = useStore();
  const health = useAsync(() => client.health(), "health");
  const caps = useAsync(() => client.capabilities(), "caps");
  if (health.status === "loading" || caps.status === "loading")
    return <LoadingState label="runtime status" />;
  if (caps.status === "error") return <ErrorState message={caps.error} onRetry={caps.reload} />;
  if (health.status === "error")
    return <ErrorState message={health.error} onRetry={health.reload} />;
  const rt = caps.data.runtime;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="font-medium">Server</dt>
      <dd>
        {health.data.status} (server {caps.data.serverVersion}, protocol {caps.data.protocolVersion}
        )
      </dd>
      <dt className="font-medium">Runtime</dt>
      <dd>{rt ? `${rt.runtime} ${rt.version}` : "No runtime configured"}</dd>
      {rt && (
        <>
          <dt className="font-medium">Features</dt>
          <dd>
            <ul className="grid grid-cols-2 sm:grid-cols-3">
              {Object.entries(rt.features).map(([k, on]) => (
                <li key={k}>
                  {k}: {on ? "yes" : "no"}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}

export function Settings() {
  const { signOut } = useSession();
  const [theme, setTheme] = useThemePref();
  const [shortcuts, setShortcuts] = useShortcutsEnabled();
  return (
    <>
      <PageTitle>Settings</PageTitle>
      <Section title="Runtime">
        <Runtime />
      </Section>
      <Section title="Data and retention">
        <ul className="list-disc pl-5 text-sm">
          <li>
            Data directory: set on the server with <code>MIMIR_DATA_DIR</code> (default{" "}
            <code>~/.mimir</code>); the database is <code>&lt;data dir&gt;/mimir.db</code>.
          </li>
          <li>
            Artifact retention: <code>MIMIR_ARTIFACT_RETENTION_DAYS</code> (default 30 days).
          </li>
          <li>
            Auth token: <code>MIMIR_AUTH_TOKEN</code>, or the file{" "}
            <code>&lt;data dir&gt;/auth-token</code> written on first start. This UI keeps it in
            sessionStorage for this tab only.
          </li>
        </ul>
        <button type="button" className="btn mt-2" onClick={signOut}>
          Forget token
        </button>
      </Section>
      <Section title="Keyboard">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={shortcuts}
            onChange={(e) => setShortcuts(e.target.checked)}
          />
          Enable single-key keyboard shortcuts (g o, g m, g r, ?)
        </label>
        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
          Turn these off if single-key shortcuts clash with speech input or assistive technology.
        </p>
      </Section>
      <Section title="Appearance">
        <fieldset>
          <legend className="text-sm font-medium">Theme</legend>
          <div className="flex gap-3">
            {THEMES.map((t) => (
              <label key={t.value} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="theme"
                  value={t.value}
                  checked={theme === t.value}
                  onChange={() => setTheme(t.value)}
                />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
          Animations are disabled when your system asks for reduced motion.
        </p>
      </Section>
    </>
  );
}
