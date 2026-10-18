export const PACKAGE_NAME = "@sindri/harnesses";

export {
  HarnessLockSchema,
  HarnessServiceError,
  RationaleEntrySchema,
  SelectedHarnessSchema,
  SelectedSkillSchema,
  SelectionSchema,
  TaskDescriptorSchema,
  type HarnessLock,
  type HarnessRequest,
  type HarnessService,
  type HarnessServiceErrorCode,
  type HarnessSummary,
  type RationaleEntry,
  type RepoSignals,
  type ResolveInput,
  type SelectedHarness,
  type SelectedSkill,
  type Selection,
  type TaskDescriptor,
} from "./types.js";
export { explainSelection } from "./explain.js";
export { FakeHarnessService, type FakeHarnessServiceOptions } from "./fake.js";
export {
  FAKE_HARNESSES,
  FAKE_PROFILES,
  FAKE_REPO_SIGNALS,
  FAKE_SKILLS,
  type FakeHarness,
  type FakeProfile,
  type FakeSkill,
} from "./fixtures.js";
export { BrokkrHarnessService, type BrokkrHarnessServiceOptions } from "./brokkr.js";
