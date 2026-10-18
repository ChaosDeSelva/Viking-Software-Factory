import {
  parseStructured,
  ProviderError,
  type CompleteRequest,
  type CompleteResult,
  type LlmProvider,
  type LlmUsage,
} from "../provider.js";

export interface FakeResponse {
  text?: string;
  /** Structured output; validated against `responseSchema` when the request has one. */
  output?: unknown;
  /** Defaults to zero usage; `null` means "unavailable". */
  usage?: LlmUsage | null;
  model?: string;
  stopReason?: string;
  /** Throw this instead of responding. */
  error?: Error;
}

export type FakeResponder = (req: CompleteRequest, index: number) => FakeResponse;

/** Scripted provider for tests. Never touches the network. */
export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly calls: CompleteRequest[] = [];
  readonly #script: readonly FakeResponse[] | FakeResponder;

  constructor(script: readonly FakeResponse[] | FakeResponder = []) {
    this.#script = script;
  }

  complete<T = unknown>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    const index = this.calls.length;
    this.calls.push(req as CompleteRequest);
    try {
      const r =
        typeof this.#script === "function"
          ? this.#script(req as CompleteRequest, index)
          : this.#script[index];
      if (!r) throw new ProviderError("provider_unavailable", "no scripted response left");
      if (r.error) throw r.error;
      const result: CompleteResult<T> = {
        text: r.text ?? (r.output === undefined ? "" : JSON.stringify(r.output)),
        usage: r.usage === undefined ? { inputTokens: 0, outputTokens: 0 } : r.usage,
        model: r.model ?? "fake",
        stopReason: r.stopReason ?? "end_turn",
      };
      if (req.responseSchema) {
        try {
          result.parsed = parseStructured(req.responseSchema, r.output);
        } catch (e) {
          throw e instanceof ProviderError
            ? e.withDetails({ usage: result.usage, model: result.model })
            : e;
        }
      }
      return Promise.resolve(result);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
