export const PACKAGE_NAME = "@sindri/specs";

export {
  openSpecs,
  SpecStateError,
  SpecValidationError,
  type CreateDraftInput,
  type OpenSpecsOptions,
  type RevisePatch,
  type Specification,
  type Specs,
  type SpecStatus,
} from "./specs.js";
export {
  AcceptanceCriterionSchema,
  AssumptionSchema,
  OpenQuestionSchema,
  ProvenanceRefSchema,
  ProvenanceSchema,
  SPEC_SECTIONS,
  SpecBodySchema,
  type AcceptanceCriterion,
  type Assumption,
  type OpenQuestion,
  type Provenance,
  type ProvenanceRef,
  type SpecBody,
} from "./body.js";
export { diffSpecs, type DiffSide, type KeyedDiff, type ListDiff, type SpecDiff } from "./diff.js";
export { refLabel, renderSpec, type RenderInput } from "./render.js";
export { SPECS_MIGRATIONS } from "./schema.js";
