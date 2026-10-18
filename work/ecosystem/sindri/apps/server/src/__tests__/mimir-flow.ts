import { createFakeMimir, type FakeMimir, type TaskStep } from "@sindri/testing";
import { expect } from "vitest";
import type { BuildServerOptions } from "../app.js";
import { startFlow, type Flow } from "./flow.js";

export const MIMIR_SECRET = "mimir.token";

export interface MimirFlow extends Flow {
  fake: FakeMimir;
}

/** A flow whose settings point at a fake Mimir; the token is resolved via the SecretStore. */
export async function startMimirFlow(
  scripts: Record<string, TaskStep[]> = {},
  opts: Partial<BuildServerOptions> = {},
  stepDelayMs?: number,
): Promise<MimirFlow> {
  const fake = await createFakeMimir({
    scripts,
    ...(stepDelayMs === undefined ? {} : { stepDelayMs }),
  });
  const f = await startFlow({
    secrets: { get: (k) => Promise.resolve(k === MIMIR_SECRET ? fake.token : undefined) },
    ...opts,
  });
  const st = (await f.h.call({ url: "/v1/settings" })).json().settings;
  const put = await f.h.call({
    method: "PUT",
    url: "/v1/settings",
    payload: { ...st, mimirUrl: fake.url, mimirTokenSecret: MIMIR_SECRET },
  });
  expect(put.statusCode).toBe(200);
  return {
    ...f,
    fake,
    async close() {
      await f.close();
      await fake.close();
    },
  };
}

/** Polls `read` until `done` holds (or fails after `ms`). */
export async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
