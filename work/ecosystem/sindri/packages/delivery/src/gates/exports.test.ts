import { describe, expect, it } from "vitest";
import * as delivery from "../index.js";

describe("@sindri/delivery S6 exports", () => {
  it("exposes gates, reviews, reports, knowledge updates, tracing and the S5 bindings", () => {
    for (const name of [
      "GateRunner",
      "ReviewOrchestrator",
      "DeliveryReports",
      "renderPrDescription",
      "validateCitations",
      "KnowledgeUpdater",
      "DeliveryTracer",
      "executionReaderFor",
      "mimirActionsFor",
      "mimirArtifactContentReader",
      "contextReaderFrom",
      "parseVerificationReport",
      "QUALITY_MIGRATIONS",
      "ensureDeliverySchema",
      "ensureQualitySchema",
    ]) {
      expect(delivery, name).toHaveProperty(name);
    }
    expect(delivery.BROKKR_REPORT_KIND).toBe("brokkr.verification-report");
    // I2: no filesystem artifact reader in production exports.
    expect(delivery).not.toHaveProperty("fileArtifactContentReader");
  });
});
