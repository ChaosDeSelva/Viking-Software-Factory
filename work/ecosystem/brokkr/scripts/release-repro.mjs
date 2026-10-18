// pnpm release:repro: runs `pnpm release:local` twice and requires a byte-identical
// archive and SBOM (review I6). Exit 1 on any difference.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const hashes = () =>
  Object.fromEntries(
    readdirSync(dist)
      .filter((f) => f.endsWith(".tar.gz") || f.endsWith(".sbom.cdx.json"))
      .sort()
      .map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(join(dist, f)))
          .digest("hex"),
      ]),
  );
const runs = [];
for (let i = 1; i <= 2; i++) {
  execFileSync("node", [join(root, "scripts/release-local.mjs")], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, BROKKR_SKIP_COVERAGE: "1" }, // coverage is not part of the artifact
  });
  runs.push(hashes());
  console.log(`run ${i}:`, JSON.stringify(runs[i - 1], null, 2));
}
const same = JSON.stringify(runs[0]) === JSON.stringify(runs[1]) && Object.keys(runs[0]).length > 0;
console.log(same ? "reproducible: both runs are byte-identical" : "NOT reproducible");
process.exit(same ? 0 : 1);
