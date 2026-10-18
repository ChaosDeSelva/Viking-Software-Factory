import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve(new URL("..", import.meta.url).pathname),
  out = resolve(process.argv[2] ?? join(root, "..", "heimdall-local.tar.gz"));
const temp = mkdtempSync(join(tmpdir(), "heimdall-release-")),
  dest = join(temp, "heimdall");
try {
  mkdirSync(dest);
  for (const name of ["apps/server", "dist", "site", "LICENSE", "README.md", "docs", "third_party", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"])
    cpSync(join(root, name), join(dest, name), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify(
      {
        name: "heimdall-local",
        version: "1.0.0-rc.1",
        type: "module",
        license: "Apache-2.0",
        engines: { node: ">=24" },
        scripts: { start: "node apps/server/main.mjs" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dest, "Start Heimdall.command"),
    '#!/bin/zsh\ncd "${0:A:h}"\nexec node apps/server/main.mjs\n',
  );
  chmodSync(join(dest, "Start Heimdall.command"), 0o755);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync("tar", ["-czf", out, "-C", temp, "heimdall"]);
  writeFileSync(
    out + ".sha256",
    createHash("sha256").update(readFileSync(out)).digest("hex") +
      "  " +
      out.split("/").at(-1) +
      "\n",
  );
  console.log(out);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
