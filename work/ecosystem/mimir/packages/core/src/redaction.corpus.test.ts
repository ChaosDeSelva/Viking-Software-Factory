// Synthetic credential shapes are assembled at runtime for redaction tests.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SENSITIVE_KEY_PATTERN,
  findCredentialShapes,
  isSensitiveKey,
  redact,
  redactPayload,
} from "./redaction.js";

/**
 * Audit H3 corpus (`/tmp/mimir-audit/probe-redact.mts`): each entry is [input, secret core].
 * After redaction the core must not appear anywhere in the output.
 */
const AUDIT_CORPUS: [string, string][] = [
  ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["ASIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE"],
  ["temp creds AROAIOSFODNN7EXAMPLE used", "AROAIOSFODNN7EXAMPLE"],
  [
    ("gi" + "thub_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012"),
    "11ABCDEFG0123456789_abcdef",
  ],
  [("xo" + "xb-1234567890-1234567890-abcdefghijklmnopqrstuvwx"), "abcdefghijklmnopqrstuvwx"],
  [("xo" + "xp-1234567890-1234567890-abcdefghijklmnopqrstuvwx"), "abcdefghijklmnopqrstuvwx"],
  ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "SyA1234567890abcdefghijklmnop"],
  ["ya29.a0AfH6SMBx1234567890abcdefghijklmnop", "a0AfH6SMBx1234567890abcdef"],
  ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123456789"],
  [("sk" + "_live_51H8abcdefghijklmnopqrstuvwxyz"), "51H8abcdefghijklmnop"],
  [("rk" + "_live_51H8abcdefghijklmnopqrstuvwxyz"), "51H8abcdefghijklmnop"],
  [("sk" + "_test_51H8abcdefghijklmnopqrstuvwxyz"), "51H8abcdefghijklmnop"],
  ["DATABASE_URL=postgres://admin:hunter2pass@db.internal:5432/app", "hunter2pass"],
  ["https://user:s3cretP4ss@github.com/org/repo.git", "s3cretP4ss"],
  ["redis://:r3disPassw0rd@cache:6379", "r3disPassw0rd"],
  [
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n(output truncated)",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
  ],
  [
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBFabcdefgh\n-----END PGP PRIVATE KEY BLOCK-----",
    "lQOYBFabcdefgh",
  ],
  [
    "export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "abcdefghijklmnopqrstuvwxyz",
  ],
  ["OPENAI_KEY: abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123456789"],
  ["client_secret: 'abc def'", "abc def"],
  ["passphrase=correcthorsebatterystaple", "correcthorsebatterystaple"],
  ["PGPASSWORD=hunter2", "hunter2"],
  ["x-api-key: abcdefghijklmnop0123", "abcdefghijklmnop0123"],
  ["Cookie: session=abcdef0123456789", "abcdef0123456789"],
  ["Set-Cookie: sid=abcdef0123456789; Path=/; HttpOnly", "abcdef0123456789"],
  ["glpat-abcdefghijklmnopqrst", "abcdefghijklmnopqrst"],
  [("hf" + "_abcdefghijklmnopqrstuvwxyzABCDEFGH"), "abcdefghijklmnopqrstuvwxyzABCDEFGH"],
  ["SENTRY_DSN=https://abc123def456@o1.ingest.sentry.io/1", "abc123def456"],
  ["DB_PASS=Tr0ub4dor3", "Tr0ub4dor3"],
  // GCP service-account JSON (as printed by `cat key.json`).
  [
    '{"type": "service_account", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n"}',
    "MIIEvQIBADANBg",
  ],
  // Azure storage connection string and SP secret.
  [
    "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==;EndpointSuffix=core.windows.net",
    "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA",
  ],
  [
    "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=c2VjcmV0a2V5MTIz=",
    "c2VjcmV0a2V5MTIz",
  ],
  [
    '{"clientId": "11111111-2222", "clientSecret": "Az~8Q~abcdefghijklmnop"}',
    "Az~8Q~abcdefghijklmnop",
  ],
];

