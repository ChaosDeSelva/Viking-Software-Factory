import { EnvSecretStore } from "@sindri/intake";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryLogger, nullLogger, redactSecrets } from "../logger.js";
import { ProviderError } from "../provider.js";
import { normalizeUntrusted, wrapUntrusted } from "../untrusted.js";
import { AnthropicProvider } from "./anthropic.js";
import { CliProvider } from "./cli.js";
import { FakeProvider } from "./fake.js";
import { createProvider } from "./select.js";

const KEY = "sk-ant-test-SECRET-KEY-654321";
const apiKey = {
  store: new EnvSecretStore({ env: { SINDRI_SECRET_K: KEY } }),
  key: "k",
};
const base = {
  system: "S",
  messages: [{ role: "user" as const, content: "U" }],
  maxTokens: 50,
  temperature: 0,
};

/** Answers every call with `status` and `body`; records each request body and URL. */
function api(respond: (n: number) => { status: number; body: unknown }) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const r = respond(seen.length);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", "request-id": "req_1" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}
const error = (type: string) => ({ type: "error", error: { type, message: `${type} ${KEY}` } });
const message = (over: Record<string, unknown> = {}) => ({
  id: "m",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-6",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 2 },
  ...over,
});

describe("AnthropicProvider failure mapping", () => {
  it.each([
    [403, "permission_error", "auth"],
    [429, "rate_limit_error", "rate_limited"],
    [500, "api_error", "api_error"],
  ])("maps HTTP %i to %s -> %s without the key", async (status, type, code) => {
    const { fetch } = api(() => ({ status, body: error(type) }));
    const logger = createMemoryLogger("debug");
    const p = new AnthropicProvider({
      apiKey,
      model: "claude-opus-4-6",
      fetch,
      maxRetries: 0,
      logger,
    });
    const err = (await p.complete(base).catch((e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ code });
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(logger.records)).not.toContain(KEY);
  });

  it("reports an unparseable success body as an API error without the key", async () => {
    const logger = createMemoryLogger("debug");
    const p = new AnthropicProvider({
      apiKey,
      fetch: (async () =>
        new Response(`{"broken": ${KEY}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      maxRetries: 0,
      logger,
    });
    const err = (await p.complete(base).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("api_error");
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(logger.records)).not.toContain(KEY);
  });

  it("reports an unreachable API as unavailable and a non-API failure as an API error", async () => {
    const down = new AnthropicProvider({
      apiKey,
      fetch: (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch,
      maxRetries: 0,
    });
    await expect(down.complete(base)).rejects.toMatchObject({ code: "provider_unavailable" });
    const odd = new AnthropicProvider({
      apiKey,
      fetch: (() => {
        throw new Error(`boom ${KEY}`);
      }) as typeof fetch,
      maxRetries: 0,
    });
    const err = (await odd.complete(base).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("provider_unavailable");
    expect(err.message).not.toContain(KEY);
  });

  it("retries an unknown model once on the fallback and wraps the fallback's failure", async () => {
    const { fetch, seen } = api((n) =>
      n === 1
        ? { status: 404, body: error("not_found_error") }
        : { status: 429, body: error("rate_limit_error") },
    );
    const p = new AnthropicProvider({
      apiKey,
      model: "claude-gone-1",
      fallbackModel: "claude-opus-4-6",
      fetch,
      maxRetries: 0,
    });
    await expect(p.complete(base)).rejects.toMatchObject({ code: "rate_limited" });
    expect(seen.map((s) => s.body["model"])).toEqual(["claude-gone-1", "claude-opus-4-6"]);
  });

  it("sends caller tools, the base URL and a timeout; reports a missing stop reason", async () => {
    const { fetch, seen } = api(() => ({ status: 200, body: message({ stop_reason: null }) }));
    const p = new AnthropicProvider({
      apiKey,
      model: "claude-opus-4-6",
      fetch,
      baseURL: "https://llm.example.test",
      timeoutMs: 5000,
    });
    const r = await p.complete({
      ...base,
      tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }],
    });
    expect(r).toMatchObject({ text: "hi", stopReason: "unknown" });
    expect(seen[0]!.url.startsWith("https://llm.example.test/")).toBe(true);
    expect(seen[0]!.body["tools"]).toEqual([
      { name: "lookup", description: "d", input_schema: { type: "object" } },
    ]);
  });

  it("serialises without its key", () => {
    const p = new AnthropicProvider({ apiKey, model: "m", fallbackModel: "f" });
    expect(JSON.parse(JSON.stringify(p))).toEqual({
      name: "anthropic",
      model: "m",
      fallbackModel: "f",
    });
  });
});

describe("createProvider options", () => {
  it("passes model, fallback, refusal retry, fetch and logger through", async () => {
    expect(createProvider({ director: { provider: "claude-cli" } })).toBeInstanceOf(CliProvider);
    const codex = createProvider({ director: { provider: "codex-cli", model: "gpt-x" } });
    expect(codex).toMatchObject({ name: "codex-cli", readsWorkspace: false });
    expect(createProvider({ director: { provider: "fake" } })).toBeInstanceOf(FakeProvider);
    const { fetch, seen } = api(() => ({ status: 200, body: message({ stop_reason: "refusal" }) }));
    const logger = createMemoryLogger("warn");
    const p = createProvider(
      {
        director: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          fallbackModel: "claude-sonnet-4-5",
          fallbackOnRefusal: true,
          apiKeySecret: "k",
        },
      },
      { secrets: apiKey.store, fetch, logger },
    ) as AnthropicProvider;
    expect(p).toMatchObject({ fallbackModel: "claude-sonnet-4-5", fallbackOnRefusal: true });
    await expect(p.complete(base)).rejects.toMatchObject({ code: "refused" });
    expect(seen.map((s) => s.body["model"])).toEqual(["claude-opus-4-6", "claude-sonnet-4-5"]);
    expect(logger.records.map((r) => r.msg)).toEqual(["llm.fallback"]);
  });
});

describe("small helpers", () => {
  it("the null logger accepts every level and the memory logger filters below its level", () => {
    for (const level of ["debug", "info", "warn", "error"] as const)
      expect(nullLogger[level]("m", { a: 1 })).toBeUndefined();
    const l = createMemoryLogger();
    l.debug("hidden");
    l.error("shown");
    expect(l.records).toEqual([{ level: "error", msg: "shown" }]);
  });

  it("redacts only secrets of at least four characters", () => {
    expect(redactSecrets("abc abcd", ["abc", undefined, "abcd"])).toBe("abc [REDACTED]");
  });

  it("decodes upper-case hex entities and leaves out-of-range ones", () => {
    expect(normalizeUntrusted("&#X41;&#x110000;&#0;")).toBe("A&#x110000;&#0;");
  });

  it("refuses a nonce that could break the delimiter", () => {
    expect(() => wrapUntrusted("ab cd", "x", "t")).toThrow("invalid data nonce");
  });

  it("keeps details a provider error already has", () => {
    const e = new ProviderError("invalid_output", "m", {
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "a",
      detail: "d",
    });
    expect(e.withDetails({ usage: null, model: "b", detail: "e" })).toMatchObject({
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "a",
      detail: "d",
    });
    expect(new ProviderError("refused", "m").withDetails({})).toMatchObject({
      usage: null,
      model: undefined,
      detail: undefined,
    });
  });

  it("the fake provider reports a non-Error thrown by a responder as an Error", async () => {
    const p = new FakeProvider(() => {
      throw "plain";
    });
    await expect(p.complete(base)).rejects.toThrow("plain");
    const schema = z.object({ n: z.number() });
    const odd = new FakeProvider([{ output: { n: 1 }, model: "m", stopReason: "s" }]);
    expect(await odd.complete({ ...base, responseSchema: schema })).toMatchObject({
      parsed: { n: 1 },
      model: "m",
      stopReason: "s",
    });
  });
});
