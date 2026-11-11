import { PROJECT_KEY, PROJECT_OVERRIDE_KEY } from "@sindri/feedback-graph";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound, parseBody } from "../errors.js";
import type { Services } from "../services.js";

/** `null` clears the override, so the link goes back to the automatic repo-path lookup. */
const Link = z.strictObject({
  projectKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(
      PROJECT_KEY,
      "projectKey must start with a letter, digit or underscore, followed by letters, digits, '_', '.' or '-' (at most 200)",
    )
    .nullable(),
});

/**
 * Read-only Feedback Graph lessons (docs/feedback-graph.md). The link override only steers which
 * lessons Sindri reads, so it takes the bearer token without the approval factor.
 */
export function feedbackGraphRoutes(app: FastifyInstance, s: Services) {
  const view = async (projectId: string) => {
    const v = await s.feedbackGraph.projectView(projectId);
    if (!v) throw notFound("project");
    return v;
  };

  app.get("/v1/feedback-graph/status", () => s.feedbackGraph.status());

  app.get<{ Params: { id: string } }>("/v1/projects/:id/feedback-graph", (req) =>
    view(req.params.id),
  );

  app.put<{ Params: { id: string } }>("/v1/projects/:id/feedback-graph", async (req) => {
    const project = s.knowledge.projects.get(req.params.id);
    if (!project) throw notFound("project");
    const { projectKey } = parseBody(Link, req.body);
    const settings: Record<string, unknown> = { ...project.settings };
    if (projectKey === null) delete settings[PROJECT_OVERRIDE_KEY];
    else settings[PROJECT_OVERRIDE_KEY] = projectKey;
    s.knowledge.projects.setSettings(project.id, settings);
    s.feedbackGraph.invalidate(project.id);
    req.log.info(
      { projectId: project.id, override: projectKey !== null },
      "feedback graph link changed",
    );
    return view(project.id);
  });
}
