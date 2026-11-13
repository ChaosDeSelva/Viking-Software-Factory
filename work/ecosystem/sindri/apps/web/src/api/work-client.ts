import type { DeliveryReport } from "./delivery-types.js";
import type { Intake } from "./types.js";
import type {
  GitHubStatus,
  PrReviewReport,
  ProjectGuidance,
  ReviewPost,
  ReviewEdit,
  ReviewPreview,
  SkillDetail,
  SkillImportResult,
  SkillSummary,
} from "./work-types.js";

/** `approval: true` sends the approval secret (accept, reject and posting a review). */
type Call = <T>(
  method: string,
  path: string,
  body?: unknown,
  o?: { approval?: boolean },
) => Promise<T>;

const enc = encodeURIComponent;

/** The skills library, project guidance, research decisions and PR review editing/posting. */
export function workMethods(call: Call) {
  return {
    listSkills: async () => (await call<{ skills: SkillSummary[] }>("GET", "/v1/skills")).skills,
    getSkill: async (id: string) =>
      (await call<{ skill: SkillDetail }>("GET", `/v1/skills/${enc(id)}`)).skill,
    importSkills: (path: string) => call<SkillImportResult>("POST", "/v1/skills", { path }),
    reimportSkill: async (id: string) =>
      (await call<{ skill: SkillSummary }>("POST", `/v1/skills/${enc(id)}/reimport`)).skill,
    deleteSkill: (id: string) => call<{ deleted: string }>("DELETE", `/v1/skills/${enc(id)}`),
    getGuidance: async (projectId: string) =>
      (await call<{ guidance: ProjectGuidance }>("GET", `/v1/projects/${enc(projectId)}/guidance`))
        .guidance,
    putGuidance: async (projectId: string, input: { notes: string; defaultSkillIds: string[] }) =>
      (
        await call<{ guidance: ProjectGuidance }>(
          "PUT",
          `/v1/projects/${enc(projectId)}/guidance`,
          input,
        )
      ).guidance,

    acceptDocument: async (executionId: string, reason?: string) =>
      (
        await call<{ report: DeliveryReport }>(
          "POST",
          `/v1/executions/${enc(executionId)}/accept`,
          reason ? { reason } : {},
          { approval: true },
        )
      ).report,
    rejectDocument: async (executionId: string, reason: string) =>
      (
        await call<{ report: DeliveryReport }>(
          "POST",
          `/v1/executions/${enc(executionId)}/reject`,
          { reason },
          { approval: true },
        )
      ).report,
    followUp: async (executionId: string, question: string) =>
      (
        await call<{ intake: Intake }>("POST", `/v1/executions/${enc(executionId)}/follow-up`, {
          question,
        })
      ).intake,

    getReview: async (executionId: string) =>
      (await call<{ review: PrReviewReport }>("GET", `/v1/executions/${enc(executionId)}/review`))
        .review,
    /** 422 unknown finding ids; 409 `already_posted`. */
    saveReview: async (executionId: string, edit: ReviewEdit) =>
      (
        await call<{ review: PrReviewReport }>(
          "PUT",
          `/v1/executions/${enc(executionId)}/review`,
          edit,
        )
      ).review,
    previewReview: (executionId: string) =>
      call<ReviewPreview>("GET", `/v1/executions/${enc(executionId)}/review/preview`),
    postReview: (executionId: string) =>
      call<{ posted: ReviewPost; review: PrReviewReport }>(
        "POST",
        `/v1/executions/${enc(executionId)}/review/post`,
        {},
        { approval: true },
      ),
    githubStatus: () => call<GitHubStatus>("GET", "/v1/github/status"),
  };
}

/** Method names, for test mocks. */
export const WORK_METHOD_NAMES = [
  "listSkills",
  "getSkill",
  "importSkills",
  "reimportSkill",
  "deleteSkill",
  "getGuidance",
  "putGuidance",
  "acceptDocument",
  "rejectDocument",
  "followUp",
  "getReview",
  "saveReview",
  "previewReview",
  "postReview",
  "githubStatus",
] as const satisfies readonly (keyof ReturnType<typeof workMethods>)[];
