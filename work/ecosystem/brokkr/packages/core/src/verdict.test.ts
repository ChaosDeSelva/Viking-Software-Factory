import { describe, expect, it } from "vitest";
import { CHECK_STATES, computeVerdict, exitCodeForVerdict, type CheckState } from "./index.js";

type Waiver = "none" | "exception";
const WAIVERS: Waiver[] = ["none", "exception"];

/** Expected contribution of one required check (spec §8.2, brief B2 verdict rules). */
function expectedFor(state: CheckState, waiver: Waiver): "passed" | "failed" | "incomplete" {
  if (state === "passed") return "passed";
  if (state === "failed") return "failed"; // an exception never turns a failure into a pass
  return waiver === "exception" ? "passed" : "incomplete";
}

const RANK = { passed: 0, incomplete: 1, failed: 2 } as const;

describe("computeVerdict: single required check, every state x waiver", () => {
  for (const state of CHECK_STATES) {
    for (const waiver of WAIVERS) {
      it(`${state} / ${waiver}`, () => {
        const result = computeVerdict({
          checks: [
            {
              id: "a",
              required: true,
              state,
              ...(waiver === "exception" ? { exceptionId: "exc-1" } : {}),
            },
          ],
        });
        // A lone waived check is not a pass: at least one required check must run and pass.
        const expected = expectedFor(state, waiver);
        expect(result.verdict).toBe(
          expected === "passed" && state !== "passed" ? "incomplete" : expected,
        );
      });
    }
  }
});

describe("computeVerdict: two required checks, every combination", () => {
  for (const s1 of CHECK_STATES) {
    for (const s2 of CHECK_STATES) {
      it(`${s1} + ${s2}`, () => {
        const a = expectedFor(s1, "none");
        const b = expectedFor(s2, "none");
        const expected = RANK[a] >= RANK[b] ? a : b;
        const result = computeVerdict({
          checks: [
            { id: "a", required: true, state: s1 },
            { id: "b", required: true, state: s2 },
          ],
        });
        expect(result.verdict).toBe(expected);
      });
    }
  }
});

describe("computeVerdict: optional checks never decide the verdict", () => {
  for (const state of CHECK_STATES) {
    it(`optional ${state} next to a passing required check`, () => {
      const result = computeVerdict({
        checks: [
          { id: "req", required: true, state: "passed" },
          { id: "opt", required: false, state },
        ],
      });
      expect(result.verdict).toBe("passed");
    });
  }
});

describe("computeVerdict: blocked and policy requirements", () => {
  it("blocked wins over everything, including failures", () => {
    for (const state of CHECK_STATES) {
      const result = computeVerdict({
        checks: [{ id: "a", required: true, state }],
        blocked: ["untrusted_source"],
      });
      expect(result.verdict).toBe("blocked");
      expect(result.reasons).toContain("blocked: untrusted_source");
    }
  });

  it("unmet policy requirements make a passing run incomplete", () => {
    const result = computeVerdict({
      checks: [{ id: "a", required: true, state: "passed" }],
      unmet: ["required check 'e2e' is not defined"],
    });
    expect(result.verdict).toBe("incomplete");
    expect(result.reasons.join("\n")).toMatch(/e2e/);
  });

  it("unmet requirements do not hide a failure", () => {
    const result = computeVerdict({
      checks: [{ id: "a", required: true, state: "failed" }],
      unmet: ["x"],
    });
    expect(result.verdict).toBe("failed");
  });

  it("a run without any required check is incomplete, never a vacuous pass", () => {
    expect(computeVerdict({ checks: [] }).verdict).toBe("incomplete");
    expect(
      computeVerdict({ checks: [{ id: "o", required: false, state: "passed" }] }).verdict,
    ).toBe("incomplete");
  });

  it("explains every non-passing required check", () => {
    const result = computeVerdict({
      checks: [
        { id: "a", required: true, state: "failed" },
        { id: "b", required: true, state: "timed_out" },
        { id: "c", required: true, state: "skipped", exceptionId: "exc-9" },
      ],
    });
    expect(result.reasons).toEqual([
      "required check 'a' failed",
      "required check 'b' timed_out",
      "required check 'c' waived by exception exc-9",
    ]);
  });
});

describe("exitCodeForVerdict", () => {
  it("maps verdicts to the public exit-code contract", () => {
    expect(exitCodeForVerdict("passed")).toBe(0);
    expect(exitCodeForVerdict("failed")).toBe(1);
    expect(exitCodeForVerdict("incomplete")).toBe(1);
    expect(exitCodeForVerdict("blocked")).toBe(4);
    expect(exitCodeForVerdict("passed", { interrupted: true })).toBe(130);
    expect(exitCodeForVerdict("blocked", { interrupted: true })).toBe(130);
  });
});

describe("computeVerdict: not_applicable (unmet `when` guard, ruling a)", () => {
  const na = {
    id: "e2e",
    required: true,
    state: "skipped" as const,
    reason: "not_applicable" as const,
  };

  it("a harness-required check that is not applicable neither passes nor fails anything", () => {
    const result = computeVerdict({
      checks: [{ id: "unit", required: true, state: "passed" }, na],
    });
    expect(result.verdict).toBe("passed");
    expect(result.reasons).toContain(
      "required check 'e2e' not applicable (excluded from required gates)",
    );
  });

  it("does not hide failures", () => {
    expect(
      computeVerdict({ checks: [{ id: "unit", required: true, state: "failed" }, na] }).verdict,
    ).toBe("failed");
  });

  it("counts only applicable required checks for the vacuous-run rule", () => {
    expect(computeVerdict({ checks: [na] }).verdict).toBe("incomplete");
    expect(
      computeVerdict({ checks: [na, { id: "lint", required: false, state: "passed" }] }).verdict,
    ).toBe("incomplete");
  });

  it("a check required by policy (requiredCheckIds) stays incomplete when not applicable", () => {
    const result = computeVerdict({
      checks: [
        { id: "unit", required: true, state: "passed" },
        { ...na, requiredBy: "policy" },
      ],
    });
    expect(result.verdict).toBe("incomplete");
    expect(result.reasons).toContain(
      "required check 'e2e' skipped (not applicable, but required by policy)",
    );
  });

  it("other skip reasons on required checks remain incomplete", () => {
    for (const reason of ["missing_tool", "missing_script", "network_denied"] as const) {
      const result = computeVerdict({
        checks: [
          { id: "unit", required: true, state: "passed" },
          { ...na, reason },
        ],
      });
      expect(result.verdict, reason).toBe("incomplete");
    }
  });
});

describe("computeVerdict: waivers alone never pass a run (audit C2)", () => {
  it("all required checks waived is incomplete", () => {
    const result = computeVerdict({
      checks: [
        { id: "a", required: true, state: "skipped", exceptionId: "e1" },
        { id: "b", required: true, state: "skipped", exceptionId: "e2" },
      ],
    });
    expect(result.verdict).toBe("incomplete");
    expect(result.reasons).toContain("no required check actually ran and passed");
  });

  it("one passing required check plus waivers can pass", () => {
    expect(
      computeVerdict({
        checks: [
          { id: "a", required: true, state: "passed" },
          { id: "b", required: true, state: "skipped", exceptionId: "e2" },
        ],
      }).verdict,
    ).toBe("passed");
  });
});
