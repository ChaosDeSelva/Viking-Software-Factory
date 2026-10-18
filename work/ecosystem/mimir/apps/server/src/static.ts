import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { MimirError } from "@mimir/protocol";
import type { FastifyInstance } from "fastify";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** The file at `rel` under `root` when it is a regular file that really lives inside `root`. */
function regularFileInside(root: string, rel: string): string | null {
  const candidate = resolve(root, `.${sep}${rel}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  try {
    const real = realpathSync(candidate);
    if (real !== root && !real.startsWith(root + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Serves the built web app (`apps/web/dist`) from the API origin: exact files, with an
 * `index.html` fallback for extensionless client-side routes. Directories are never listed, paths
 * cannot leave `webRoot` (lexically or through symlinks), and nothing under `/v1/` is handled
 * here: the security hook (Host, Origin, bearer) is registered globally and still runs first.
 */
export function registerStatic(app: FastifyInstance, webRoot: string): void {
  const root = realpathSync(resolve(webRoot));
  const index = regularFileInside(root, "index.html");
  if (index === null) throw new Error(`web root ${webRoot} has no index.html`);

  const send = (
    reply: import("fastify").FastifyReply,
    file: string,
    cache: string,
    method: string,
  ) => {
    void reply
      .header(
        "content-type",
        CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      )
      .header("cache-control", cache)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "frame-ancestors 'none'")
      .header("referrer-policy", "no-referrer")
      .header("content-length", statSync(file).size);
    return method === "HEAD" ? reply.send() : reply.send(createReadStream(file));
  };

  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    config: { publicStatic: true },
    handler: (request, reply) => {
      const q = request.url.indexOf("?");
      const rawPath = q === -1 ? request.url : request.url.slice(0, q);
      if (rawPath === "/v1" || rawPath.startsWith("/v1/")) {
        throw new MimirError("not_found", `route ${request.method} ${request.url} not found`);
      }
      let path: string;
      try {
        path = decodeURIComponent(rawPath);
      } catch {
        throw new MimirError("not_found", "not found");
      }
      if (path.includes("\0")) throw new MimirError("not_found", "not found");
      const rel = path.replace(/^\/+/, "");
      const file = rel === "" ? null : regularFileInside(root, rel);
      if (file !== null) {
        const cache = rel.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        return send(reply, file, cache, request.method);
      }
      // A missing file that looks like an asset is a real 404; anything else is a client route.
      if (extname(rel) !== "") throw new MimirError("not_found", "not found");
      return send(reply, join(root, "index.html"), "no-cache", request.method);
    },
  });
}