describe("redaction: audit H3 corpus", () => {
  for (const [input, core] of AUDIT_CORPUS) {
    it(`masks ${JSON.stringify(input.slice(0, 50))}`, () => {
      const out = redact(input);
      expect(out.redacted).toBe(true);
      expect(out.text).not.toContain(core);
    });
  }

  it("masks a truncated private key to the end of the text", () => {
    const out = redact("log:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef");
    expect(out.text).toBe("log:\n[REDACTED:private_key]");
  });

  it("keeps the URL shape, masking only the password", () => {
    expect(redact("https://user:s3cretP4ss@github.com/org/repo.git").text).toBe(
      "https://user:[REDACTED:url_credentials]@github.com/org/repo.git",
    );
  });

  it("redactPayload masks values under credential-ish keys (audit H3 item 4)", () => {
    const out = redactPayload({
      credentials: "x",
      pwd: "hunter2",
      auth: "abc",
      dsn: "postgres://a:b@c/d",
      db_pass: "zz",
      headers: { "X-Auth": "zzz", Cookie: "s=1" },
      env: { AWS_SECRET_ACCESS_KEY: "k" },
    });
    expect(out).toEqual({
      credentials: "[REDACTED:key]",
      pwd: "[REDACTED:key]",
      auth: "[REDACTED:key]",
      dsn: "[REDACTED:key]",
      db_pass: "[REDACTED:key]",
      headers: { "X-Auth": "[REDACTED:key]", Cookie: "[REDACTED:key]" },
      env: { AWS_SECRET_ACCESS_KEY: "[REDACTED:key]" },
    });
  });

  it("does not treat ordinary identifiers as sensitive keys", () => {
    for (const k of [
      "sessionId",
      "author",
      "authorId",
      "authority",
      "passed",
      "bypass",
      "compass",
      "status",
      "taskId",
      "keyboard",
      "monkey",
      "model",
      "maxTokens",
      "max_tokens",
      "tokenCount",
      "cookieDomain",
      "secretName",
      "private_key_id",
      "sortKey",
    ]) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
  });

  it("treats credential key names as sensitive in any case style", () => {
    for (const k of [
      "token",
      "accessToken",
      "access_token",
      "id_token",
      "secret",
      "secrets",
      "client_secret",
      "clientSecret",
      "password",
      "PASSWORD",
      "db_pass",
      "apiKey",
      "x-api-key",
      "API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "privateKey",
      "authorization",
      "Authorization",
      "X-Auth",
      "cookie",
      "Cookie",
      "set-cookie",
      "credentials",
      "dsn",
      "pwd",
      "passphrase",
      "AccountKey",
    ]) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
    // The exported pattern applies to the normalised (snake_case, lower) key name.
    expect(SENSITIVE_KEY_PATTERN.test("client_secret")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("max_tokens")).toBe(false);
  });

  it("round-trips project settings unchanged (coordinator ruling: T14a I2 false positives)", () => {
    const settings = {
      name: "Deploy Bearer Service",
      repo: "sk-learn-experiments-v2",
      settings: { model: "claude-sonnet-4-5", maxTokens: "4096", cookieDomain: "example.com" },
    };
    expect(redactPayload(settings)).toEqual(settings);
  });
});

