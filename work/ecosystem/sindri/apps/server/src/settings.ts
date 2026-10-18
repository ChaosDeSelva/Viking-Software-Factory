import { DEFAULT_ANTHROPIC_MODEL } from "@sindri/director";
import type { SqliteDatabase } from "@sindri/knowledge";
import { z } from "zod";
import { isLoopbackHostHeader } from "./security.js";

/** A SecretStore key name (a handle), never a secret value. */
const SecretKey = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,128}$/, "must be a SecretStore key name (letters, digits, . _ -)")
  .refine(
    (v) => !/^(sk-|lin_api_|ATATT|xox[abp]-|ghp_|github_pat_)/.test(v),
    "looks like a secret value; store it in the SecretStore and give its key name",
  );

const HttpUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

export const SettingsSchema = z.strictObject({
  provider: z.enum(["anthropic", "codex-cli", "claude-cli", "fake", "null"]),
  model: z.string().min(1).max(200),
  workerAgent: z.enum(["codex", "claude", "opencode", "gemini", "pi", "pi-signed", "grok", "kimi", "cursor", "muse", "rovo", "omp", "agy", "devin", "commandcode"]).optional(),
  reviewerAgent: z.enum(["codex", "claude", "opencode", "gemini", "pi", "pi-signed", "grok", "kimi", "cursor", "muse", "rovo", "omp", "agy", "devin", "commandcode"]).optional(),
  localOnly: z.boolean(),
  mimirUrl: HttpUrl.optional(),
  /** SecretStore key holding the Mimir bearer token. */
  mimirTokenSecret: SecretKey.optional(),
  brokkrEnabled: z.boolean().optional(),
  /** SecretStore key holding the Anthropic API key. */
  apiKeySecret: SecretKey.optional(),
  connectors: z
    .strictObject({
      jira: z
        .strictObject({
          baseUrl: HttpUrl,
          email: z.string().min(1).max(320),
          /** SecretStore key holding the Jira API token. */
          apiTokenSecret: SecretKey,
        })
        .optional(),
      linear: z.strictObject({ apiKeySecret: SecretKey }).optional(),
    })
    .optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  provider: "null",
  model: DEFAULT_ANTHROPIC_MODEL,
  localOnly: true,
};

/** Providers that make no network calls; the only ones allowed in local-only mode. */
export const LOCAL_PROVIDERS: ReadonlySet<Settings["provider"]> = new Set(["null", "fake"]);

/**
 * Why `settings` break local-only mode (docs/security.md, ADR-007), or null. Local-only allows
 * only a local LLM provider and a loopback Mimir; connectors are blocked where they are used.
 */
export function localOnlyViolation(st: Settings): string | null {
  if (!st.localOnly) return null;
  if (!LOCAL_PROVIDERS.has(st.provider))
    return `local-only mode allows only a local LLM provider (null or fake); turn local-only off to use ${st.provider}`;
  if (st.mimirUrl && !isLoopbackHostHeader(new URL(st.mimirUrl).host))
    return "local-only mode allows Mimir only on a loopback address";
  return null;
}

/** The provider actually used: a remote provider stored with local-only on becomes `null`. */
export const effectiveProvider = (st: Settings): Settings["provider"] =>
  st.localOnly && !LOCAL_PROVIDERS.has(st.provider) ? "null" : st.provider;

/** Single-row settings persisted in `server_settings`. Holds handles only, never secret values. */
export class SettingsStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date,
  ) {}

  get(): Settings {
    const row = this.db.prepare("SELECT settings_json FROM server_settings WHERE id = 1").get() as
      { settings_json: string } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    const parsed = SettingsSchema.safeParse(JSON.parse(row.settings_json));
    return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
  }

  put(settings: Settings): Settings {
    const valid = SettingsSchema.parse(settings);
    this.db
      .prepare(
        `INSERT INTO server_settings (id, settings_json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(valid), this.now().toISOString());
    return valid;
  }
}
