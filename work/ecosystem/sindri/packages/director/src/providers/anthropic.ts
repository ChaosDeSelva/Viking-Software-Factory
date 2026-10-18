import Anthropic from "@anthropic-ai/sdk";
import { resolveSecret, type SecretSource } from "@sindri/intake";
import { z } from "zod";
import { describeText, nullLogger, redactSecrets, type Logger } from "../logger.js";
import {
  parseStructured,
  ProviderError,
  type CompleteRequest,
  type CompleteResult,
  type LlmProvider,
} from "../provider.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5-1";
export const STRUCTURED_OUTPUT_TOOL = "structured_output";

export interface AnthropicProviderOptions {
  /** Literal key or a SecretStore handle, resolved on every call (never cached in logs). */
  apiKey: SecretSource;
  model?: string;
  /** Retried once when the primary model id is unknown (404). */
  fallbackModel?: string;
  /** Also retry a refusal on `fallbackModel`. Off by default: re-asking a declined prompt is a policy choice. */
  fallbackOnRefusal?: boolean;
  fetch?: typeof globalThis.fetch;
  baseURL?: string;
  maxRetries?: number;
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Request capabilities by model id. Forced `tool_choice` is only sent to models known to
 * accept it with thinking off by default; newer models (e.g. Fable 5.1, Opus 5.5) reject
 * forced tool use and sampling parameters with a 400, so they get `auto` + an instruction.
 * Unknown ids are treated conservatively (no forced tool, no temperature).
 */
export function modelCapabilities(model: string): {
  forcedToolChoice: boolean;
  temperature: boolean;
} {
  const legacy = /^claude-(3|haiku-4|sonnet-4|opus-4)/.test(model);
  return {
    forcedToolChoice: legacy,
    // Opus 4.0 dated ids (claude-opus-4-YYYYMMDD) through 4.6 accept sampling params; 4.7+ do not.
    temperature: /^claude-(3|haiku-4|sonnet-4|opus-4(?:-[0-6](?!\d)|-\d{8}|$))/.test(model),
  };
}

const toolInputSchema = (schema: z.ZodType): Anthropic.Tool.InputSchema => {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json as Anthropic.Tool.InputSchema;
};

/** Claude via the official `@anthropic-ai/sdk`, with structured output via one tool call. */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  readonly fallbackModel: string | undefined;
  readonly fallbackOnRefusal: boolean;
  readonly #apiKey: SecretSource;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #baseURL: string | undefined;
  readonly #maxRetries: number;
  readonly #timeoutMs: number | undefined;
  readonly #log: Logger;

  constructor(options: AnthropicProviderOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.fallbackModel = options.fallbackModel;
    this.fallbackOnRefusal = options.fallbackOnRefusal ?? false;
    this.#fetch = options.fetch;
    this.#baseURL = options.baseURL;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#timeoutMs = options.timeoutMs;
    this.#log = options.logger ?? nullLogger;
  }

  /** Keep the key out of `JSON.stringify` / `util.inspect`. */
  toJSON() {
    return { name: this.name, model: this.model, fallbackModel: this.fallbackModel };
  }

