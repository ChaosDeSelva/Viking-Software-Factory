import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";

export interface TarballInspection {
  /** Archive member names as listed by `tar -tzf`. */
  entries: string[];
  /** The single top-level directory every member lives under. */
  topLevel?: string;
  problems: string[];
}

function runTar(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
}

/**
 * List an archive's members (`tar -tzf` for names, `tar -tzvf` for entry
 * types) and report anything unsafe: absolute paths, `..` components,
 * links (symbolic or hard), special files, and members outside a single
 * top-level directory. Verified against bsdtar (macOS); GNU tar uses the same
 * listing format for the type column but is not exercised by the test suite.
 */
export function inspectTarball(file: string): TarballInspection {
  const names = runTar(["-tzf", file]);
  const verbose = runTar(["-tzvf", file]);
  if (!names.ok || !verbose.ok) {
    return {
      entries: [],
      problems: [`cannot list archive: ${names.stderr || verbose.stderr}`.trim()],
    };
  }
  const entries = names.stdout.split("\n").filter((l) => l !== "");
  const lines = verbose.stdout.split("\n").filter((l) => l !== "");
  const problems: string[] = [];
  if (entries.length !== lines.length || entries.length === 0) {
    problems.push("archive listing is empty or ambiguous (member names with newlines?)");
  }
  const tops = new Set<string>();
  entries.forEach((name, i) => {
    const type = lines[i]?.[0];
    if (type !== "-" && type !== "d") {
      problems.push(
        `'${name}' is a ${type === "l" ? "symbolic link" : type === "h" ? "hard link" : `special entry (${type ?? "?"})`}`,
      );
    }
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\\")) {
      problems.push(`'${name}' is an absolute or non-POSIX path`);
    }
    const segments = name.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.includes("..")) problems.push(`'${name}' contains a '..' component`);
    if (segments[0] !== undefined) tops.add(segments[0]);
  });
  if (tops.size > 1)
    problems.push(
      `members span several top-level entries (${[...tops].sort().join(", ")}); expected one directory`,
    );
  const [topLevel] = [...tops];
  const singleDir =
    tops.size === 1 &&
    entries.some(
      (n, i) => lines[i]?.[0] === "-" && n.split("/").filter((s) => s && s !== ".").length > 1,
    );
  if (tops.size === 1 && !singleDir)
    problems.push("archive must contain one top-level directory with the harness files inside it");
  return { entries, ...(topLevel !== undefined ? { topLevel } : {}), problems };
}

/** Extract into a fresh `dest` directory. Call only after `inspectTarball` reported no problems. */
export async function extractTarball(file: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const r = runTar(["-xzf", file, "-C", dest]);
  if (!r.ok) {
    await rm(dest, { recursive: true, force: true });
    throw new Error(`tar extraction failed: ${r.stderr}`);
  }
}
