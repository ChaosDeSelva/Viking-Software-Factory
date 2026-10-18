import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvSecretStore } from "@sindri/intake";
import { createMemoryLogger } from "../logger.js";
import { ProviderError } from "../provider.js";
import { AnthropicProvider, modelCapabilities } from "./anthropic.js";
import { FakeProvider } from "./fake.js";
import { NullProvider } from "./null.js";
import { createProvider } from "./select.js";

const base = {
  system: "SYSTEM-PROMPT-MARKER",
  messages: [{ role: "user" as const, content: "USER-PROMPT-MARKER" }],
  maxTokens: 100,
  temperature: 0,
};

describe("FakeProvider", () => {
  it("returns scripted responses in order and records calls", async () => {
    const p = new FakeProvider([{ text: "one" }, { text: "two", usage: null }]);
    const a = await p.complete(base);
    const b = await p.complete(base);
    expect(a.text).toBe("one");
    expect(a.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(a.model).toBe("fake");
    expect(a.stopReason).toBe("end_turn");
    expect(b.usage).toBeNull();
    expect(p.calls).toHaveLength(2);
    await expect(p.complete(base)).rejects.toThrow(/no scripted response/);
  });

  it("validates structured output against the response schema", async () => {
    const schema = z.object({ n: z.number() });
    const p = new FakeProvider([{ output: { n: 3 } }, { output: { n: "x" } }]);
    expect((await p.complete({ ...base, responseSchema: schema })).parsed).toEqual({ n: 3 });
    const err = await p.complete({ ...base, responseSchema: schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("invalid_output");
  });

  it("supports responder functions keyed on request metadata", async () => {
    const p = new FakeProvider((req) => ({ text: req.metadata?.purpose ?? "none" }));
    expect((await p.complete({ ...base, metadata: { purpose: "classify" } })).text).toBe(
      "classify",
    );
  });
});

describe("NullProvider", () => {
  it("throws provider_unavailable", async () => {
    const err = await new NullProvider().complete(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("provider_unavailable");
  });
});

const KEY = "sk-ant-test-SECRET-KEY-123456";
// Credentials must be SecretStore handles (literal strings are rejected by @sindri/intake).
const KEY_HANDLE = {
  store: new EnvSecretStore({ env: { SINDRI_SECRET_ANTHROPIC_TEST_KEY: KEY } }),
  key: "anthropic.test-key",
};

function anthropicFetch(response: unknown, status = 200) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json", "request-id": "req_1" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const toolResponse = (model: string, input: unknown) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "tool_use", id: "tu_1", name: "structured_output", input }],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 34 },
});

describe("AnthropicProvider", () => {
  const secrets = new EnvSecretStore({ env: { SINDRI_SECRET_ANTHROPIC_API_KEY: KEY } });
  const schema = z.object({ kind: z.enum(["feature", "bug"]), confidence: z.number() });

  it("sends a forced single-tool structured-output call and never logs the key", async () => {
    const { fetch, requests } = anthropicFetch(
      toolResponse("claude-opus-4-6", { kind: "bug", confidence: 0.8 }),
    );
    const logger = createMemoryLogger("debug");
    const p = new AnthropicProvider({
      apiKey: { store: secrets, key: "anthropic.api-key" },
      model: "claude-opus-4-6",
      fetch,
      logger,
    });
    const res = await p.complete({ ...base, responseSchema: schema });
    expect(res.parsed).toEqual({ kind: "bug", confidence: 0.8 });
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
    expect(res.stopReason).toBe("tool_use");
    expect(res.model).toBe("claude-opus-4-6");

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers.get("x-api-key")).toBe(KEY);
    expect(req.body.model).toBe("claude-opus-4-6");
    expect(req.body.max_tokens).toBe(100);
    expect(req.body.system).toBe("SYSTEM-PROMPT-MARKER");
    expect(req.body.messages).toEqual([{ role: "user", content: "USER-PROMPT-MARKER" }]);
    const tools = req.body.tools as { name: string; input_schema: Record<string, unknown> }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("structured_output");
    expect(tools[0]!.input_schema).toMatchObject({
      type: "object",
      required: ["kind", "confidence"],
      additionalProperties: false,
    });
    expect(tools[0]!.input_schema).not.toHaveProperty("$schema");
    expect(req.body.tool_choice).toEqual({
      type: "tool",
      name: "structured_output",
      disable_parallel_tool_use: true,
    });

    const logged = JSON.stringify(logger.records);
    expect(logger.records.length).toBeGreaterThan(0);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("SYSTEM-PROMPT-MARKER");
    expect(logged).not.toContain("USER-PROMPT-MARKER");
    expect(
      logger.records.filter((r) => r.level === "info").map((r) => r.fields),
    ).not.toContainEqual(expect.objectContaining({ system: expect.anything() }));
  });

  it("uses auto tool choice (no forced tool) and omits temperature on models that reject them", async () => {
    const { fetch, requests } = anthropicFetch(
      toolResponse("claude-fable-5-1", { kind: "feature", confidence: 0.5 }),
    );
    const p = new AnthropicProvider({ apiKey: KEY_HANDLE, fetch });
    const res = await p.complete({ ...base, responseSchema: schema });
    expect(res.parsed).toEqual({ kind: "feature", confidence: 0.5 });
    const body = requests[0]!.body;
    expect(body.model).toBe("claude-fable-5-1");
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(body).not.toHaveProperty("temperature");
    expect(String(body.system)).toMatch(/structured_output/);
  });

  it("rejects invalid structured output", async () => {
    const { fetch } = anthropicFetch(toolResponse("claude-opus-4-6", { kind: "nope" }));
    const p = new AnthropicProvider({ apiKey: KEY_HANDLE, model: "claude-opus-4-6", fetch });
    const err = await p.complete({ ...base, responseSchema: schema }).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("invalid_output");
  });

  it("returns plain text responses without a schema", async () => {
    const { fetch, requests } = anthropicFetch({
      ...toolResponse("claude-opus-4-6", {}),
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
    });
    const p = new AnthropicProvider({ apiKey: KEY_HANDLE, model: "claude-opus-4-6", fetch });
    const res = await p.complete(base);
    expect(res.text).toBe("hello");
    expect(requests[0]!.body).not.toHaveProperty("tools");
    expect(requests[0]!.body.temperature).toBe(0);
  });

  it("scrubs the key from API errors and logs", async () => {
    const { fetch } = anthropicFetch(
      { type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` } },
      401,
    );
    const logger = createMemoryLogger("debug");
    const p = new AnthropicProvider({
      apiKey: KEY_HANDLE,
      model: "claude-opus-4-6",
      fetch,
      logger,
    });
    const err = await p.complete(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("auth");
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(JSON.stringify(logger.records)).not.toContain(KEY);
  });

  it("retries once on the fallback model when the primary refuses", async () => {
    let n = 0;
    const requests: string[] = [];
    const fetch = (async (_i: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requests.push(body.model);
      n++;
      const payload =
        n === 1
          ? { ...toolResponse(body.model, {}), content: [], stop_reason: "refusal" }
          : {
              ...toolResponse(body.model, {}),
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const p = new AnthropicProvider({
      apiKey: KEY_HANDLE,
      model: "claude-fable-5-1",
      fallbackModel: "claude-opus-5-5",
      fallbackOnRefusal: true,
      fetch,
    });
    const res = await p.complete(base);
    expect(requests).toEqual(["claude-fable-5-1", "claude-opus-5-5"]);
    expect(res.model).toBe("claude-opus-5-5");
    expect(res.text).toBe("ok");
  });
});

describe("AnthropicProvider structured output on the auto tool_choice path", () => {
  const schema = z.object({ kind: z.enum(["feature", "bug"]), confidence: z.number() });
  const run = async (payload: Record<string, unknown>) => {
    const { fetch } = anthropicFetch({
      ...toolResponse("claude-fable-5-1", {}),
      usage: { input_tokens: 500, output_tokens: 70 },
      ...payload,
    });
    const p = new AnthropicProvider({ apiKey: KEY_HANDLE, fetch });
    return (await p
      .complete({ ...base, responseSchema: schema })
      .catch((e: unknown) => e)) as ProviderError;
  };

  it("rejects a text-only answer that ignores the tool", async () => {
    const err = await run({
      content: [{ type: "text", text: '{"kind":"bug","confidence":1}' }],
      stop_reason: "end_turn",
    });
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("invalid_output");
    expect(err.message).toMatch(/did not return structured output/);
    expect(err.usage).toEqual({ inputTokens: 500, outputTokens: 70 });
    expect(err.model).toBe("claude-fable-5-1");
  });

  it("rejects a call to a different tool", async () => {
    const err = await run({
      content: [
        { type: "tool_use", id: "tu_9", name: "other_tool", input: { kind: "bug", confidence: 1 } },
      ],
    });
    expect(err.code).toBe("invalid_output");
    expect(err.usage).toEqual({ inputTokens: 500, outputTokens: 70 });
  });

  it("rejects output truncated at max_tokens with an explicit reason", async () => {
    const err = await run({
      content: [
        { type: "tool_use", id: "tu_1", name: "structured_output", input: { kind: "bug" } },
      ],
      stop_reason: "max_tokens",
    });
    expect(err.code).toBe("invalid_output");
    expect(err.message).toMatch(/truncated at max_tokens/);
    expect(err.usage).toEqual({ inputTokens: 500, outputTokens: 70 });
  });

  it("does not retry a refusal on another model unless opted in, and reports usage", async () => {
    const requests: string[] = [];
    const fetch = (async (_i: unknown, init?: RequestInit) => {
      requests.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return new Response(
        JSON.stringify({
          ...toolResponse("claude-fable-5-1", {}),
          content: [],
          stop_reason: "refusal",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    const p = new AnthropicProvider({
      apiKey: KEY_HANDLE,
      fallbackModel: "claude-opus-5-5",
      fetch,
    });
    const err = (await p.complete(base).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("refused");
    expect(err.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
    expect(requests).toEqual(["claude-fable-5-1"]);
  });
});

describe("modelCapabilities", () => {
  it.each([
    ["claude-opus-4-20250514", true, true],
    ["claude-opus-4-1", true, true],
    ["claude-opus-4-6", true, true],
    ["claude-opus-4-7", true, false],
    ["claude-opus-4-8", true, false],
    ["claude-sonnet-4-6", true, true],
    ["claude-haiku-4-5", true, true],
    ["claude-opus-5", false, false],
    ["claude-opus-5-5", false, false],
    ["claude-fable-5-1", false, false],
    ["claude-future-9", false, false],
  ])("%s -> forced %s, temperature %s", (model, forced, temperature) => {
    expect(modelCapabilities(model)).toEqual({ forcedToolChoice: forced, temperature });
  });
});

describe("FakeProvider errors", () => {
  it("attaches usage and model to invalid_output", async () => {
    const p = new FakeProvider([
      { output: { n: "x" }, model: "m1", usage: { inputTokens: 9, outputTokens: 2 } },
    ]);
    const err = (await p
      .complete({ ...base, responseSchema: z.object({ n: z.number() }) })
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("invalid_output");
    expect(err.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
    expect(err.model).toBe("m1");
  });
});

describe("createProvider", () => {
  it("selects by director.provider config", () => {
    expect(createProvider({ director: { provider: "null" } })).toBeInstanceOf(NullProvider);
    expect(
      createProvider({ director: { provider: "fake" } }, { fakeResponses: [] }),
    ).toBeInstanceOf(FakeProvider);
    const secrets = new EnvSecretStore({ env: {} });
    const a = createProvider(
      { director: { provider: "anthropic", model: "claude-opus-5-5" } },
      { secrets },
    );
    expect(a).toBeInstanceOf(AnthropicProvider);
    expect((a as AnthropicProvider).model).toBe("claude-opus-5-5");
    expect(
      (createProvider({ director: { provider: "anthropic" } }, { secrets }) as AnthropicProvider)
        .model,
    ).toBe("claude-fable-5-1");
    expect(() => createProvider({ director: { provider: "anthropic" } })).toThrow(/secret/i);
    expect(() => createProvider({ director: { provider: "bogus" as never } })).toThrow(
      /unknown director.provider/,
    );
  });

  it("anthropic provider without a stored key fails with provider_unavailable", async () => {
    const p = createProvider(
      { director: { provider: "anthropic" } },
      {
        secrets: new EnvSecretStore({ env: {} }),
        fetch: (() => {
          throw new Error("no network");
        }) as unknown as typeof fetch,
      },
    );
    const err = await p.complete(base).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("provider_unavailable");
  });
});