  async complete<T = unknown>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    let key: string;
    try {
      key = await resolveSecret(this.#apiKey);
    } catch {
      throw new ProviderError("provider_unavailable", "Anthropic API key is not available");
    }
    const client = new Anthropic({
      apiKey: key,
      maxRetries: this.#maxRetries,
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
      ...(this.#baseURL ? { baseURL: this.#baseURL } : {}),
      ...(this.#timeoutMs ? { timeout: this.#timeoutMs } : {}),
    });
    try {
      return await this.#call(client, this.model, req);
    } catch (e) {
      const retryable =
        e instanceof ProviderError
          ? e.code === "refused" && this.fallbackOnRefusal
          : e instanceof Anthropic.NotFoundError;
      if (retryable && this.fallbackModel && this.fallbackModel !== this.model) {
        this.#log.warn("llm.fallback", { from: this.model, to: this.fallbackModel });
        try {
          return await this.#call(client, this.fallbackModel, req);
        } catch (e2) {
          throw this.#wrap(e2, key);
        }
      }
      throw this.#wrap(e, key);
    }
  }

  async #call<T>(
    client: Anthropic,
    model: string,
    req: CompleteRequest<T>,
  ): Promise<CompleteResult<T>> {
    const caps = modelCapabilities(model);
    const tools: Anthropic.Tool[] = (req.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    let system = req.system;
    let toolChoice: Anthropic.ToolChoice | undefined;
    if (req.responseSchema) {
      tools.push({
        name: STRUCTURED_OUTPUT_TOOL,
        description: "Return the final answer. Call this exactly once with the complete result.",
        input_schema: toolInputSchema(req.responseSchema),
      });
      if (caps.forcedToolChoice) {
        toolChoice = {
          type: "tool",
          name: STRUCTURED_OUTPUT_TOOL,
          disable_parallel_tool_use: true,
        };
      } else {
        toolChoice = { type: "auto", disable_parallel_tool_use: true };
        system += `\n\nRespond only by calling the \`${STRUCTURED_OUTPUT_TOOL}\` tool exactly once with your complete answer.`;
      }
    }
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: req.maxTokens,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(tools.length ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(caps.temperature ? { temperature: req.temperature } : {}),
    };
    this.#log.info("llm.request", {
      provider: this.name,
      model,
      purpose: req.metadata?.purpose,
      maxTokens: req.maxTokens,
      tools: tools.length,
      structured: !!req.responseSchema,
    });
    this.#log.debug("llm.request.detail", {
      system: describeText(system),
      messages: req.messages.map((m) => ({ role: m.role, content: describeText(m.content) })),
    });

    const res = await client.messages.create(params);
    this.#log.info("llm.response", {
      model: res.model,
      stopReason: res.stop_reason,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    });
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    const details = { usage, model: res.model };
    if (res.stop_reason === "refusal") {
      throw new ProviderError("refused", `model ${model} declined the request`, details);
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const result: CompleteResult<T> = {
      text,
      usage,
      model: res.model,
      stopReason: res.stop_reason ?? "unknown",
    };
    if (req.responseSchema) {
      const call = res.content.find(
        (b): b is Anthropic.ToolUseBlock =>
          b.type === "tool_use" && b.name === STRUCTURED_OUTPUT_TOOL,
      );
      if (res.stop_reason === "max_tokens") {
        throw new ProviderError(
          "invalid_output",
          `structured output truncated at max_tokens (${req.maxTokens}); raise maxTokens`,
          details,
        );
      }
      if (!call) {
        throw new ProviderError(
          "invalid_output",
          "model did not return structured output",
          details,
        );
      }
      try {
        result.parsed = parseStructured(req.responseSchema, call.input);
      } catch (e) {
        throw e instanceof ProviderError ? e.withDetails(details) : e;
      }
    }
    return result;
  }

  #wrap(e: unknown, key: string): Error {
    if (e instanceof ProviderError) return e;
    const msg = redactSecrets(e instanceof Error ? e.message : String(e), [key]);
    let err: ProviderError;
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
      err = new ProviderError("auth", `Anthropic authentication failed (${e.status})`);
    else if (e instanceof Anthropic.RateLimitError)
      err = new ProviderError("rate_limited", "Anthropic rate limit exceeded");
    else if (e instanceof Anthropic.APIConnectionError)
      err = new ProviderError("provider_unavailable", "cannot reach the Anthropic API");
    else if (e instanceof Anthropic.APIError)
      err = new ProviderError("api_error", `Anthropic API error ${String(e.status)}: ${msg}`);
    else err = new ProviderError("api_error", msg);
    this.#log.error("llm.error", { code: err.code, message: err.message });
    return err;
  }
}
