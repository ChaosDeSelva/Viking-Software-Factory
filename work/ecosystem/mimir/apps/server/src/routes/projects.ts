import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CreateProjectRequestSchema,
  MimirError,
  newId,
  type CreateProjectResponse,
  type ListProjectsResponse,
  type Project,
} from "@mimir/protocol";
import { classifyCommand, findCredentialShapes, type CredentialShape } from "@mimir/core";
import type { FastifyInstance } from "fastify";
import { emit } from "../emit.js";
import { classifyOptions } from "../orchestrator/commands.js";
import { parseWith } from "../errors.js";
import { idempotent } from "../idempotency.js";

const run = promisify(execFile);

/** Environment for git without inherited GIT_* overrides (e.g. GIT_DIR from a hook). */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

const invalid = (reason: string, repoPath: string, message: string) =>
  new MimirError("validation_failed", message, { reason, repoPath });

async function resolveRoots(roots: readonly string[]): Promise<string[]> {
  return Promise.all(roots.map((r) => realpath(resolve(r)).catch(() => resolve(r))));
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertAllowed(path: string, roots: string[], requested: string): void {
  if (roots.length > 0 && !roots.some((root) => within(path, root))) {
    throw new MimirError("policy_denied", "repoPath is outside MIMIR_ALLOWED_ROOTS", {
      repoPath: requested,
      resolved: path,
    });
  }
}

/**
 * Resolves `repoPath` (symlinks included) to its git top level, rejecting missing paths,
 * non-repositories and anything outside the allowed roots.
 */
export async function resolveRepoPath(
  repoPath: string,
  allowedRoots: readonly string[],
): Promise<string> {
  if (!isAbsolute(repoPath)) throw invalid("not_absolute", repoPath, "repoPath must be absolute");
  let real: string;
  try {
    real = await realpath(repoPath);
  } catch {
    throw invalid("not_found", repoPath, "repoPath does not exist");
  }
  if (!(await stat(real)).isDirectory()) {
    throw invalid("not_a_directory", repoPath, "repoPath is not a directory");
  }
  const roots = await resolveRoots(allowedRoots);
  assertAllowed(real, roots, repoPath);
  let top: string;
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], {
      cwd: real,
      env: gitEnv(),
      timeout: 10_000,
    });
    top = await realpath(stdout.trim());
  } catch {
    throw invalid("not_a_git_repo", repoPath, "repoPath is not inside a git repository");
  }
  assertAllowed(top, roots, repoPath);
  return top;
}

/** A project field whose value (or key) has a credential shape. */
export interface CredentialField {
  /** Dotted path, e.g. `name`, `settings.nested.auth`, `settings.keys[1]`. */
  field: string;
  kind: CredentialShape;
}

/**
 * Finds credential-shaped values in a project's name and settings (string leaves and object
 * keys; a credential-shaped key is reported at its parent path so it is never echoed). Uses
 * value-shape rules only, so ordinary keys like `maxTokens` or `cookieDomain` are fine.
 */
export function credentialFields(name: string, settings: unknown): CredentialField[] {
  const out: CredentialField[] = [];
  const add = (field: string, text: string) => {
    for (const kind of findCredentialShapes(text)) out.push({ field, kind });
  };
  add("name", name);
  // Depth is bounded by the body depth guard; iterate anyway.
  const stack: [unknown, string][] = [[settings, "settings"]];
  while (stack.length > 0) {
    const [value, path] = stack.pop() as [unknown, string];
    if (typeof value === "string") add(path, value);
    else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push([value[i], `${path}[${i}]`]);
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      for (const [key] of entries) add(path, key);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i] as [string, unknown];
        stack.push([child, `${path}.${key}`]);
      }
    }
  }
  return out;
}

/**
 * Project name and settings are stored verbatim (the event log) and returned by the API, so
 * credentials are refused (422) rather than silently rewritten. Values are never echoed.
 */
function assertNoCredentials(name: string, settings: unknown): void {
  const fields = credentialFields(name, settings);
  if (fields.length === 0) return;
  throw new MimirError(
    "validation_failed",
    `project field ${fields[0]?.field} looks like a credential; store secrets outside Mimir`,
    { reason: "credential_in_project_field", fields },
  );
}

export function projectRoutes(app: FastifyInstance): void {
  const ctx = app.mimir;

  app.get("/v1/projects", (): ListProjectsResponse => ({
    projects: ctx.readModel.snapshot().projects,
  }));

  app.post(
    "/v1/projects",
    idempotent(ctx, "project.create", async (request) => {
      const body = parseWith(CreateProjectRequestSchema, request.body);
      assertNoCredentials(body.name, body.settings ?? {});
      const repoPath = await resolveRepoPath(body.repoPath, ctx.allowedRoots);
      // The test command runs in every task worktree: it must be on the project's exact allowlist
      // (ADR-014), checked in the repository the worktrees are made from (review C2).
      const testCommand = body.settings?.testCommand;
      if (testCommand !== undefined) {
        const probe = { settings: body.settings ?? {} } as unknown as Project;
        const action = classifyCommand(testCommand, classifyOptions(probe, repoPath, undefined));
        if (action !== null) {
          throw new MimirError(
            "validation_failed",
            "settings.testCommand is not on the project's command allowlist",
            {
              reason: "test_command_not_allowlisted",
              action,
              issues: [
                {
                  path: ["settings", "testCommand"],
                  message: `classified ${action}`,
                  code: "custom",
                },
              ],
            },
          );
        }
      }
      if ([...ctx.readModel.projects.values()].some((p) => p.repoPath === repoPath)) {
        throw new MimirError("conflict", "a project for this repository already exists", {
          repoPath,
        });
      }
      const at = ctx.now();
      const now = at.toISOString();
      const project: Project = {
        id: newId("prj"),
        name: body.name,
        repoPath,
        settings: body.settings ?? {},
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      emit(ctx.store, at, {
        type: "project.created",
        streamId: `project:${project.id}`,
        payload: { project },
      });
      const response: CreateProjectResponse = { project };
      return { status: 201, body: response, target: project.id };
    }),
  );
}
