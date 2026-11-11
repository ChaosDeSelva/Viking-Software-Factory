import { explainSelection, HarnessServiceError, TaskDescriptorSchema } from "@sindri/harnesses";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound, parseBody } from "../errors.js";
import { profileHarness } from "../execution-profile.js";
import type { Factory } from "../factory.js";
import type { Services } from "../services.js";

const Explain = z
  .strictObject({
    projectId: z.string().min(1).optional(),
    task: TaskDescriptorSchema,
    profile: z.string().min(1).max(200).optional(),
    harnesses: z
      .array(
        z.strictObject({ name: z.string().min(1).max(200), version: z.string().min(1).max(100) }),
      )
      .max(20)
      .optional(),
  })
  .refine((v) => !(v.profile && v.harnesses), "give either profile or harnesses, not both");

export function harnessRoutes(app: FastifyInstance, s: Services, f: Factory) {
  const projectOf = (projectId?: string) => {
    if (!projectId) return undefined;
    const project = s.knowledge.projects.get(projectId);
    if (!project) throw notFound("project");
    return project;
  };
  const repoOf = (projectId?: string) => projectOf(projectId)?.repoPath;

  app.get("/v1/harnesses", async () => {
    const { service, source } = f.harnesses();
    return { source, harnesses: await service.listHarnesses() };
  });

  app.get<{ Querystring: { projectId?: string } }>("/v1/harnesses/repo-signals", async (req) => {
    const q = parseBody(z.object({ projectId: z.string().min(1) }), req.query);
    const { service, source } = f.harnesses(repoOf(q.projectId));
    return { source, signals: await service.inspectRepo() };
  });

  app.get<{ Params: { name: string } }>("/v1/harnesses/:name", async (req) => {
    const { service, source } = f.harnesses();
    const versions = (await service.listHarnesses()).filter((h) => h.name === req.params.name);
    if (versions.length === 0) throw notFound("harness");
    return { source, name: req.params.name, versions };
  });

  app.post("/v1/harnesses/explain", async (req) => {
    const body = parseBody(Explain, req.body);
    // Like the planner: a project's generated profile harness is the default selection.
    const project = projectOf(body.projectId);
    const { service, source } = f.harnesses(
      project?.repoPath,
      project ? profileHarness(project) : null,
    );
    const selection = await service
      .resolve(
        body.profile
          ? { task: body.task, profile: body.profile }
          : body.harnesses
            ? { task: body.task, harnesses: body.harnesses }
            : { task: body.task },
      )
      .catch((err: unknown) => {
        // The generic mapping drops the message; a resolve failure should say what Brokkr said.
        if (err instanceof HarnessServiceError && err.code === "invalid_request")
          throw new ApiError(422, "validation_failed", err.message);
        throw err;
      });
    return { source, selection, explanation: explainSelection(selection) };
  });

  // Installing, pinning and verifying harnesses are Brokkr operations (`@brokkr/sdk`), wired with
  // S4b. Until then they answer 501 with the reason instead of pretending to succeed.
  const notSupported = (what: string) => () => {
    throw new ApiError(
      501,
      "not_supported",
      `${what} runs in Brokkr; Sindri's Brokkr wiring (S4b) is not built yet`,
    );
  };
  app.post("/v1/harnesses/install", notSupported("Harness install"));
  app.post("/v1/harnesses/:name/pin", notSupported("Harness pinning"));
  app.post("/v1/harnesses/:name/verify", notSupported("Harness verification"));
}
