import { FakeRuntime, ManualClock, type ScriptStep } from "@mimir/fake-runtime";
import type { RuntimeAdapter, RuntimeEvent } from "@mimir/protocol";

export interface WithFakeRuntime {
  fake: FakeRuntime;
  clock: ManualClock;
}

/** A FakeRuntime on a fresh manual clock, optionally with a custom script. */
export function withFakeRuntime(script?: readonly ScriptStep[]): WithFakeRuntime {
  const clock = new ManualClock();
  const fake = new FakeRuntime(script ? { clock, script } : { clock });
  return { fake, clock };
}

export interface CollectOptions {
  /** When given, the clock is advanced in `stepMs` steps until the event arrives. */
  clock?: ManualClock;
  stepMs?: number;
  maxMs?: number;
}

/**
 * Subscribes to `adapter` and resolves with every event up to and including
 * the first one of `untilKind`. With a manual clock, drives it forward.
 */
export async function collectEvents(
  adapter: RuntimeAdapter,
  untilKind: RuntimeEvent["kind"],
  options: CollectOptions = {},
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  let done: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    done = resolve;
  });
  const sub = await adapter.subscribe((e) => {
    events.push(e);
    if (e.kind === untilKind) done?.();
  });
  try {
    const { clock, stepMs = 10, maxMs = 60_000 } = options;
    if (clock) {
      for (let t = 0; t < maxMs && !events.some((e) => e.kind === untilKind); t += stepMs) {
        clock.advance(stepMs);
      }
      if (!events.some((e) => e.kind === untilKind)) {
        throw new Error(`collectEvents: ${untilKind} not seen within ${maxMs}ms`);
      }
    } else {
      await reached;
    }
    return events;
  } finally {
    sub.close();
  }
}
export { SseParser, openSse, type SseConnection, type SseMessage } from "./sse.js";
export * from "./fake-mimir-server.js";
export * from "./chaos/index.js";
export * from "./bench/index.js";
