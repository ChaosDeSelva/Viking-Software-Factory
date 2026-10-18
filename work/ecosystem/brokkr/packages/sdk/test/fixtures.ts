import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const BUILTIN = join(REPO_ROOT, "harnesses");

export function tempDir(prefix = "brokkr-sdk-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A small React + Vite + TypeScript project with typecheck/lint/test scripts. */
export function reactRepo(scripts: Record<string, string> = {}): string {
  const dir = tempDir("brokkr-sdk-repo-");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        private: true,
        scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest", ...scripts },
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { vite: "^7.0.0", vitest: "^4.0.0", typescript: "^5.9.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "App.tsx"), "export const App = () => null;\n");
  // Dependencies count as installed: a script run without node_modules would make
  // the package manager install first, which verify blocks (install-dependencies).
  mkdirSync(join(dir, "node_modules"));
  return dir;
}

export function writeConfig(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".brokkr"), { recursive: true });
  writeFileSync(join(dir, ".brokkr", "config.yaml"), yaml);
}

/** Copy a built-in harness under a new name into `dest` (for external-source tests). */
export function copyHarness(name: string, dest: string): string {
  const out = join(dest, name);
  cpSync(join(BUILTIN, name), out, { recursive: true });
  return out;
}

export const TASK = {
  id: "UI-142",
  title: "Build analytics dashboard",
  description: "Create a responsive analytics UI with accessible charts",
  tags: ["frontend", "react"],
};
