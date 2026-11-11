import { describe, expect, it, vi } from "vitest";
import {
  FACTORY_APPS,
  listStatuses,
  ROLE_NAMES,
  setUnknownStatusHandler,
  STATUS_ROLES,
  statusKey,
  statusRole,
} from "./status.js";

describe("statusRole", () => {
  it("maps the cross-app disagreements from the audit to one role each", () => {
    expect(statusRole("sindri", "failed").role).toBe("danger");
    expect(statusRole("skidbladnir", "failed").role).toBe("danger");
    expect(statusRole("sindri", "verified_pending_review")).toMatchObject({
      role: "waiting",
      label: "Awaiting review",
    });
    expect(statusRole("heimdall", "awaiting_approval").role).toBe("waiting");
    expect(statusRole("sindri", "cancelled").role).toBe("ended");
    expect(statusRole("mimir", "leased").role).toBe("progress");
  });

  it("ignores case, spaces and AWS casing", () => {
    expect(statusKey("Not configured")).toBe("not_configured");
    expect(statusRole("heimdall", "Not configured").role).toBe("ended");
    expect(statusRole("heimdall", "Paired").role).toBe("success");
    expect(statusRole("skidbladnir", "TimedOut")).toMatchObject({
      role: "danger",
      label: "Timed out",
    });
    expect(statusRole("skidbladnir", "Success").role).toBe("success");
  });

  it("uses the domain where a value means different things", () => {
    expect(statusRole("sindri", "pending").role).toBe("progress");
    expect(statusRole("sindri", "pending", "decision")).toMatchObject({
      role: "waiting",
      label: "Awaiting you",
    });
    expect(statusRole("mimir", "pending").role).toBe("neutral");
    expect(statusRole("mimir", "pending", "approval").role).toBe("waiting");
    expect(statusRole("heimdall", "auto", "stewardMode").label).toBe("Automatic");
    expect(statusRole("skidbladnir", "stopped").role).toBe("warning");
    expect(statusRole("mimir", "stopped").role).toBe("ended");
  });

  it("resolves prefixed values by the part before the colon and keeps the raw text", () => {
    const s = statusRole("sindri", "failed: lint");
    expect(s).toMatchObject({ role: "danger", label: "Failed", raw: "failed: lint", known: true });
  });

  it("degrades unknown values to the unknown role showing the raw value, without throwing", () => {
    const handler = vi.fn();
    setUnknownStatusHandler(handler);
    expect(statusRole("heimdall", "teleporting")).toMatchObject({
      role: "unknown",
      label: "teleporting",
      raw: "teleporting",
      known: false,
    });
    expect(handler).toHaveBeenCalledWith("heimdall", "teleporting", undefined);
    expect(statusRole("not-an-app", "running").role).toBe("unknown");
    expect(statusRole("mimir", null).label).toBe("Unknown");
    expect(statusRole("mimir", { weird: true }).role).toBe("unknown");
  });
});

describe("STATUS_ROLES", () => {
  it("is a plain { app: { value: role } } map covering all four apps", () => {
    expect(Object.keys(STATUS_ROLES).sort()).toEqual([...FACTORY_APPS].sort());
    for (const app of FACTORY_APPS) {
      const map = STATUS_ROLES[app];
      expect(Object.keys(map).length).toBeGreaterThan(5);
      for (const role of Object.values(map)) expect(ROLE_NAMES).toContain(role);
    }
  });

  it("every value an app emits is mapped (only `unknown`-style values use the unknown role)", () => {
    for (const app of FACTORY_APPS)
      for (const [value, role] of Object.entries(STATUS_ROLES[app])) {
        const s = statusRole(app, value);
        expect(s.known, `${app}:${value}`).toBe(true);
        if (role === "unknown") expect(["unknown", "unavailable", "not_reported"]).toContain(value);
      }
  });

  it("labels are human words, never snake_case", () => {
    for (const { app, value, def } of listStatuses())
      expect(def.label, `${app}:${value}`).not.toMatch(/_/);
  });
});
