import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { ExecutionProfileSchema } from "@sindri/harnesses";
import type { FastifyInstance } from "fastify";
import type { ApprovalAuthority } from "../approval.js";
import { z } from "zod";
import { DISPLAY_SANITIZED } from "../display.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import { PROFILE_KEY, profileHarness, profileOf } from "../execution-profile.js";
import type { Services } from "../services.js";

const CreateProject = z.strictObject({
  name: z.string().trim().min(1).max(200),
  repoPath: z.string().min(1).max(4096),
});

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function projectRoutes(app: FastifyInstance, s: Services, approvals: ApprovalAuthority) {
  const requireProject = (id: string) => {
    const p = s.knowledge.projects.get(id);
    if (!p) throw notFound("project");
    return p;
  };

  app.get("/v1/projects", () => ({ projects: s.knowledge.projects.list() }));

  app.post("/v1/projects", async (req, reply) => {
    const body = parseBody(CreateProject, req.body);
    if (!isAbsolute(body.repoPath) || !isDir(body.repoPath))
      throw new ApiError(
        422,
        "validation_failed",
        "repoPath must be an existing absolute directory",
      );
    const repo = resolve(body.repoPath);
    const inside = (root: string) => {
      const r = relative(resolve(root), repo);
      return r === "" || (!r.startsWith("..") && !isAbsolute(r));
    };
    if (repo === "/" || repo === resolve(homedir()) || (s.dataDir && inside(s.dataDir)))
      throw new ApiError(
        422,
        "validation_failed",
        "repoPath must be a project directory, not /, the home directory or the Sindri data directory",
      );
    const project = s.knowledge.projects.create({ name: body.name, repoPath: body.repoPath });
    return reply.code(201).send({ project });
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id", (req) => ({
    project: requireProject(req.params.id),
  }));

  // A profile is returned exactly as stored. Editors send the whole profile back, so a value
  // altered for display (markup stripped from a command argument, say) would be saved altered.
  // It is operator-entered, strictly validated configuration; clients must render it as text.
  const exactProfile = { config: { [DISPLAY_SANITIZED]: true } };

  app.get<{ Params: { id: string } }>("/v1/projects/:id/profile", exactProfile, (req) => ({
    profile: profileOf(requireProject(req.params.id)),
  }));

  // Operator configuration: how the repository is checked and what its tools need. A profile
  // with checks gets a generated Brokkr harness, named after its content. It decides which
  // commands verify the work and what agents may write to and reach outside their worktree, so
  // it takes the human approval factor: the bearer token alone, which agents can read, is not
  // enough.
  app.put<{ Params: { id: string } }>("/v1/projects/:id/profile", exactProfile, (req) => {
    const approver = approvals.require(req);
    const project = requireProject(req.params.id);
    const profile = parseBody(ExecutionProfileSchema, req.body);
    const harness = profileHarness(project, profile);
    s.knowledge.projects.setSettings(project.id, { ...project.settings, [PROFILE_KEY]: profile });
    req.log.info({ projectId: project.id, approver }, "execution profile changed");
    return { profile, harness };
  });

  app.post<{ Params: { id: string } }>("/v1/projects/:id/bootstrap", (req) => {
    const p = requireProject(req.params.id);
    if (!isDir(p.repoPath))
      throw new ApiError(409, "invalid_state", "the project repoPath no longer exists");
    return { result: s.knowledge.bootstrapProject(p.id, { repoPath: p.repoPath }) };
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
    "/v1/projects/:id/search",
    (req) => {
      requireProject(req.params.id);
      const q = parseBody(
        z.object({
          q: z.string().trim().min(1).max(500),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
        req.query,
      );
      return {
        hits: s.knowledge.search(
          req.params.id,
          q.q,
          q.limit === undefined ? {} : { limit: q.limit },
        ),
      };
    },
  );
}
