// Builds @mimir/protocol and @mimir/sdk, then writes their tarballs to <repo>/dist-packages/.
// `pnpm pack` rewrites `workspace:*` ranges to the real versions.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sdkDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(sdkDir, "..", "..");
const out = join(root, "dist-packages");
mkdirSync(out, { recursive: true });

const run = (cwd, args) => execFileSync("pnpm", args, { cwd, stdio: "inherit" });
run(root, ["exec", "turbo", "run", "build", "--filter=@mimir/sdk"]);
for (const dir of [join(root, "packages", "protocol"), sdkDir]) {
  run(dir, ["pack", "--pack-destination", out]);
}
console.log(`tarballs written to ${out}`);
