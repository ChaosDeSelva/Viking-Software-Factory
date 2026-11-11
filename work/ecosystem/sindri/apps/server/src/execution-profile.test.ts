import { describe, expect, it } from "vitest";
import { brokkrHome, profileOf, PROFILE_KEY } from "./execution-profile.js";

describe("execution profile helpers", () => {
  it("reads an invalid stored profile as empty, and a missing one too", () => {
    expect(profileOf({ settings: { [PROFILE_KEY]: { checks: "not a list" } } })).toEqual({});
    expect(profileOf({ settings: {} })).toEqual({});
  });

  it("puts Brokkr's home where SINDRI_BROKKR_HOME says, else in the OS home", () => {
    expect(brokkrHome({ SINDRI_BROKKR_HOME: "/tmp/brokkr" })).toBe("/tmp/brokkr");
    expect(brokkrHome({ SINDRI_BROKKR_HOME: "" })).not.toBe("");
  });
});