/** Legitimate agent output and event text that must come through unchanged (false-positive bound). */
const LEGIT: string[] = [
  "Deploy Bearer Service",
  "sk-learn-experiments-v2",
  "model: claude-sonnet-4-5",
  "maxTokens: 4096",
  "cookieDomain: example.com",
  "the Bearer of bad news",
  "sk-learn is a library",
  "max_tokens=4096 tokens: 12",
  "token_count: 1500",
  "secret: true",
  "password: null",
  "the secret to good tests is isolation",
  "password reset link sent to the user",
  "git@github.com:org/repo.git",
  "https://github.com/org/repo.git",
  "http://localhost:7700/v1/projects?limit=5",
  "postgres://localhost:5432/app",
  "ssh://git@github.com/org/repo.git",
  "mailto:user@example.com",
  "user@example.com wrote: hi",
  "commit 3b5fcd2a8e1f0c9d7b6a5e4f3c2b1a0d9e8f7c6b",
  "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "id 01M4XPZ8BBGMRF2BRH1FA6WXM0 created",
  "uuid 123e4567-e89b-12d3-a456-426614174000",
  "AKIA is the prefix of an AWS key id",
  "npm_config_registry=https://registry.npmjs.org/",
  "SORT_KEY=name",
  "PRIMARY_KEY: id",
  "const monkey = banana;",
  "keyboard: us",
  "author: Jane Doe",
  "Session started: sess_01M4XPZ8BBGMRF2BRH1FA6WXM0",
  "✓ src/redaction.test.ts (41 tests) 12ms",
  "Tests  146 passed (146)",
  "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----",
  "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZI\n-----END PUBLIC KEY-----",
  "pk_live_51H8abcdefghijklmnopqrstuvwxyz is a publishable key",
  "xox is not a token",
  ("hf" + "_hub_download(repo_id)"),
  "glpat is GitLab's prefix",
  "AIza alone",
  "ya29 alone",
  "Visit https://example.com:8443/path",
  "time 12:34:56 elapsed",
  "a: b",
  "export PATH=/usr/local/bin:$PATH",
  "NODE_ENV=production",
];

describe("redaction: false positives stay bounded", () => {
  for (const s of LEGIT) {
    it(`leaves ${JSON.stringify(s.slice(0, 50))} unchanged`, () => {
      expect(redact(s)).toEqual({ text: s, redacted: false, hits: 0 });
    });
  }
});

const alnum = (min: number, max: number) =>
  fc.stringMatching(new RegExp(`^[A-Za-z0-9]{${min},${max}}$`));
const upperDigits = (n: number) => fc.stringMatching(new RegExp(`^[A-Z0-9]{${n}}$`));

/** Secret generators by shape: [arbitrary of (full secret text, core that must vanish)]. */
const SHAPES: fc.Arbitrary<[string, string]>[] = [
  fc
    .tuple(fc.constantFrom("AKIA", "ASIA", "AGPA", "AIDA", "AROA"), upperDigits(16))
    .map(([p, r]) => [p + r, p + r]),
  alnum(22, 60).map((r) => [`github_pat_${r}`, r]),
  fc
    .tuple(fc.constantFrom("xoxb", "xoxp", "xoxa", "xoxs"), alnum(16, 40))
    .map(([p, r]) => [`${p}-1234-${r}`, r]),
  fc.stringMatching(/^[A-Za-z0-9_-]{35}$/).map((r) => [`AIza${r}`, r]),
  alnum(36, 36).map((r) => [`npm_${r}`, r]),
  fc
    .tuple(fc.constantFrom(("sk" + "_live_"), ("rk" + "_live_"), ("sk" + "_test_")), alnum(16, 40))
    .map(([p, r]) => [p + r, r]),
  alnum(20, 30).map((r) => [`glpat-${r}`, r]),
  alnum(30, 40).map((r) => [`hf_${r}`, r]),
  fc
    .tuple(
      fc.constantFrom("postgres", "https", "mysql", "redis", "amqp"),
      alnum(3, 10),
      alnum(8, 24),
    )
    .map(([s, u, p]) => [`${s}://${u}:${p}@host.internal/db`, p]),
  fc
    .tuple(
      fc.constantFrom(
        "AWS_SECRET_ACCESS_KEY",
        "aws_secret_access_key",
        "STRIPE_SECRET",
        "GH_TOKEN",
        "db_password",
        "OPENAI_KEY",
        "DB_PASS",
      ),
      fc.constantFrom("=", ": ", " = ", '": "'),
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9/+]{15,40}[0-9]$/),
    )
    .map(([k, sep, v]) => [`${k}${sep}${v}`, v]),
  fc
    .tuple(
      fc.constantFrom("RSA ", "EC ", "OPENSSH ", "ENCRYPTED ", ""),
      fc.stringMatching(/^[A-Za-z0-9+/]{20,60}$/),
      fc.boolean(),
    )
    .map(([t, body, truncated]) => [
      `-----BEGIN ${t}PRIVATE KEY-----\n${body}\n${truncated ? "" : `-----END ${t}PRIVATE KEY-----`}`,
      body,
    ]),
];

