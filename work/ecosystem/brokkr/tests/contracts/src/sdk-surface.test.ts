/**
 * Consumer contract for @brokkr/sdk (spec §12.2, §18.3). These tests pin what
 * Mimir- and Sindri-style consumers rely on. A failure here means a breaking
 * change: update docs/compatibility.md and CHANGELOG.md, or fix the change.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import * as sdk from "@brokkr/sdk";
import * as testing from "@brokkr/sdk/testing";
import {
  Brokkr,
  type ApprovedException,
  type BrokkrOptions,
  type HarnessLock,
  type HarnessRequest,
  type PolicyLayer,
  type TrustMode,
  type CheckExecutor,
  type HarnessSummary,
  type PreparedContext,
  type RepoSignals,
  type ResolveInput,
  type Selection,
  type StoredReport,
  type VerificationEvent,
  type VerificationReport,
  type VerifyInput,
} from "@brokkr/sdk";
import { MockExecutor } from "@brokkr/sdk/testing";

describe("@brokkr/sdk runtime exports", () => {
  it("exports exactly the documented values", () => {
    expect(Object.keys(sdk).sort()).toEqual(
      [
        "Brokkr",
        "BrokkrError",
        "CHECK_REASONS",
        "EVENT_SCHEMA_VERSION",
        "EXIT_CODES",
        "LocalProcessExecutor",
        "PROVIDERS",
        "REPORT_FORMATS",
        "REPORT_SCHEMA_VERSION",
        "SELECTION_SCHEMA_VERSION",
        "SelectionSchema",
        "TRUST_MODES",
        "VERIFICATION_EVENT_TYPES",
        "VerificationEventSchema",
        "VerificationReportSchema",
        "exitCodeForVerdict",
        "renderReport",
        "selectionJsonSchema",
        "verificationEventJsonSchema",
        "verificationReportJsonSchema",
      ].sort(),
    );
    expect(Object.keys(testing).sort()).toEqual(["MockExecutor"]);
  });

  it("defaults to trust: 'workspace-untrusted'", () => {
    expect(new Brokkr({ cwd: "." }).trust).toBe("workspace-untrusted");
  });

  it("pins the constants consumers branch on", () => {
    expect(sdk.EVENT_SCHEMA_VERSION).toBe(1);
    expect(sdk.SELECTION_SCHEMA_VERSION).toBe(1);
    expect(sdk.REPORT_SCHEMA_VERSION).toBe("1.0");
    expect(sdk.PROVIDERS).toEqual(["claude-code", "codex", "generic"]);
    expect(sdk.TRUST_MODES).toEqual(["workspace-untrusted", "developer"]);
    expect(sdk.VERIFICATION_EVENT_TYPES).toEqual([
      "verification.started",
      "verification.check.started",
      "verification.check.completed",
      "verification.completed",
      "verification.failed",
      "verification.cancelled",
    ]);
    expect(sdk.EXIT_CODES).toEqual({
      ok: 0,
      verificationFailed: 1,
      invalidConfig: 2,
      infraError: 3,
      policyDenied: 4,
      interrupted: 130,
    });
  });
});

describe("@brokkr/sdk types (spec §12.2)", () => {
  it("constructor options", () => {
    expectTypeOf<BrokkrOptions>().toHaveProperty("cwd").toEqualTypeOf<string>();
    expectTypeOf<BrokkrOptions["offline"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<BrokkrOptions["executor"]>().toEqualTypeOf<CheckExecutor | undefined>();
    expectTypeOf<BrokkrOptions>().toHaveProperty("logger");
    expectTypeOf<BrokkrOptions["trust"]>().toEqualTypeOf<TrustMode | undefined>();
    expectTypeOf<BrokkrOptions["lock"]>().toEqualTypeOf<HarnessLock | undefined>();
    expectTypeOf<BrokkrOptions["exceptions"]>().toEqualTypeOf<ApprovedException[] | undefined>();
    expectTypeOf<BrokkrOptions["policy"]>().toEqualTypeOf<PolicyLayer | undefined>();
    expectTypeOf<BrokkrOptions["harnesses"]>().toEqualTypeOf<HarnessRequest[] | undefined>();
    expectTypeOf(Brokkr).constructorParameters.toEqualTypeOf<[BrokkrOptions]>();
  });

  it("method signatures", () => {
    expectTypeOf<Brokkr["resolve"]>().parameters.toEqualTypeOf<[ResolveInput]>();
    expectTypeOf<Brokkr["resolve"]>().returns.resolves.toEqualTypeOf<Selection>();
    expectTypeOf<Brokkr["prepare"]>().returns.resolves.toEqualTypeOf<PreparedContext>();
    expectTypeOf<Brokkr["verify"]>().parameters.toEqualTypeOf<[VerifyInput]>();
    expectTypeOf<Brokkr["verify"]>().returns.resolves.toEqualTypeOf<VerificationReport>();
    expectTypeOf<Brokkr["readReport"]>().parameters.toEqualTypeOf<[string]>();
    expectTypeOf<Brokkr["readReport"]>().returns.resolves.toEqualTypeOf<StoredReport>();
    expectTypeOf<Brokkr["listHarnesses"]>().returns.resolves.toEqualTypeOf<HarnessSummary[]>();
    expectTypeOf<Brokkr["inspectRepo"]>().returns.resolves.toEqualTypeOf<RepoSignals>();
  });

  it("resolve takes a profile or harnesses, never both", () => {
    const task = { id: "T-1", title: "t", description: "d" };
    expectTypeOf({ task, profile: "fullstack" }).toExtend<ResolveInput>();
    expectTypeOf({ task, harnesses: [{ name: "x", version: "^1" }] }).toExtend<ResolveInput>();
    expectTypeOf({ task }).toExtend<ResolveInput>();
    expectTypeOf({
      task,
      profile: "fullstack",
      harnesses: [{ name: "x", version: "^1" }],
    }).not.toExtend<ResolveInput>();
  });

  it("Selection { harnesses, skills, lock, rationale }", () => {
    expectTypeOf<Selection>().toHaveProperty("harnesses");
    expectTypeOf<Selection>().toHaveProperty("skills");
    expectTypeOf<Selection>().toHaveProperty("lock");
    expectTypeOf<Selection>().toHaveProperty("rationale");
    expectTypeOf<Selection["lock"]["digest"]>().toEqualTypeOf<string>();
  });

  it("verify input: selection, workspace, task?, signal?, onEvent?; no verdict override exists", () => {
    expectTypeOf<VerifyInput["selection"]>().toEqualTypeOf<Selection>();
    expectTypeOf<VerifyInput["workspace"]>().toEqualTypeOf<string>();
    expectTypeOf<VerifyInput["signal"]>().toEqualTypeOf<AbortSignal | undefined>();
    expectTypeOf<VerifyInput["onEvent"]>().toEqualTypeOf<
      ((event: VerificationEvent) => void) | undefined
    >();
    expectTypeOf<VerifyInput>().not.toHaveProperty("verdict");
    expectTypeOf<BrokkrOptions>().not.toHaveProperty("verdict");
  });

  it("every event carries the envelope", () => {
    expectTypeOf<VerificationEvent["schemaVersion"]>().toEqualTypeOf<1>();
    expectTypeOf<VerificationEvent["eventId"]>().toEqualTypeOf<string>();
    expectTypeOf<VerificationEvent["correlationId"]>().toEqualTypeOf<string>();
    expectTypeOf<VerificationEvent["timestamp"]>().toEqualTypeOf<string>();
    expectTypeOf<VerificationEvent["sequence"]>().toEqualTypeOf<number>();
  });

  it("MockExecutor is a CheckExecutor", () => {
    expectTypeOf<MockExecutor>().toExtend<CheckExecutor>();
  });
});
