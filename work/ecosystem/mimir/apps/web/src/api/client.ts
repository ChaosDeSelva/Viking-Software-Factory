/**
 * The web UI's only door to Mimir. Everything goes through `@mimir/sdk`; no screen calls fetch.
 *
 * `MimirClient` is the SDK's own type, so `pnpm typecheck` verifies every screen, the test mock
 * and the e2e fixture client against the real SDK.
 */
import { createMimirClient, type FetchLike, type MimirClient } from "@mimir/sdk";

export type { MimirClient };
export type {
  AttentionItem,
  EventsPage,
  GapInfo,
  ReconnectInfo,
  StreamOptions,
  StreamStatus,
  TerminalReadResponse,
} from "@mimir/sdk";

export interface ClientOptions {
  baseUrl: string;
  token: string;
  /** Tests only. */
  fetch?: FetchLike;
}

/** Builds the SDK client (no cast: the result is the SDK's `MimirClient`). */
export function createClient(opts: ClientOptions): MimirClient {
  return createMimirClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  }) satisfies MimirClient;
}

export interface DescribedError {
  code: string | null;
  message: string;
}

/** Turns anything thrown by the SDK into a code + message for display. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (error.name === "MimirError" && typeof code === "string") {
      return { code, message: error.message };
    }
    return { code: null, message: error.message };
  }
  return { code: null, message: "Unknown error" };
}

/** True when the server rejected our token. */
export function isUnauthorized(error: unknown): boolean {
  return describeError(error).code === "unauthorized";
}
