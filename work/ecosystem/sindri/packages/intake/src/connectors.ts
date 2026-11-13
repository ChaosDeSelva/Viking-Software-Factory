import { assertSecretHandle, resolveSecret, type SecretSource } from "./secrets.js";

export type ConnectorKind = "jira" | "linear" | "github";

export interface IssueRef {
  source: ConnectorKind;
  /** Human issue key, e.g. "PROJ-123" / "ENG-42". */
  key: string;
  url: string;
}

export interface IssueComment {
  externalId: string;
  author: string;
  body: string;
  createdAt: string;
}

/** Normalised view of a remote issue plus the untouched remote payload in `raw`. */
export interface IssueSnapshot {
  source: ConnectorKind;
  externalId: string;
  url: string;
  title: string;
  /** Plain text; untrusted. */
  body: string;
  /** Remote last-updated timestamp, used for stale/conflict detection. */
  updated: string;
  status?: string;
  raw: unknown;
}

export interface CommentsResult {
  comments: IssueComment[];
  raw: unknown;
}

/** Read-only issue source. Implementations must not expose any write operation. */
export interface Connector {
  readonly kind: ConnectorKind;
  canHandle(url: string): boolean;
  parseUrl(url: string): IssueRef;
  fetchIssue(ref: IssueRef): Promise<IssueSnapshot>;
  fetchComments?(ref: IssueRef): Promise<CommentsResult>;
}

export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type FetchFn = typeof fetch;

function parseHttpsUrl(url: string): URL | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

// Remote JSON is untrusted: a field of the wrong type must not reach a snapshot, where display
// sanitizing and storage expect strings.
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const idText = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" ? String(v) : "";

// --------------------------------------------------------------------------- Jira

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

const ADF_BLOCKS = new Set(["paragraph", "heading", "blockquote", "codeBlock", "rule", "panel"]);

/**
 * Nodes nested deeper than this are dropped: real documents stay far below it, and recursion on
 * a hostile document must not overflow the stack.
 */
export const MAX_ADF_DEPTH = 100;

