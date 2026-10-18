// Synthetic credential shapes are assembled at runtime for redaction tests.
import { describe, expect, it } from "vitest";
import { redact, redactPayload, findCredentialShapes } from "./redaction.js";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("redact", () => {
  it.each([
    ["aws_key", "key AKIAIOSFODNN7EXAMPLE here", "key [REDACTED:aws_key] here"],
    ["github_token", ("gh" + "p_abcdefghijklmnopqrstuvwxyz0123"), "[REDACTED:github_token]"],
    ["github_token (server)", "use ghs_ABCDEFGHIJKLMNOPQRSTUV", "use [REDACTED:github_token]"],
    ["api_key", "ANTHROPIC sk-ant-api03-abcdefghijklmnop_-xyz", "ANTHROPIC [REDACTED:api_key]"],
    ["bearer", "Authorization: Bearer abc.def-123", "Authorization: Bearer [REDACTED:bearer]"],
    ["jwt", `jwt ${JWT} end`, "jwt [REDACTED:jwt] end"],
    ["generic password", "password=hunter2 next", "password=[REDACTED:secret] next"],
    ["generic api key", "API_KEY: s3cr3tvalue", "API_KEY: [REDACTED:secret]"],
    ["generic secret", "secret = abc", "secret = [REDACTED:secret]"],
  ])("masks %s", (_kind, input, expected) => {
    const out = redact(input);
    expect(out.text).toBe(expected);
    expect(out.redacted).toBe(true);
    expect(out.hits).toBe(1);
  });

  it("masks private key blocks", () => {
    const pem =
      "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKC\n-----END RSA PRIVATE KEY-----\nafter";
    const out = redact(pem);
    expect(out.text).toBe("before\n[REDACTED:private_key]\nafter");
    expect(out.hits).toBe(1);
  });

  it("leaves clean text untouched", () => {
    expect(redact("hello world, sk is short")).toEqual({
      text: "hello world, sk is short",
      redacted: false,
      hits: 0,
    });
  });

  it("counts multiple hits and does not re-redact markers", () => {
    const out = redact(("token: gh" + "p_abcdefghijklmnopqrstuvwxyz AKIAIOSFODNN7EXAMPLE"));
    expect(out.text).toBe("token: [REDACTED:github_token] [REDACTED:aws_key]");
    expect(out.hits).toBe(2);
  });

  it("applies extra patterns (with or without the g flag)", () => {
    const out = redact("internal-id ZZZ-1 and ZZZ-2", [/ZZZ-\d/]);
    expect(out.text).toBe("internal-id [REDACTED:custom] and [REDACTED:custom]");
    expect(out.hits).toBe(2);
  });
});

