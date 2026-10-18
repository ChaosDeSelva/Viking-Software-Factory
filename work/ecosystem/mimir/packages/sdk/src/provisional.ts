/**
 * Types and validators for server routes that the T12 brief defines but `@mimir/protocol` does not
 * describe yet (`GET /v1/sessions/:id/terminal`, `GET /v1/attention`). The shapes follow the web
 * app's provisional client (`apps/web/src/api/client.ts`). Replace these with protocol schemas
 * once the protocol adds them.
 */
import type { ValidationIssue } from "@mimir/protocol";
import type { HandValidationError, ResponseSchema } from "./http.js";

/** `GET /v1/sessions/:id/terminal` (provisional). Terminal text is never a state source. */
export interface TerminalReadResponse {
  text: string;
  provenance?: "observed";
  capturedAt?: string;
}

export const ATTENTION_KINDS = ["approval", "blocked", "stuck", "budget", "unknown"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** One item of `GET /v1/attention` (provisional). */
export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail?: string;
  missionId?: string;
  taskId?: string;
  approvalId?: string;
  sessionId?: string;
}

export interface AttentionResponse {
  items: AttentionItem[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function validator<T>(check: (v: unknown, issues: ValidationIssue[]) => T): ResponseSchema<T> {
  return {
    safeParse(value: unknown) {
      const issues: ValidationIssue[] = [];
      const data = check(value, issues);
      if (issues.length > 0) {
        const error: HandValidationError = { handWritten: true, issues };
        return { success: false, error };
      }
      return { success: true, data };
    },
  };
}

function str(
  o: Obj,
  key: string,
  path: (string | number)[],
  issues: ValidationIssue[],
  optional: boolean,
) {
  const v = o[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string") {
    issues.push({
      path: [...path, key],
      message: optional ? "expected string or absent" : "expected string",
      code: "invalid_type",
    });
    return undefined;
  }
  return v;
}

/** Copies only known keys (unknown keys are stripped, like the protocol's response schemas). */
export const TerminalReadResponseSchema = validator<TerminalReadResponse>((v, issues) => {
  if (!isObj(v)) {
    issues.push({ path: [], message: "expected object", code: "invalid_type" });
    return { text: "" };
  }
  const out: TerminalReadResponse = { text: str(v, "text", [], issues, false) ?? "" };
  if (v["provenance"] !== undefined) {
    if (v["provenance"] === "observed") out.provenance = "observed";
    else
      issues.push({ path: ["provenance"], message: 'expected "observed"', code: "invalid_type" });
  }
  const capturedAt = str(v, "capturedAt", [], issues, true);
  if (capturedAt !== undefined) out.capturedAt = capturedAt;
  return out;
});

export const AttentionResponseSchema = validator<AttentionResponse>((v, issues) => {
  if (!isObj(v) || !Array.isArray(v["items"])) {
    issues.push({ path: ["items"], message: "expected an array", code: "invalid_type" });
    return { items: [] };
  }
  const items: AttentionItem[] = [];
  v["items"].forEach((raw: unknown, i: number) => {
    const path = ["items", i];
    if (!isObj(raw)) {
      issues.push({ path, message: "expected object", code: "invalid_type" });
      return;
    }
    const kind = raw["kind"];
    if (!ATTENTION_KINDS.includes(kind as AttentionKind)) {
      issues.push({
        path: [...path, "kind"],
        message: `expected one of ${ATTENTION_KINDS.join(", ")}`,
        code: "invalid_type",
      });
    }
    const item: AttentionItem = {
      id: str(raw, "id", path, issues, false) ?? "",
      kind: kind as AttentionKind,
      title: str(raw, "title", path, issues, false) ?? "",
    };
    for (const key of ["detail", "missionId", "taskId", "approvalId", "sessionId"] as const) {
      const value = str(raw, key, path, issues, true);
      if (value !== undefined) item[key] = value;
    }
    items.push(item);
  });
  return { items };
});
