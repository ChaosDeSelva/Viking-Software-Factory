import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

const inside = (root: string, file: string) => file === root || file.startsWith(root + sep);

/**
 * Serve the built SPA from the same origin as the API: assets by path, any other non-API path
 * gets index.html. Refuses traversal, NUL, dotfiles and symlinks that resolve outside `root`.
 * Static files need no token (the SPA must load before it has one); `/v1` stays behind auth.
 */
export function serveWeb(app: FastifyInstance, root: string): void {
  const base = resolve(root);
  const realBase = existsSync(base) ? realpathSync(base) : base;
  const index = join(base, "index.html");
  const notFound = (reply: FastifyReply) => reply.code(404).send();
  const handler = (url: string, reply: FastifyReply) => {
    reply.header("x-content-type-options", "nosniff");
    const pathname = url.split("?")[0] ?? "/";
    if (pathname.startsWith("/v1/") || pathname === "/v1")
      return reply.code(404).send({ error: { code: "not_found", message: "route not found" } });
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return notFound(reply);
    }
    if (decoded.includes("\0")) return notFound(reply);
    if (decoded.split(/[\\/]/).some((seg) => seg.startsWith("."))) return notFound(reply);
    const file = resolve(base, "." + decoded);
    if (!inside(base, file)) return notFound(reply);
    if (decoded !== "/" && existsSync(file)) {
      let real: string;
      try {
        real = realpathSync(file);
      } catch {
        return notFound(reply);
      }
      if (!inside(realBase, real) || !statSync(real).isFile()) return notFound(reply);
      if (decoded.startsWith("/assets/"))
        reply.header("cache-control", "public, max-age=31536000, immutable");
      return reply.type(MIME[extname(real)] ?? "application/octet-stream").send(readFileSync(real));
    }
    // A missing file with an extension is a broken asset, not a client-side route.
    if (decoded !== "/" && extname(decoded) !== "") return notFound(reply);
    if (!existsSync(index)) return notFound(reply);
    return reply.type(MIME[".html"]!).header("cache-control", "no-cache").send(readFileSync(index));
  };
  app.get("/", (req, reply) => handler(req.url, reply));
  app.get("/*", (req, reply) => handler(req.url, reply));
}
