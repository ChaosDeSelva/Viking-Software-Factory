import type { EventEnvelope } from "@mimir/protocol";
import { newId } from "@mimir/protocol";
import { vi } from "vitest";
import type { EventStream } from "@mimir/sdk";
import type { EventsPage, MimirClient, StreamOptions } from "../api/client.js";
import { snapshot } from "./fixtures.js";

/** A push-driven stand-in for `client.events.stream`. */
export class StreamController {
  calls: (StreamOptions & { signal: AbortSignal })[] = [];
  private queue: EventEnvelope[] = [];
  private waiters: ((r: IteratorResult<EventEnvelope>) => void)[] = [];
  private failure: unknown = null;
  private failWaiters: ((e: unknown) => void)[] = [];

  get last(): (StreamOptions & { signal: AbortSignal }) | undefined {
    return this.calls[this.calls.length - 1];
  }

  push(event: EventEnvelope): void {
    const w = this.waiters.shift();
    this.failWaiters.shift();
    if (w) w({ value: event, done: false });
    else this.queue.push(event);
  }

  fail(error: unknown): void {
    this.failure = error;
    const f = this.failWaiters.shift();
    this.waiters.shift();
    if (f) f(error);
  }

  iterable = (options?: StreamOptions): EventStream => {
    const opts = { ...options, signal: options?.signal ?? new AbortController().signal };
    this.calls.push(opts);
    this.failure = null;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      cursor: undefined,
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<EventEnvelope>> {
            if (opts.signal.aborted) return Promise.resolve({ value: undefined, done: true });
            const queued = self.queue.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (self.failure !== null) return Promise.reject(self.failure);
            return new Promise((resolve, reject) => {
              self.waiters.push(resolve);
              self.failWaiters.push(reject);
              opts.signal.addEventListener("abort", () =>
                resolve({ value: undefined, done: true }),
              );
            });
          },
        };
      },
    };
  };
}

/** An `EventsPage` as the SDK returns it. */
export function page(events: EventEnvelope[], nextCursor: string | null = null): EventsPage {
  return { events, nextCursor, hasMore: nextCursor !== null, lastCursor: nextCursor };
}

export type MockClient = MimirClient & { streamController: StreamController };

export function accepted() {
  return { operationId: newId("op"), commandId: newId("cmd") };
}

/** Builds a fully mocked SDK client. Every method is a `vi.fn`. */
export function mockClient(over: Partial<MimirClient> = {}): MockClient {
  const streamController = new StreamController();
  const client: MockClient = {
    streamController,
    health: vi.fn(async () => ({ status: "ok" as const })),
    capabilities: vi.fn(async () => ({
      serverVersion: "0.1.0",
      protocolVersion: 1 as const,
      runtime: {
        runtime: "fake",
        version: "1",
        features: {
          createSession: true,
          sendInput: true,
          sendKeys: true,
          softStop: true,
          forceStop: true,
          pause: false,
          subscribe: true,
          terminalRead: true,
          processInfo: false,
          multiHost: false,
          notify: false,
        },
        agentKinds: ["shell", "claude"],
      },
    })),
    snapshot: vi.fn(async () => snapshot()),
    projects: {
      list: vi.fn(async () => ({ projects: [] })),
      create: vi.fn(),
    },
    missions: {
      list: vi.fn(async () => ({ missions: [] })),
      get: vi.fn(),
      create: vi.fn(),
      start: vi.fn(async () => accepted()),
      cancel: vi.fn(async () => accepted()),
    },
    crews: { list: vi.fn(async () => ({ crews: [] })), create: vi.fn() },
    tasks: {
      list: vi.fn(async () => ({ tasks: [] })),
      create: vi.fn(),
      retry: vi.fn(async () => accepted()),
      requestPr: vi.fn(async () => ({ ...accepted(), status: "delivered" as const })),
    },
    approvals: {
      list: vi.fn(async () => ({ approvals: [] })),
      decide: vi.fn(async () => accepted()),
    },
    sessions: {
      input: vi.fn(async () => accepted()),
      stop: vi.fn(async () => accepted()),
      terminal: vi.fn(async () => ({ text: "$ echo hi\nhi\n", provenance: "observed" as const })),
    },
    events: {
      list: vi.fn(async () => page([])),
      stream: vi.fn(streamController.iterable),
      replayAll: vi.fn(async () => ({ events: [], cursor: "c0" })),
    },
    attention: { list: vi.fn(async () => ({ items: [] })) },
    artifacts: { get: vi.fn(), content: vi.fn() },
    usage: {
      get: vi.fn(async () => ({
        totals: {
          tokens: 0,
          estimatedCost: 0,
          samples: 0,
          bySource: { measured: 0, estimated: 0, unavailable: 0 },
        },
        samples: [],
      })),
    },
    ...over,
  };
  return client;
}
