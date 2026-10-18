import { describe, expect, it } from "vitest";
import {
  ID_PREFIX,
  MissionIdSchema,
  ProjectIdSchema,
  TaskIdSchema,
  TimestampSchema,
  newId,
} from "./ids.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ids", () => {
  it("newId produces `${prefix}_${ulid}`", () => {
    const id = newId(ID_PREFIX.project);
    const [prefix, rest] = id.split("_");
    expect(prefix).toBe("prj");
    expect(rest).toMatch(ULID);
  });

  it("newId values are unique and sortable by creation", () => {
    const a = newId("tsk");
    const b = newId("tsk");
    expect(a).not.toBe(b);
    expect(a < b).toBe(true);
  });

  it("id schemas accept their own prefix and reject others", () => {
    expect(ProjectIdSchema.safeParse(newId("prj")).success).toBe(true);
    expect(ProjectIdSchema.safeParse(newId("msn")).success).toBe(false);
    expect(MissionIdSchema.safeParse("msn_not-a-ulid").success).toBe(false);
    expect(TaskIdSchema.safeParse(42).success).toBe(false);
  });

  it("uses distinct prefixes for every entity", () => {
    const values = Object.values(ID_PREFIX);
    expect(new Set(values).size).toBe(values.length);
  });

  it("TimestampSchema accepts only UTC (Z) ISO-8601 timestamps", () => {
    expect(TimestampSchema.safeParse(new Date().toISOString()).success).toBe(true);
    expect(TimestampSchema.safeParse("2026-10-14T08:00:00Z").success).toBe(true);
    expect(TimestampSchema.safeParse("2026-10-14T10:00:00+02:00").success).toBe(false);
  });
});
