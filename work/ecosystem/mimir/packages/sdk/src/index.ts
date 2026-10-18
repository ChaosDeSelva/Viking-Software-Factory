export const PACKAGE_NAME = "@mimir/sdk";

export {
  createMimirClient,
  type ArtifactContent,
  type MimirClient,
  type MimirClientOptions,
} from "./client.js";
export {
  DEFAULT_EVENTS_PAGE_LIMIT,
  normalizePage,
  type EventFilter,
  type EventsPage,
  type EventStream,
  type GapInfo,
  type InvalidEventInfo,
  type ReconnectInfo,
  type ReplayAllOptions,
  type ReplayAllResult,
  type StreamOptions,
  type StreamStatus,
} from "./events.js";
export {
  errorFromResponse,
  randomKey,
  type FetchLike,
  type MutationOptions,
  type RequestOptions,
  type TokenSource,
} from "./http.js";
export {
  ATTENTION_KINDS,
  type AttentionItem,
  type AttentionKind,
  type AttentionResponse,
  type TerminalReadResponse,
} from "./provisional.js";
export { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from "./backoff.js";
export { SseParser, type SseMessage, type SseParserHooks } from "./sse.js";
// Re-exported so callers can `catch (e) { if (isMimirError(e)) ... }` without a second import.
export { IDEMPOTENCY_HEADER, MimirError, isMimirError } from "@mimir/protocol";
