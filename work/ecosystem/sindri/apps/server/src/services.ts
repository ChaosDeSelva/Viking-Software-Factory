import { createProvider, openDirector, type Director, type LlmProvider } from "@sindri/director";
import {
  JiraConnector,
  LinearConnector,
  openIntake,
  type Connector,
  type Intake,
  type SecretStore,
} from "@sindri/intake";
import {
  applyMigrations,
  openKnowledge,
  type Knowledge,
  type SqliteDatabase,
} from "@sindri/knowledge";
import { openSpecs, type Specs } from "@sindri/specs";
import { CommandStore } from "./idempotency.js";
import { planningWorkspace, type PlanningWorkspace } from "./repo-snapshot.js";
import { ReworkStore } from "./rework.js";
import { SERVER_MIGRATIONS } from "./schema.js";
import { effectiveProvider, SettingsStore, type Settings } from "./settings.js";

export interface ServiceOptions {
  db: SqliteDatabase;
  /** A fixed director (tests, e2e). Otherwise one is built from settings via `providerFactory`. */
  director?: Director;
  providerFactory?: (settings: Settings) => LlmProvider;
  connectorFactory?: (settings: Settings) => Connector[];
  secrets?: SecretStore;
  attachmentsDir?: string;
  /** Sindri data directory; refused as a project repoPath. */
  dataDir?: string;
  now?: () => Date;
}

export interface Services {
  db: SqliteDatabase;
  knowledge: Knowledge;
  specs: Specs;
  commands: CommandStore;
  settings: SettingsStore;
  rework: ReworkStore;
  dataDir: string | null;
  /** The directory a planner reads for a project: a default-branch snapshot when possible. */
  planningWorkspace(
    project: { id: string; repoPath: string },
    opts?: { commit?: string },
  ): Promise<PlanningWorkspace>;
  intake(): Intake;
  director(): Director;
}

/** Connectors built from settings; credentials are SecretStore handles resolved per request. */
export function connectorsFromSettings(settings: Settings, secrets?: SecretStore): Connector[] {
  const out: Connector[] = [];
  const c = settings.connectors;
  if (!secrets || !c) return out;
  if (c.jira)
    out.push(
      new JiraConnector({
        baseUrl: c.jira.baseUrl,
        email: c.jira.email,
        apiToken: { store: secrets, key: c.jira.apiTokenSecret },
        fetch: globalThis.fetch,
      }),
    );
  if (c.linear)
    out.push(
      new LinearConnector({
        apiKey: { store: secrets, key: c.linear.apiKeySecret },
        fetch: globalThis.fetch,
      }),
    );
  return out;
}

export function createServices(o: ServiceOptions): Services {
  const now = o.now ?? (() => new Date());
  const { db } = o;
  const knowledge = openKnowledge(db, { now });
  const specs = openSpecs(db, { now });
  applyMigrations(db, "server", SERVER_MIGRATIONS);
  const settings = new SettingsStore(db, now);
  const commands = new CommandStore(db, now);
  commands.clearPending();
  // Deleted rows are zeroed on disk, so purged project text does not linger in free pages.
  db.pragma("secure_delete = ON");
  const providerFactory =
    o.providerFactory ??
    ((st: Settings) =>
      createProvider(
        {
          director: {
            provider: effectiveProvider(st),
            model: st.model,
            ...(st.apiKeySecret ? { apiKeySecret: st.apiKeySecret } : {}),
          },
        },
        o.secrets ? { secrets: o.secrets } : {},
      ));
  const connectorFactory =
    o.connectorFactory ?? ((st: Settings) => connectorsFromSettings(st, o.secrets));

  const workspaceFor = (
    project: { id: string; repoPath: string },
    opts: { commit?: string } = {},
  ): Promise<PlanningWorkspace> =>
    planningWorkspace({
      dataDir: o.dataDir ?? null,
      projectId: project.id,
      repoPath: project.repoPath,
      ...(opts.commit ? { commit: opts.commit } : {}),
    });

  let intakeCache: { key: string; intake: Intake } | undefined;
  let directorCache: { key: string; director: Director } | undefined;
  return {
    db,
    knowledge,
    specs,
    commands,
    settings,
    rework: new ReworkStore(db, now),
    dataDir: o.dataDir ?? null,
    planningWorkspace: workspaceFor,
    intake() {
      const st = settings.get();
      const key = JSON.stringify(st.connectors ?? {});
      if (intakeCache?.key !== key)
        intakeCache = {
          key,
          intake: openIntake(db, {
            connectors: connectorFactory(st),
            now,
            ...(o.attachmentsDir ? { attachmentsDir: o.attachmentsDir } : {}),
          }),
        };
      return intakeCache.intake;
    },
    director() {
      if (o.director) return o.director;
      const st = settings.get();
      const key = JSON.stringify([st.provider, st.model, st.apiKeySecret, st.localOnly]);
      if (directorCache?.key !== key)
        directorCache = {
          key,
          director: openDirector(db, { provider: providerFactory(st), now, workspaceFor }),
        };
      return directorCache.director;
    },
  };
}
