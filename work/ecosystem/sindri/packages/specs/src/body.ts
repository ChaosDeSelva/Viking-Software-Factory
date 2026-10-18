import { z } from "zod";

export const AssumptionSchema = z.object({
  text: z.string().trim().min(1),
  risk: z.enum(["low", "medium", "high"]),
});
export const AcceptanceCriterionSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  verification: z.enum(["test", "manual", "screenshot"]),
});
export const OpenQuestionSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  blocking: z.boolean(),
});

const uniqueIds = (field: string) => (items: { id: string }[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id))
      ctx.addIssue({ code: "custom", message: `duplicate ${field} id ${it.id}` });
    seen.add(it.id);
  }
};

export const SpecBodySchema = z.object({
  problem: z.string().trim().min(1),
  goals: z.array(z.string()),
  nonGoals: z.array(z.string()),
  constraints: z.array(z.string()),
  assumptions: z.array(AssumptionSchema),
  acceptanceCriteria: z
    .array(AcceptanceCriterionSchema)
    .superRefine(uniqueIds("acceptance criterion")),
  risks: z.array(z.string()),
  openQuestions: z.array(OpenQuestionSchema).superRefine(uniqueIds("open question")),
});

export type Assumption = z.infer<typeof AssumptionSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;
export type SpecBody = z.infer<typeof SpecBodySchema>;

export const ProvenanceRefSchema = z.union([
  z.object({ knowledgeEntryId: z.string().min(1) }).strict(),
  z.object({ taskEvidenceId: z.string().min(1) }).strict(),
  z.object({ intakeId: z.string().min(1) }).strict(),
  z
    .object({
      documentId: z.string().min(1),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    })
    .strict()
    .refine(
      (r) => r.startLine === undefined || r.endLine === undefined || r.endLine >= r.startLine,
      {
        message: "endLine must be >= startLine",
      },
    ),
]);
export type ProvenanceRef = z.infer<typeof ProvenanceRefSchema>;

const refs = z.array(ProvenanceRefSchema);

/** Where each section came from. `problem` and every acceptance criterion need >= 1 ref. */
export const ProvenanceSchema = z.object({
  problem: refs.min(1, "provenance for problem must not be empty"),
  goals: refs,
  nonGoals: refs,
  constraints: refs,
  assumptions: refs,
  risks: refs,
  openQuestions: refs,
  acceptanceCriteria: z.record(z.string(), refs),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const SPEC_SECTIONS = [
  "problem",
  "goals",
  "nonGoals",
  "constraints",
  "assumptions",
  "acceptanceCriteria",
  "risks",
  "openQuestions",
] as const;
