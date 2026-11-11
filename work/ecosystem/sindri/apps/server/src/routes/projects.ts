import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ExecutionProfileSchema } from "@sindri/harnesses";
import type { FastifyInstance } from "fastify";
import type { ApprovalAuthority } from "../approval.js";
import { z } from "zod";
import { DISPLAY_SANITIZED } from "../display.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import { PROFILE_KEY, profileHarness, profileOf } from "../execution-profile.js";
import type { Services } from "../services.js";

/**
 * The resolved path. For a path that does not exist yet (a data dir not yet created), its nearest
 * existing ancestor is resolved and the rest appended, so symlinks above it are still resolved.
 */
export const realOr = (p: string): string => {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realOr(parent), basename(abs));
  }
};

const CreateProject = z.strictObject({
  name: z.string().trim().min(1).max(200),
  repoPath: z.string().min(1).max(4096),
});

/** The resolved directory, or null when the path is not an existing directory. */
const realDir = (p: string): string | null => {
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
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
    // The resolved path, as Mimir stores it, so Sindri and Mimir name a repository the same way
    // (a trailing slash or symlink would not match), and a symlink to the home directory is
    // checked as the home directory.
    const repo = isAbsolute(body.repoPath) ? realDir(body.repoPath) : null;
    if (!repo)
      throw new ApiError(
        422,
        "validation_failed",
        "repoPath must be an existing absolute directory",
      );
    const inside = (root: string) => {
      const r = relative(realOr(root), repo);
      return r === "" || (!r.startsWith("..") && !isAbsolute(r));
    };
    if (repo === "/" || repo === realOr(homedir()) || (s.dataDir && inside(s.dataDir)))
      throw new ApiError(
        422,
        "validation_failed",
        "repoPath must be a project directory, not /, the home directory or the Sindri data directory",
      );
    const project = s.knowledge.projects.create({ name: body.name, repoPath: repo });
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
    if (!realDir(p.repoPath))
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