/** Surrounding text (no secrets); a secret always starts and ends at a token boundary. */
const before = fc.constantFrom(
  "",
  " ",
  "\n",
  "output: ",
  "export X=1 ",
  "> ",
  "\t# note\n",
  "[info] ",
);
const after = fc.constantFrom("", " ", "\n", " done", "\t# note\n", "\r\n");

describe("redaction: property (audit H3 shapes in arbitrary context)", () => {
  it("never leaks a generated secret core", () => {
    fc.assert(
      fc.property(fc.oneof(...SHAPES), before, after, ([secret, core], b, a) => {
        const out = redact(b + secret + a);
        expect(out.redacted).toBe(true);
        expect(out.text).not.toContain(core);
      }),
      { numRuns: 2000 },
    );
  });

  it("is idempotent: redacting a redacted text changes nothing", () => {
    fc.assert(
      fc.property(fc.oneof(...SHAPES), before, ([secret], b) => {
        const once = redact(b + secret).text;
        expect(redact(once)).toEqual({ text: once, redacted: false, hits: 0 });
      }),
      { numRuns: 500 },
    );
  });
});

describe("redaction: linear time on large payloads (no catastrophic backtracking)", () => {
  const N = 256 * 1024;
  const INPUTS: [string, string][] = [
    ["word run", "y".repeat(N)],
    ["upper run", "A".repeat(N)],
    ["upper underscores", "A_".repeat(N / 2)],
    ["dotted", "a.".repeat(N / 2)],
    ["dashed", "a-".repeat(N / 2)],
    ["scheme-ish", "a:".repeat(N / 2)],
    ["url-ish", "a://b".repeat(N / 5)],
    ["key words", "password".repeat(N / 8)],
    ["unterminated BEGIN", "-----BEGIN PRIVATE KEY-----".repeat(N / 27)],
    ["spaces", " ".repeat(N)],
  ];
  for (const [label, input] of INPUTS) {
    it(`redacts 256 KiB of ${label} in well under a second`, () => {
      const t0 = performance.now();
      redact(input);
      expect(performance.now() - t0).toBeLessThan(500);
    });
  }
});

describe("URL userinfo: empty user and percent-encoded colon (T14a re-review N1)", () => {
  const POSITIVE = [
    "redis://:secret@h:6379",
    "user%3Apass@host",
    "https://user%3Apass@host/x",
    "https://user%3apass@host/x",
    "postgres://admin:hunter2pass@db.internal:5432/app",
  ];
  const NEGATIVE = [
    "user:@host",
    "https://user:@host",
    "user@host",
    "git@github.com:org/repo.git",
    "ssh://git@host",
    "https://github.com/org/repo.git",
    "mailto:user@example.com",
  ];
  for (const s of POSITIVE) {
    it(`flags and redacts ${s}`, () => {
      expect(findCredentialShapes(s)).toContain("url_userinfo");
      const out = redact(s);
      expect(out.redacted).toBe(true);
      expect(out.text).not.toMatch(/secret|pass(?!word)|hunter2/);
    });
  }
  for (const s of NEGATIVE) {
    it(`leaves ${s} alone`, () => {
      expect(findCredentialShapes(s)).toEqual([]);
      expect(redact(s)).toEqual({ text: s, redacted: false, hits: 0 });
    });
  }
});
