import {
  Badge,
  Button,
  KeyValue,
  SegmentedControl,
  Switch,
  useTheme,
  type ThemePreference,
} from "@factory/ui";
import { useSession } from "../api/session.js";
import { Screen } from "../components/Screen.js";
import { Section } from "../components/Section.js";
import { ErrorState, LoadingState } from "../components/StateViews.js";
import { useAsync } from "../lib/useAsync.js";
import { useShortcutsEnabled } from "../lib/shortcutsPref.js";
import { useStore } from "../store/StoreProvider.js";

const THEMES: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function Runtime() {
  const { client } = useStore();
  const health = useAsync(() => client.health(), "health");
  const caps = useAsync(() => client.capabilities(), "caps");
  if (health.status === "loading" || caps.status === "loading")
    return <LoadingState label="runtime status" lines={2} />;
  if (caps.status === "error") return <ErrorState message={caps.error} onRetry={caps.reload} />;
  if (health.status === "error")
    return <ErrorState message={health.error} onRetry={health.reload} />;
  const rt = caps.data.runtime;
  return (
    <KeyValue
      items={[
        {
          label: "Server",
          value: `${health.data.status} (server ${caps.data.serverVersion}, protocol ${caps.data.protocolVersion})`,
        },
        {
          label: "Runtime",
          term: "Runtime",
          value: rt ? `${rt.runtime} ${rt.version}` : "No runtime configured",
        },
        ...(rt
          ? [
              {
                label: "Features",
                term: "Capabilities",
                value: (
                  <ul className="flex flex-wrap gap-1">
                    {Object.entries(rt.features).map(([k, on]) => (
                      <li key={k}>
                        <Badge tone={on ? "forest" : "neutral"}>
                          {k}: {on ? "yes" : "no"}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

/** Global, per-browser settings plus server facts. Sign out is the same action as the bottom bar's. */
export function Settings() {
  const { signOut } = useSession();
  const [theme, setTheme] = useTheme();
  const [shortcuts, setShortcuts] = useShortcutsEnabled();
  return (
    <Screen
      screen="settings"
      title="Settings"
      global
      description="The server and runtime Mimir talks to, where it keeps data, and preferences for this browser."
    >
      <Section title="Runtime" term="Runtime">
        <Runtime />
      </Section>
      <Section title="Data and retention">
        <KeyValue
          items={[
            {
              label: "Data directory",
              value: (
                <>
                  Set on the server with <code>MIMIR_DATA_DIR</code> (default <code>~/.mimir</code>
                  ); the database is <code>&lt;data dir&gt;/mimir.db</code>.
                </>
              ),
            },
            {
              label: "Artifact retention",
              term: "Artifact",
              value: (
                <>
                  <code>MIMIR_ARTIFACT_RETENTION_DAYS</code> (default 30 days).
                </>
              ),
            },
            {
              label: "Auth token",
              term: "Access token",
              value: (
                <>
                  <code>MIMIR_AUTH_TOKEN</code>, or the file{" "}
                  <code>&lt;data dir&gt;/auth-token</code> written on first start. This UI keeps it
                  in sessionStorage for this tab only.
                </>
              ),
            },
          ]}
        />
      </Section>
      <Section
        title="Session"
        description="Sign out forgets the token in this tab; you will be asked for it again."
      >
        <div>
          <Button variant="secondary" icon="logOut" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </Section>
      <Section title="Keyboard">
        <Switch
          checked={shortcuts}
          onCheckedChange={setShortcuts}
          label="Enable single-key keyboard shortcuts (g o, g m, g r, ?)"
          description="Turn these off if single-key shortcuts clash with speech input or assistive technology."
        />
      </Section>
      <Section title="Appearance" description="Shared with the other factory apps in this browser.">
        <div className="flex flex-col gap-2">
          <SegmentedControl
            label="Theme"
            value={theme}
            onValueChange={(v) => setTheme(v as ThemePreference)}
            options={THEMES}
          />
          <p className="text-sm text-muted">
            Animations are disabled when your system asks for reduced motion.
          </p>
        </div>
      </Section>
    </Screen>
  );
}
