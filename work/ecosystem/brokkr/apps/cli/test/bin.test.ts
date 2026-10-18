import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "@brokkr/core";
import { CLI_EXIT_CODES } from "../src/exit.js";
import { reactRepo, tmp } from "./helpers.js";

const BIN = resolve(import.meta.dirname, "../dist/bin.js");
const env = { ...process.env, BROKKR_HOME: tmp("brokkr-home-"), BROKKR_LOG_LEVEL: "silent" };

function brokkr(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
}

describe("built bin (public process contract)", () => {
  it("dist/bin.js exists (run `pnpm build` first)", () => {
    expect(existsSync(BIN)).toBe(true);
  });

  it("CLI exit codes mirror the core contract", () => {
    expect(CLI_EXIT_CODES).toEqual(EXIT_CODES);
  });

  it("returns the contract codes as real process exit statuses", { timeout: 30_000 }, () => {
    expect(brokkr(["harness", "list"]).status).toBe(0);
    expect(brokkr(["harness", "validate", tmp()]).status).toBe(2);
    expect(brokkr(["verify", "--cwd", tmp()]).status).toBe(2);
    expect(brokkr(["report", "--cwd", tmp()]).status).toBe(2);
    const broken = tmp();
    mkdirSync(join(broken, ".brokkr"));
    writeFileSync(join(broken, ".brokkr", "config.yaml"), "version: 1\nharnesses: []\n");
    const lockedHome = tmp("brokkr-home-");
    mkdirSync(join(lockedHome, ".brokkr"), { mode: 0o555 });
    const infra = spawnSync(process.execPath, [BIN, "verify", "--cwd", broken], {
      encoding: "utf8",
      env: { ...env, BROKKR_HOME: lockedHome },
    });
    expect(infra.status).toBe(3);
  });

  it("--help starts within 2 s (spec target 300 ms; measured time is printed)", () => {
    brokkr(["--help"]); // warm the filesystem cache
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const result = brokkr(["--help"]);
      samples.push(performance.now() - start);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: brokkr");
    }
    const best = Math.min(...samples);
    // Controller ruling: a hard failure only above 2 s; the spec's 300 ms target is recorded, not enforced,
    // because this shared machine runs several gates at once.
    console.log(
      `brokkr --help: best ${best.toFixed(0)} ms of [${samples.map((t) => t.toFixed(0)).join(", ")}] (target < 300 ms, fail > 2000 ms)`,
    );
    expect(best).toBeLessThan(2000);
  });

  it("exits 130 on SIGINT while waiting for approval", async () => {
    const repo = reactRepo();
    const child = spawn(process.execPath, [BIN, "init", "--cwd", repo], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    await new Promise<void>((resolvePrompt, reject) => {
      const timer = setTimeout(() => reject(new Error(`no prompt; got: ${out}`)), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("[y/N]")) {
          clearTimeout(timer);
          resolvePrompt();
        }
      });
    });
    child.kill("SIGINT");
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    expect(code).toBe(130);
    expect(existsSync(join(repo, ".brokkr"))).toBe(false);
  });
});
