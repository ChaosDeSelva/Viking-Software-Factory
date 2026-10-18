import {
  ProviderError,
  type CompleteRequest,
  type CompleteResult,
  type LlmProvider,
} from "../provider.js";

/** Provider used when no model is configured: every call fails with `provider_unavailable`. */
export class NullProvider implements LlmProvider {
  readonly name = "null";
  complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    void req;
    return Promise.reject(
      new ProviderError(
        "provider_unavailable",
        "no LLM provider is configured (director.provider = null)",
      ),
    );
  }
}
