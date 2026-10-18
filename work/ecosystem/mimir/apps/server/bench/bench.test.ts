import { meets } from "@mimir/testing";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./scenarios/index.js";

// Smoke run of every benchmark at a tiny scale so the scripts cannot rot. Only correctness
// thresholds (exact counts) are asserted here; latency targets belong to `pnpm bench:check`.
describe("bench scenarios (smoke, tiny scale)", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} runs and meets its correctness thresholds`, async () => {
      const results = await scenario.run({ scale: 0.01, log: () => undefined });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(Number.isFinite(r.value), `${r.scenario}/${r.metric}`).toBe(true);
        if (r.threshold?.op === "==") {
          expect(meets(r.value, r.threshold), `${r.scenario}/${r.metric} = ${r.value}`).toBe(true);
        }
      }
    }, 30_000);
  }
});
