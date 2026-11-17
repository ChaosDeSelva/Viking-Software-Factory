/**
 * Files the operator uploads to give new work as context: Markdown documents and images. Each is
 * stored once under the data directory, in a folder of its own, so a task can be allowed to read
 * exactly the images its request names.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "@sindri/knowledge";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound, parseBody } from "../errors.js";
import type { Services } from "../services.js";

export const MAX_MARKDOWN_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function ensureContextFilesSchema(db: SqliteDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS context_files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('markdown', 'image')),
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

export interface ContextFileRow {
  id: string;
  name: string;
  kind: "markdown" | "image";
  mime: string;
  bytes: number;
  sha256: string;
  path: string;
  created_at: string;
}

export const contextFileView = (r: ContextFileRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  mime: r.mime,
  bytes: r.bytes,
  createdAt: r.created_at,
});

/** A file name safe to keep on disk and show: no folders, no control characters. */
function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "file").slice(0, 200);
}

const Upload = z.strictObject({
  name: z.string().min(1).max(300),
  mime: z.string().min(1).max(100),
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8),
});

/** 422 unless every id is an uploaded file. */
export function requireContextFiles(db: SqliteDatabase, ids: readonly string[] | undefined) {
  if (!ids?.length) return;
  ensureContextFilesSchema(db);
  const missing = [...new Set(ids)].filter(
    (id) => !db.prepare("SELECT 1 FROM context_files WHERE id = ?").get(id),
  );
  if (missing.length)
    throw new ApiError(422, "validation_failed", "unknown context files", { missing });
}

export function contextFileRoutes(app: FastifyInstance, s: Services) {
  ensureContextFilesSchema(s.db);
  const get = (id: string) =>
    s.db.prepare("SELECT * FROM context_files WHERE id = ?").get(id) as ContextFileRow | undefined;

  app.get("/v1/context-files", () => ({
    files: (
      s.db.prepare("SELECT * FROM context_files ORDER BY created_at DESC").all() as ContextFileRow[]
    ).map(contextFileView),
  }));

  app.post(
    "/v1/context-files",
    // An image is up to 10 MB, a third larger as base64.
    { bodyLimit: Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024 },
    (req, reply) => {
      if (!s.dataDir) throw new ApiError(503, "internal", "uploads need Sindri's data directory");
      const body = parseBody(Upload, req.body);
      const name = safeName(body.name);
      const mime = body.mime.toLowerCase();
      const markdown =
        /\.(md|markdown)$/i.test(name) &&
        ["text/markdown", "text/plain", "text/x-markdown", "application/octet-stream", ""].includes(
          mime,
        );
      const ext = IMAGE_TYPES[mime];
      if (!markdown && !ext)
        throw new ApiError(
          422,
          "validation_failed",
          "upload a Markdown file (.md) or an image (PNG, JPEG, GIF or WebP)",
        );
      const buf = Buffer.from(body.contentBase64, "base64");
      const max = markdown ? MAX_MARKDOWN_BYTES : MAX_IMAGE_BYTES;
      if (buf.byteLength === 0 || buf.byteLength > max)
        throw new ApiError(
          422,
          "validation_failed",
          `the file must be between 1 byte and ${max / 1024 / 1024} MB`,
        );
      if (markdown && buf.toString("utf8").includes("\u0000"))
        throw new ApiError(422, "validation_failed", "a Markdown file must be text");
      const id = `cf_${randomUUID()}`;
      const dir = join(s.dataDir, "context-files", id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fileName = markdown ? name : `${name.replace(/\.[^.]*$/, "")}.${ext}`;
      const path = join(dir, fileName);
      writeFileSync(path, buf, { mode: 0o600 });
      const row: ContextFileRow = {
        id,
        name: fileName,
        kind: markdown ? "markdown" : "image",
        mime: markdown ? "text/markdown" : mime,
        bytes: buf.byteLength,
        sha256: createHash("sha256").update(buf).digest("hex"),
        path,
        created_at: new Date().toISOString(),
      };
      s.db
        .prepare(
          `INSERT INTO context_files (id, name, kind, mime, bytes, sha256, path, created_at)
           VALUES (@id, @name, @kind, @mime, @bytes, @sha256, @path, @created_at)`,
        )
        .run(row);
      return reply.code(201).send({ file: contextFileView(row) });
    },
  );

  app.get<{ Params: { id: string } }>("/v1/context-files/:id/content", (req, reply) => {
    const row = get(req.params.id);
    if (!row) throw notFound("context file");
    return reply
      .type(row.kind === "markdown" ? "text/markdown; charset=utf-8" : row.mime)
      .header("x-content-type-options", "nosniff")
      .send(readFileSync(row.path));
  });

  app.delete<{ Params: { id: string } }>("/v1/context-files/:id", (req) => {
    const row = get(req.params.id);
    if (!row) throw notFound("context file");
    s.db.prepare("DELETE FROM context_files WHERE id = ?").run(row.id);
    if (s.dataDir)
      rmSync(join(s.dataDir, "context-files", row.id), { recursive: true, force: true });
    return { deleted: row.id };
  });
}
