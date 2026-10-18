import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import semver from "semver";
import { loadProjectConfig, readLock } from "@brokkr/registry";
import type { CommandContext } from "../io.js";
import { openRegistry } from "./shared.js";

export const MIN_NODE = ">=25.0.0";

type Status = "ok" | "warn" | "fail";
interface DoctorCheck {
  id: string;
  status: Status;
  detail: string;
}

function probe(cmd: string): string | undefined {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 5000, shell: false });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

export async function doctorCommand(ctx: CommandContext): Promise<number> {
  const checks: DoctorCheck[] = [];
  checks.push({
    id: "node",
    status: semver.satisfies(process.version, MIN_NODE) ? "ok" : "fail",
    detail: `node ${process.version} (requires ${MIN_NODE})`,
  });
  const pnpm = probe("pnpm");
  const npm = pnpm ? undefined : probe("npm");
  checks.push({
    id: "package-manager",
    status: pnpm || npm ? "ok" : "fail",
    detail: pnpm
      ? `pnpm ${pnpm}`
      : npm
        ? `npm ${npm} (pnpm not found)`
        : "neither pnpm nor npm found on PATH",
  });
  const git = probe("git");
  checks.push({ id: "git", status: git ? "ok" : "fail", detail: git ?? "git not found on PATH" });
  let playwright: string | undefined;
  try {
    playwright = createRequire(join(ctx.cwd, "package.json")).resolve(
      "@playwright/test/package.json",
    );
  } catch {
    playwright = undefined;
  }
  checks.push({
    id: "playwright",
    status: playwright ? "ok" : "warn",
    detail: playwright
      ? `@playwright/test found`
      : "@playwright/test not installed (optional; needed for browser checks)",
  });

  const config = await loadProjectConfig(ctx.cwd);
  const lock = await readLock(ctx.cwd);
  if (!config) {
    checks.push({
      id: "harness-lock",
      status: "warn",
      detail: "repository not initialised (run `brokkr init`)",
    });
  } else if (!lock) {
    checks.push({
      id: "harness-lock",
      status: "fail",
      detail: "no .brokkr/harness.lock.json (run `brokkr harness lock`)",
    });
  } else {
    const registry = await openRegistry(ctx, config);
    const result = await registry.verifyLock(lock);
    const bad = result.entries.filter((e) => e.status !== "ok");
    checks.push({
      id: "harness-lock",
      status: result.ok ? "ok" : "fail",
      detail: result.ok
        ? "lockfile matches harness contents"
        : bad.map((e) => `${e.kind} ${e.name}: ${e.status}`).join("; "),
    });
  }
  const ok = checks.every((c) => c.status !== "fail");
  const icon: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };
  ctx.emit({ ok, checks }, () =>
    checks.map((c) => `${icon[c.status]} ${c.id}: ${c.detail}`).join("\n"),
  );
  return ok ? 0 : 1;
}
