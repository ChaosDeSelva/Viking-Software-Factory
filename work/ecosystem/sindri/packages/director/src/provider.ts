import type { z } from "zod";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompleteRequest<T = unknown> {
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxTokens: number;
  temperature: number;
  /** When set, the provider must return `parsed` validated against this schema. */
  responseSchema?: z.ZodType<T>;
  /** Non-prompt metadata (e.g. purpose) for routing/logging. Never sent to the model. */
  metadata?: { purpose?: string };
}

export interface CompleteResult<T = unknown> {
  text: string;
  parsed?: T;
  /** `null` when the provider cannot measure usage. */
  usage: LlmUsage | null;
  model: string;
  stopReason: string;
}

export interface StreamChunk {
  type: "text";
  text: string;
}

/** Provider-neutral LLM interface. Output is advisory; callers validate it. */
export interface LlmProvider {
  readonly name: string;
  complete<T = unknown>(req: CompleteRequest<T>): Promise<CompleteResult<T>>;
  stream?(req: CompleteRequest): AsyncIterable<StreamChunk>;
}

export type ProviderErrorCode =
  "provider_unavailable" | "invalid_output" | "refused" | "auth" | "rate_limited" | "api_error";

export interface ProviderErrorDetails {
  /** Tokens consumed by the failed call, when the provider measured them. */
  usage?: LlmUsage | null;
  /** Model that served the failed call. */
  model?: string;
}

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly usage: LlmUsage | null;
  readonly model: string | undefined;
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    details: ProviderErrorDetails = {},
  ) {
    super(message);
    this.usage = details.usage ?? null;
    this.model = details.model;
  }

  /** Same error with usage/model attached (keeps the code and message). */
  withDetails(details: ProviderErrorDetails): ProviderError {
    return new ProviderError(this.code, this.message, {
      usage: this.usage ?? details.usage ?? null,
      ...((this.model ?? details.model) ? { model: (this.model ?? details.model)! } : {}),
    });
  }
}

/** Validate structured output, throwing `invalid_output` with a short reason. */
export function parseStructured<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const why = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ProviderError("invalid_output", `model output failed validation: ${why}`);
  }
  return r.data;
}
