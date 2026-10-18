import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound, parseBody } from "../errors.js";
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

export function projectRoutes(app: FastifyInstance, s: Services) {
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
