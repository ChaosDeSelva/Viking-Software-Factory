import { describe, expect, it } from "vitest";
import { describeReason } from "./reasonCodes.js";

describe("describeReason", () => {
  it("maps known codes to plain words and keeps the raw code", () => {
    expect(describeReason("verification_report_missing")).toEqual({
      words: "Verification report missing",
      raw: "verification_report_missing",
      known: true,
    });
    expect(describeReason("review_request_changes").words).toBe("Reviewer requested changes");
    expect(describeReason("brokkr_verdict_failed").words).toBe("Brokkr checks failed");
  });

  it("splits a `<gateId> <code>` string and uses gate-specific wording", () => {
    expect(describeReason("brokkr verification_report_missing")).toEqual({
      words: "Verification report missing",
      raw: "brokkr verification_report_missing",
      known: true,
    });
    expect(describeReason("review-verdict review_missing").words).toBe("Review verdict missing");
    expect(describeReason("review_missing", "independent-review")).toEqual({
      words: "Independent review missing",
      raw: "independent-review review_missing",
      known: true,
    });
  });

  it("maps `:detail` suffixes, mapping a suffix that is itself a code", () => {
    expect(describeReason("acceptance_not_met:AC1").words).toBe(
      "Acceptance criterion not met: AC1",
    );
    expect(describeReason("review_request_changes:major_finding").words).toBe(
      "Reviewer requested changes: major finding",
    );
    expect(describeReason("review_request_changes:custom_thing").words).toBe(
      "Reviewer requested changes: custom_thing",
    );
    expect(describeReason("invalid_acceptance:duplicate:AC2").words).toBe(
      "Acceptance criterion assessed twice: AC2",
    );
  });

  it("names a gate Sindri does not configure itself", () => {
    expect(describeReason("command_failed", "lint").words).toBe("lint: required command failed");
  });

  it("shows unknown codes raw, gate included", () => {
    expect(describeReason("something_new")).toEqual({
      words: "something_new",
      raw: "something_new",
      known: false,
    });
    expect(describeReason("brokkr something_new")).toEqual({
      words: "brokkr something_new",
      raw: "brokkr something_new",
      known: false,
    });
    expect(describeReason("something_new", "lint").words).toBe("lint something_new");
  });

  it("never throws on empty input", () => {
    expect(describeReason("")).toEqual({ words: "", raw: "", known: false });
    expect(describeReason(null)).toEqual({ words: "", raw: "", known: false });
    expect(describeReason(undefined, "brokkr")).toEqual({
      words: "brokkr",
      raw: "brokkr",
      known: false,
    });
  });
});
