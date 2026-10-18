export const PACKAGE_NAME = "@sindri/director";

export {
  ClassificationSchema,
  DirectorError,
  DraftOutputSchema,
  intakeProblem,
  keywords,
  openDirector,
  type AnswerRecord,
  type Classification,
  type ContextItem,
  type ContextKind,
  type Director,
  type DirectorContext,
  type DirectorSpecMeta,
  type DraftOutput,
  type DraftSpecInput,
  type DraftSpecResult,
  type OpenDirectorOptions,
  type RepoAnalysis,
  type UnverifiedClaim,
} from "./director.js";
export {
  parseStructured,
  ProviderError,
  type CompleteRequest,
  type CompleteResult,
  type LlmMessage,
  type LlmProvider,
  type LlmToolDefinition,
  type LlmUsage,
  type ProviderErrorCode,
  type ProviderErrorDetails,
  type StreamChunk,
} from "./provider.js";
export {
  AnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  modelCapabilities,
  STRUCTURED_OUTPUT_TOOL,
  type AnthropicProviderOptions,
} from "./providers/anthropic.js";
export { FakeProvider, type FakeResponder, type FakeResponse } from "./providers/fake.js";
export { NullProvider } from "./providers/null.js";
export {
  createProvider,
  DEFAULT_API_KEY_SECRET,
  type DirectorConfig,
  type ProviderDeps,
  type ProviderKind,
} from "./providers/select.js";
export {
  createMemoryLogger,
  describeText,
  nullLogger,
  redactSecrets,
  type LogFields,
  type Logger,
  type LogLevel,
  type LogRecord,
} from "./logger.js";
export {
  createDataNonce,
  detectInjection,
  normalizeUntrusted,
  INJECTION_PATTERNS,
  REDACTION_MARKER,
  redactInjections,
  wrapUntrusted,
  type InjectionFinding,
  type InjectionPattern,
} from "./untrusted.js";
export { classifySystem, dataRules, DRAFT_INSTRUCTIONS, draftSpecSystem } from "./prompts.js";
export { estimateCost, listRuns, MODEL_PRICES, recordRun, type DirectorRun } from "./runs.js";
export { DIRECTOR_MIGRATIONS } from "./schema.js";

export { CliProvider, type CliProviderKind, type CliProviderOptions } from "./providers/cli.js";
