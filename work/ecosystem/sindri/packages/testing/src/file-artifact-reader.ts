import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TEST ONLY. Reads `file://` artifact URIs confined to `roots`. Production Sindri never reads
 * Mimir's filesystem: artifact bytes come from Mimir (`MimirClientFacade.artifactContent`).
 * The file is opened once (no symlink follow on the final component) and checked through that
 * handle, so it cannot be swapped between the check and the read.
 */
export function testFileArtifactContentReader(options: {
  roots: string[];
  maxBytes?: number;
  timeoutMs?: number;
}): {
  read(artifact: { id: string; uri: string }): Promise<string>;
} {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async read(artifact) {
      if (!artifact.uri.startsWith("file:")) {
        throw new Error(`only file: artifact URIs can be read (${artifact.id})`);
      }
      const path = fileURLToPath(artifact.uri);
      let real: string;
      try {
        real = await realpath(path);
      } catch {
        throw new Error(`artifact ${artifact.id} is outside the allowed artifact roots`);
      }
      let inside = false;
      for (const root of options.roots) {
        const rel = relative(await realpath(resolve(root)), real);
        if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) inside = true;
      }
      if (!inside) {
        throw new Error(`artifact ${artifact.id} is outside the allowed artifact roots`);
      }
      // A FIFO or device would block `open`/`read` forever (audit L9): refuse it before opening,
      // open non-blocking, re-check through the handle, and bound the read in time.
      if (!(await lstat(real)).isFile()) {
        throw new Error(`artifact ${artifact.id} is not a regular file`);
      }
      const handle = await open(
        real,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error(`artifact ${artifact.id} is not a regular file`);
        if (info.size > maxBytes) {
          throw new Error(`artifact ${artifact.id} is too large (limit ${maxBytes} bytes)`);
        }
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`artifact ${artifact.id} read timed out`)),
            timeoutMs,
          );
        });
        return await Promise.race([handle.readFile({ encoding: "utf8" }), timeout]);
      } finally {
        clearTimeout(timer);
        await handle.close();
      }
    },
  };
}
