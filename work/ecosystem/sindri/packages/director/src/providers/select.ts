import type { SecretStore } from "@sindri/intake";
import { nullLogger, type Logger } from "../logger.js";
import type { LlmProvider } from "../provider.js";
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.js";
import { FakeProvider, type FakeResponder, type FakeResponse } from "./fake.js";
import { CliProvider } from "./cli.js";
import { NullProvider } from "./null.js";

export type ProviderKind = "anthropic" | "codex-cli" | "claude-cli" | "fake" | "null";

export interface DirectorConfig {
  director: {
    provider: ProviderKind;
    model?: string;
    fallbackModel?: string;
    /** Retry a refusal on `fallbackModel` (default false). */
    fallbackOnRefusal?: boolean;
    /** SecretStore key holding the Anthropic API key. */
    apiKeySecret?: string;
  };
}

export interface ProviderDeps {
  secrets?: SecretStore;
  fetch?: typeof globalThis.fetch;
  logger?: Logger;
  fakeResponses?: readonly FakeResponse[] | FakeResponder;
}

export const DEFAULT_API_KEY_SECRET = "anthropic.api-key";

/** Build the provider named by `director.provider`. */
export function createProvider(config: DirectorConfig, deps: ProviderDeps = {}): LlmProvider {
  const c = config.director;
  switch (c.provider) {
    case "codex-cli":
    case "claude-cli":
      return new CliProvider({ kind: c.provider, ...(c.model ? { model: c.model } : {}) });
    case "null":
      return new NullProvider();
    case "fake":
      return new FakeProvider(deps.fakeResponses ?? []);
    case "anthropic": {
      if (!deps.secrets)
        throw new Error("the anthropic provider needs a SecretStore for its API key");
      return new AnthropicProvider({
        apiKey: { store: deps.secrets, key: c.apiKeySecret ?? DEFAULT_API_KEY_SECRET },
        model: c.model ?? DEFAULT_ANTHROPIC_MODEL,
        ...(c.fallbackModel ? { fallbackModel: c.fallbackModel } : {}),
        ...(c.fallbackOnRefusal ? { fallbackOnRefusal: true } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        logger: deps.logger ?? nullLogger,
      });
    }
    default:
      throw new Error(`unknown director.provider: ${String(c.provider as unknown)}`);
  }
}
