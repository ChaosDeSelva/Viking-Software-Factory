import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings.js";
import { makeHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("GET /v1/capabilities (review m9)", () => {
  it("reflects the configured Mimir and the Brokkr flag", async () => {
    const hh = (h = await makeHarness());
    expect((await hh.call({ url: "/v1/capabilities" })).json().features).toEqual({
      mimir: false,
      brokkr: false,
    });
    await hh.call({
      method: "PUT",
      url: "/v1/settings",
      payload: {
        ...DEFAULT_SETTINGS,
        mimirUrl: "http://127.0.0.1:7700",
        mimirTokenSecret: "mimir.token",
        brokkrEnabled: true,
      },
    });
    expect((await hh.call({ url: "/v1/capabilities" })).json().features).toEqual({
      mimir: true,
      brokkr: true,
    });
  });
});