/** Flatten Atlassian Document Format into plain text. Never interprets the content. */
export function adfToText(node: unknown): string {
  const walk = (n: AdfNode | undefined, bullet = "", depth = 0): string => {
    if (!n || typeof n !== "object" || depth > MAX_ADF_DEPTH) return "";
    const children = list(n.content) as AdfNode[];
    switch (n.type) {
      case "text":
        return typeof n.text === "string" ? n.text : "";
      case "hardBreak":
        return "\n";
      case "mention":
      case "emoji":
        return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
      case "inlineCard":
      case "blockCard":
        return String(n.attrs?.url ?? "");
      case "bulletList":
      case "orderedList":
        return children
          .map((item, i) => walk(item, n.type === "bulletList" ? "- " : `${i + 1}. `, depth + 1))
          .join("");
      case "listItem":
        return (
          bullet +
          children
            .map((c) => walk(c, "", depth + 1))
            .join("")
            .trimEnd() +
          "\n"
        );
      default: {
        const inner = children.map((c) => walk(c, "", depth + 1)).join("");
        return n.type && ADF_BLOCKS.has(n.type) ? inner + "\n" : inner;
      }
    }
  };
  if (typeof node === "string") return node;
  return walk(node as AdfNode)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface JiraConnectorOptions {
  /** e.g. https://acme.atlassian.net — only URLs on this host are handled. */
  baseUrl: string;
  email: string;
  /** SecretStore handle; resolved per request, never stored in snapshots. */
  apiToken: SecretSource;
  fetch: FetchFn;
}

/** At most this many comments are imported per ticket (audit M5: bounded work per import). */
export const MAX_IMPORTED_COMMENTS = 500;

/** Each imported text field (title, body, comment author and body) is cut to this length. */
export const MAX_FIELD_CHARS = 64 * 1024;

/** Untrusted remote text, bounded before it is stored or sanitized (audit M5). */
const cap = (text: string) =>
  text.length > MAX_FIELD_CHARS ? text.slice(0, MAX_FIELD_CHARS) : text;

/** Jira Cloud REST v3, read-only (GET issue, GET comments). */
export class JiraConnector implements Connector {
  readonly kind = "jira" as const;
  readonly #base: URL;
  readonly #email: string;
  readonly #token: SecretSource;
  readonly #fetch: FetchFn;

  constructor(options: JiraConnectorOptions) {
    const base = parseHttpsUrl(options.baseUrl);
    if (!base) throw new Error("JiraConnector baseUrl must be an https URL");
    this.#base = base;
    assertSecretHandle(options.apiToken, "JiraConnector apiToken");
    this.#email = options.email;
    this.#token = options.apiToken;
    this.#fetch = options.fetch;
  }

  canHandle(url: string): boolean {
    const u = parseHttpsUrl(url);
    if (!u || u.host !== this.#base.host) return false;
    const m = /^\/browse\/([^/]+)\/?$/.exec(u.pathname);
    return !!m?.[1] && ISSUE_KEY.test(m[1]);
  }

  parseUrl(url: string): IssueRef {
    if (!this.canHandle(url))
      throw new ConnectorError(`not a Jira issue URL for ${this.#base.host}`);
    const u = new URL(url);
    const key = (/^\/browse\/([^/]+)/.exec(u.pathname) as RegExpExecArray)[1] as string;
    return { source: "jira", key, url: `${u.origin}/browse/${key}` };
  }

  async #get<T>(path: string): Promise<T> {
    const token = await resolveSecret(this.#token);
    const auth = Buffer.from(`${this.#email}:${token}`).toString("base64");
    const res = await this.#fetch(new URL(path, this.#base).href, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!res.ok) throw new ConnectorError(`Jira request failed: HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  async fetchIssue(ref: IssueRef): Promise<IssueSnapshot> {
    const raw = await this.#get<unknown>(`/rest/api/3/issue/${encodeURIComponent(ref.key)}`);
    const f = rec(rec(raw)["fields"]);
    const snap: IssueSnapshot = {
      source: "jira",
      externalId: str(rec(raw)["key"]) ?? ref.key,
      url: ref.url,
      title: cap(str(f["summary"]) ?? ""),
      body: cap(adfToText(f["description"] ?? "")),
      updated: str(f["updated"]) ?? "",
      raw,
    };
    const status = str(rec(f["status"])["name"]);
    if (status) snap.status = status;
    return snap;
  }

  async fetchComments(ref: IssueRef): Promise<CommentsResult> {
    const base = `/rest/api/3/issue/${encodeURIComponent(ref.key)}/comment`;
    const pages: unknown[] = [];
    const commentsOf = (p: unknown) => list(rec(p)["comments"]);
    let page = await this.#get<unknown>(base);
    pages.push(page);
    let seen = commentsOf(page).length;
    for (;;) {
      const total = rec(page)["total"];
      if (
        typeof total !== "number" ||
        seen >= total ||
        seen >= MAX_IMPORTED_COMMENTS ||
        commentsOf(page).length === 0
      )
        break;
      page = await this.#get<unknown>(`${base}?startAt=${seen}`);
      pages.push(page);
      seen += commentsOf(page).length;
    }
    const comments = pages
      .flatMap(commentsOf)
      .slice(0, MAX_IMPORTED_COMMENTS)
      .map(rec)
      .map((c) => ({
        externalId: idText(c["id"]),
        author: cap(str(rec(c["author"])["displayName"]) ?? "unknown"),
        body: cap(adfToText(c["body"] ?? "")),
        createdAt: str(c["created"]) ?? "",
      }));
    return { comments, raw: pages.length === 1 ? pages[0] : pages };
  }
}

// ------------------------------------------------------------------------- Linear

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const ISSUE_QUERY = `query SindriIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url priority createdAt updatedAt
    state { name type }
    team { key name }
    labels { nodes { name } }
  }
}`;

const COMMENTS_QUERY = `query SindriIssueComments($id: String!) {
  issue(id: $id) {
    id
    comments(first: 250) { nodes { id body createdAt user { name } } }
  }
}`;

export interface LinearConnectorOptions {
  apiKey: SecretSource;
  fetch: FetchFn;
}

/** Linear GraphQL, read-only (queries only; no mutation is ever sent). */
export class LinearConnector implements Connector {
  readonly kind = "linear" as const;
  readonly #apiKey: SecretSource;
  readonly #fetch: FetchFn;

  constructor(options: LinearConnectorOptions) {
    assertSecretHandle(options.apiKey, "LinearConnector apiKey");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
  }

  canHandle(url: string): boolean {
    const u = parseHttpsUrl(url);
    if (!u || u.host !== "linear.app") return false;
    const m = /^\/[^/]+\/issue\/([^/]+)(?:\/[^/]*)?\/?$/.exec(u.pathname);
    return !!m?.[1] && ISSUE_KEY.test(m[1]);
  }

  parseUrl(url: string): IssueRef {
    if (!this.canHandle(url)) throw new ConnectorError("not a Linear issue URL");
    const u = new URL(url);
    const key = (/^\/[^/]+\/issue\/([^/]+)/.exec(u.pathname) as RegExpExecArray)[1] as string;
    return { source: "linear", key, url: `${u.origin}${u.pathname}` };
  }

  async #query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const key = await resolveSecret(this.#apiKey);
    const res = await this.#fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new ConnectorError(`Linear request failed: HTTP ${res.status}`, res.status);
    const json = rec(await res.json());
    const errors = list(json["errors"]);
    if (errors.length || !json["data"]) {
      // Remote error text is untrusted: surface only a well-formed error code.
      const code = rec(rec(errors[0])["extensions"])["code"];
      const safe =
        typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNKNOWN";
      throw new ConnectorError(`Linear GraphQL error (${safe})`);
    }
    return json["data"] as T;
  }

  async fetchIssue(ref: IssueRef): Promise<IssueSnapshot> {
    const data = await this.#query<unknown>(ISSUE_QUERY, { id: ref.key });
    if (!rec(data)["issue"]) throw new ConnectorError(`Linear issue ${ref.key} not found`);
    const issue = rec(rec(data)["issue"]);
    const snap: IssueSnapshot = {
      source: "linear",
      externalId: str(issue["identifier"]) ?? ref.key,
      url: str(issue["url"]) ?? ref.url,
      title: cap(str(issue["title"]) ?? ""),
      body: cap(str(issue["description"]) ?? ""),
      updated: str(issue["updatedAt"]) ?? "",
      raw: data,
    };
    const status = str(rec(issue["state"])["name"]);
    if (status) snap.status = status;
    return snap;
  }

  async fetchComments(ref: IssueRef): Promise<CommentsResult> {
    const data = await this.#query<unknown>(COMMENTS_QUERY, { id: ref.key });
    const comments = list(rec(rec(rec(data)["issue"])["comments"])["nodes"])
      .slice(0, MAX_IMPORTED_COMMENTS)
      .map(rec)
      .map((c) => ({
        externalId: idText(c["id"]),
        author: cap(str(rec(c["user"])["name"]) ?? "unknown"),
        body: cap(str(c["body"]) ?? ""),
        createdAt: str(c["createdAt"]) ?? "",
      }));
    return { comments, raw: data };
  }
}
