import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  parseStructured,
  ProviderError,
  type CompleteRequest,
  type CompleteResult,
  type LlmProvider,
  type LlmUsage,
} from "../provider.js";

export type CliProviderKind = "codex-cli" | "claude-cli";
export interface CliProviderOptions {
  kind: CliProviderKind;
  model?: string;
  executable?: string;
  timeoutMs?: number;
}

/** Reuse the operator's installed CLI login; never read or copy its credentials. */
export class CliProvider implements LlmProvider {
  readonly name: CliProviderKind;
  constructor(private readonly options: CliProviderOptions) {
    this.name = options.kind;
  }

  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    const dir = await mkdtemp(join(tmpdir(), "sindri-director-"));
    try {
      const codex = this.name === "codex-cli";
      const bundled =
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
      const executable =
        this.options.executable ??
        (codex
          ? (process.env["SINDRI_CODEX_BIN"] ?? (existsSync(bundled) ? bundled : "codex"))
          : (process.env["SINDRI_CLAUDE_BIN"] ?? "claude"));
      const schema = req.responseSchema
        ? z.toJSONSchema(req.responseSchema, { target: "draft-7" })
        : undefined;
      const output = join(dir, "response.json");
      const args = codex
        ? [
            "exec",
            "--ignore-user-config",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--json",
            "--output-last-message",
            output,
          ]
        : [
            "--print",
            "--output-format",
            "json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--setting-sources",
            "",
            "--no-session-persistence",
            "--disable-slash-commands",
          ];
      if (this.options.model && this.options.model !== "default")
        args.push("--model", this.options.model);
      if (schema) {
        const path = join(dir, "schema.json");
        await writeFile(path, JSON.stringify(schema), { mode: 0o600 });
        if (codex) args.push("--output-schema", path);
        else args.push("--json-schema", JSON.stringify(schema));
      }
      if (codex) args.push("-");
      const prompt = `${req.system}\n\nYou are a planning provider. Use only the supplied context. Do not use tools, inspect files, execute commands, or change files. Return the requested answer${schema ? " as JSON matching the supplied schema" : ""}.\n\n${req.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n")}`;
      const raw = await runCli(executable, args, prompt, dir, this.options.timeoutMs ?? 180_000);
      let text: string;
      let usage: LlmUsage | null = null;
      let parsed: unknown;
      if (codex) {
        text = await readFile(output, "utf8");
        for (const line of raw.split("\n")) {
          try {
            const e = JSON.parse(line) as {
              type?: string;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              };
            };
            if (
              e.type === "turn.completed" &&
              typeof e.usage?.input_tokens === "number" &&
              typeof e.usage.output_tokens === "number"
            )
              usage = { inputTokens: e.usage.input_tokens, outputTokens: e.usage.output_tokens };
          } catch {
            /* non-event progress is not usage */
          }
        }
      } else {
        const result = JSON.parse(raw) as {
          is_error?: boolean;
          result?: string;
          structured_output?: unknown;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
        if (result.is_error)
          throw new ProviderError(
            "api_error",
            "Claude Code could not complete the planning request",
          );
        parsed = result.structured_output;
        text = result.result ?? (parsed === undefined ? "" : JSON.stringify(parsed));
        if (
          typeof result.usage?.input_tokens === "number" &&
          typeof result.usage.output_tokens === "number"
        )
          usage = {
            inputTokens:
              result.usage.input_tokens +
              (result.usage.cache_creation_input_tokens ?? 0) +
              (result.usage.cache_read_input_tokens ?? 0),
            outputTokens: result.usage.output_tokens,
          };
      }
      return {
        text,
        ...(req.responseSchema
          ? { parsed: parseStructured(req.responseSchema, parsed ?? JSON.parse(text)) }
          : {}),
        usage,
        model: this.options.model ?? "default",
        stopReason: "completed",
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("invalid_output", "CLI planning response was missing or invalid");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Bounded output and a real process-tree deadline keep unattended planning calls finite. */
function runCli(
  executable: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let bytes = 0;
    let failure: ProviderError | undefined;
    const stop = (message: string) => {
      failure = new ProviderError("api_error", message);
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* process already exited */
      }
    };
    const timer = setTimeout(() => stop("CLI planning request exceeded its time limit"), timeoutMs);
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop("CLI planning response exceeded its output limit");
      else if (stdout) out += chunk.toString("utf8");
    };
    child.stdout.on("data", (c: Buffer) => collect(c, true));
    child.stderr.on("data", (c: Buffer) => collect(c, false));
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new ProviderError(
          "provider_unavailable",
          "Planning CLI is unavailable; install it and sign in first",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new ProviderError(
            "api_error",
            `Planning CLI exited with status ${code}; check its login and model settings`,
          ),
        );
      else resolve(out);
    });
    child.stdin.on("error", () => {
      /* early CLI exit is handled above */
    });
    child.stdin.end(input);
  });
}