describe("redactPayload", () => {
  it("redacts every nested string leaf and keeps structure", () => {
    const input = {
      n: 1,
      ok: true,
      nil: null,
      deep: { list: ["fine", { note: "Authorization: Bearer zzz" }], key: "AKIAIOSFODNN7EXAMPLE" },
    };
    expect(redactPayload(input)).toEqual({
      n: 1,
      ok: true,
      nil: null,
      deep: {
        list: ["fine", { note: "Authorization: Bearer [REDACTED:bearer]" }],
        key: "[REDACTED:aws_key]",
      },
    });
    expect(input.deep.key).toBe("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("redact (fix round 1: I2 prefixed keys, I3 header shapes)", () => {
  it.each([
    ["access_token=abc123secretvalue", "access_token=[REDACTED:secret]"],
    ["client_secret=abcdef", "client_secret=[REDACTED:secret]"],
    ["db_password=hunter2", "db_password=[REDACTED:secret]"],
  ])("masks prefixed key %s", (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, redacted: true, hits: 1 });
  });

  it("masks quoted JSON-style key/value pairs inside a string", () => {
    expect(redact('{"password": "hunter2", "user": "bob"}').text).toBe(
      '{"password": "[REDACTED:secret]", "user": "bob"}',
    );
  });

  it("masks lowercase bearer and Basic authorization headers", () => {
    expect(redact("authorization: bearer abcdef123").text).toBe(
      "authorization: bearer [REDACTED:bearer]",
    );
    const basic = redact("Authorization: Basic dXNlcjpwYXNz");
    expect(basic.text).toBe("Authorization: [REDACTED:authorization]");
    expect(basic.hits).toBe(1);
  });

  it("does not treat token counts as secrets", () => {
    expect(redact("max_tokens=4096 tokens: 12").text).toBe("max_tokens=4096 tokens: 12");
  });
});

describe("redactPayload (fix round 1: I3 key-based, M3 JSON normalisation)", () => {
  it("redacts string values under sensitive keys, including nested strings", () => {
    expect(
      redactPayload({
        password: "hunter2",
        token: "abc",
        apiKey: "zzz",
        api_key: "zzz",
        passwd: "p",
        privateKey: "k",
        Cookie: "sid=1",
        headers: { authorization: "Basic dXNlcjpwYXNz", accept: "json" },
        secrets: { list: ["a", { inner: "b" }], count: 2, on: true },
        tokens: 1234,
        user: "bob",
      }),
    ).toEqual({
      password: "[REDACTED:key]",
      token: "[REDACTED:key]",
      apiKey: "[REDACTED:key]",
      api_key: "[REDACTED:key]",
      passwd: "[REDACTED:key]",
      privateKey: "[REDACTED:key]",
      Cookie: "[REDACTED:key]",
      headers: { authorization: "[REDACTED:key]", accept: "json" },
      secrets: { list: ["[REDACTED:key]", { inner: "[REDACTED:key]" }], count: 2, on: true },
      tokens: 1234,
      user: "bob",
    });
  });

  it("redacts secret-looking object keys themselves, keeping colliding keys distinct", () => {
    const out = redactPayload({
      ghp_abcdefghijklmnopqrstuvwxyz0123: 1,
      ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ: 2,
      plain: 3,
    }) as Record<string, number>;
    expect(JSON.stringify(out)).not.toContain(("gh" + "p_"));
    expect(Object.values(out).sort()).toEqual([1, 2, 3]);
    expect(out["[REDACTED:github_token]"]).toBe(1);
    expect(out["[REDACTED:github_token]#2"]).toBe(2);
  });

  it("normalises through JSON so Dates and toJSON objects keep their value", () => {
    expect(redactPayload({ at: new Date(0), skip: undefined, n: [1, undefined] })).toEqual({
      at: "1970-01-01T00:00:00.000Z",
      n: [1, null],
    });
    expect(redactPayload(undefined)).toBeUndefined();
  });
});

describe("findCredentialShapes (T14a fix I2: value shapes only, no key-name rule)", () => {
  it.each([
    ["aws_key", "id AKIAIOSFODNN7EXAMPLE here"],
    ["github_token", ("gh" + "p_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")],
    ["github_token", ("gi" + "thub_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz")],
    ["api_key", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789"],
    ["api_key", "sk-chaosLEAK0123456789abcdefghijklmnop"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjaGFvcyJ9.c2lnbmF0dXJlY2hhb3M"],
    ["bearer", "Authorization: Bearer abcDEF0123456789ghiJKL0123"],
    ["private_key", "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----"],
    ["private_key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["url_userinfo", "https://user:pass@host"],
    ["url_userinfo", "remote postgres://admin:s3cret@db.internal:5432/app"],
  ])("finds %s", (kind, text) => {
    expect(findCredentialShapes(text)).toContain(kind);
  });

  it.each([
    "Deploy Bearer Service",
    "bearer of good news",
    "sk-learn-experiments-v2",
    "maxTokens",
    "tokenizer",
    "cl100k_base",
    "password policy: strict",
    "secretsProvider=vault",
    "cookieDomain localhost",
    "AKIA-not-a-key",
    ("gh" + "p_short"),
    "eyJ alone",
    "https://host/path",
    "https://user@host/path",
    "git@github.com:org/repo.git",
    "ops@example.com",
    "http://localhost:3000/a:b@c",
  ])("leaves %j alone", (text) => {
    expect(findCredentialShapes(text)).toEqual([]);
  });
});
