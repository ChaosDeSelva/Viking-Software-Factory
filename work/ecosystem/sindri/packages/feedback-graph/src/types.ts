/** One approved Feedback Graph lesson as Sindri uses it. All text is untrusted, already sanitised. */
export interface FgLesson {
  id: string;
  title: string;
  rule: string;
  appliesWhen: string | null;
  paths: string[];
  status: string;
  /** An injection pattern was found in the lesson's text and redacted before it reached Sindri. */
  injectionDetected: boolean;
}

/** `GET /v1/feedback-graph/status`. */
export interface FgStatus {
  configured: boolean;
  enabled: boolean;
  url: string | null;
  /** null: not probed (not configured, disabled or blocked). */
  reachable: boolean | null;
  error: string | null;
}

export type FgLinkSource = "auto" | "override" | "none";

export interface FgLink {
  projectKey: string | null;
  source: FgLinkSource;
}

/** `GET`/`PUT /v1/projects/:id/feedback-graph`. */
export interface FgProjectView {
  link: FgLink;
  lessons: FgLesson[];
  error: string | null;
}

/** The `feedbackGraph` server setting: `tokenSecret` is a SecretStore key name, never the token. */
export interface FgConfig {
  url: string;
  tokenSecret: string;
  enabled: boolean;
}

/** Only the read side of Sindri's SecretStore. */
export interface SecretReader {
  get(key: string): Promise<string | undefined>;
}

export type FgErrorCode =
  | "not_configured"
  | "disabled"
  | "blocked"
  | "token_missing"
  | "unauthorized"
  | "unreachable"
  | "timeout"
  | "too_large"
  | "invalid_response"
  | "http_error";

export interface FgError {
  code: FgErrorCode;
  message: string;
}

export type FgResult<T> = { ok: true; value: T } | { ok: false; error: FgError };
