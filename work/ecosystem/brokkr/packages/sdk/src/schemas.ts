import { z } from "zod";
import { REPORT_SCHEMA_VERSION, VerificationReportSchema } from "@brokkr/core";
import { EVENT_SCHEMA_VERSION, VerificationEventSchema } from "./events.js";
import { SelectionSchema } from "./types.js";

type Json = Record<string, unknown>;

/**
 * Published schemas are strict, exactly like Brokkr's own validation (review
 * I5): unknown fields and unknown enum values are rejected. Any change to a v1
 * contract regenerates these files and is a recorded compatibility change.
 */
function publish(schema: z.ZodType, id: string, title: string, description: string): Json {
  const { $schema, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
  }) as Json;
  return { $schema, $id: id, title, description, ...rest };
}

/** JSON Schema of `VerificationReport` v1 (`schemas/verification-report.v1.json`). */
export function verificationReportJsonSchema(): Json {
  return publish(
    VerificationReportSchema,
    "https://brokkr.local/schemas/verification-report.v1.json",
    "Brokkr VerificationReport",
    `Brokkr verification report, schemaVersion "${REPORT_SCHEMA_VERSION}" (spec §10.2).`,
  );
}

/** JSON Schema of the verification event stream v1 (`schemas/verification-event.v1.json`). */
export function verificationEventJsonSchema(): Json {
  return publish(
    VerificationEventSchema,
    "https://brokkr.local/schemas/verification-event.v1.json",
    "Brokkr verification event",
    `Brokkr verification event, schemaVersion ${EVENT_SCHEMA_VERSION} (spec §13.3).`,
  );
}

/** JSON Schema of `Selection` v1 (`schemas/selection.v1.json`). */
export function selectionJsonSchema(): Json {
  return publish(
    SelectionSchema,
    "https://brokkr.local/schemas/selection.v1.json",
    "Brokkr Selection",
    "Result of Brokkr.resolve: harnesses, skills, lock and rationale.",
  );
}
