import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CLI_EXIT_CODES } from "./exit.js";
import { defaultBuiltinDir } from "./paths.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  stdin: NodeJS.ReadableStream;
  signal?: AbortSignal;
}

export interface GlobalOptions {
  json?: boolean;
  cwd?: string;
  verbose?: boolean;
}

/** Per-invocation context handed to command handlers. */
export class CommandContext {
  readonly cwd: string;
  readonly json: boolean;
  readonly homeDir: string;
  readonly builtinDir: string;

  constructor(
    readonly io: CliIO,
    options: GlobalOptions,
  ) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.json = options.json === true;
    this.homeDir = io.env.BROKKR_HOME ?? homedir();
    this.builtinDir = defaultBuiltinDir(io.env);
  }

  /** Print human text, or the JSON document when `--json` is set. */
  emit(data: unknown, text: string | (() => string)): void {
    if (this.json) this.io.stdout(`${JSON.stringify(data, null, 2)}\n`);
    else {
      const out = typeof text === "function" ? text() : text;
      this.io.stdout(out.endsWith("\n") ? out : `${out}\n`);
    }
  }

  /** Ask a yes/no question on stdin. EOF counts as "no"; abort throws an interrupt. */
  async confirm(question: string): Promise<boolean> {
    const write = this.json ? this.io.stderr : this.io.stdout;
    write(`${question} [y/N] `);
    const rl = createInterface({ input: this.io.stdin, terminal: false });
    try {
      const answer = await new Promise<string>((resolveAnswer, reject) => {
        const onAbort = (): void => reject(new Interrupted());
        if (this.io.signal?.aborted) return onAbort();
        this.io.signal?.addEventListener("abort", onAbort, { once: true });
        rl.once("line", (line) => resolveAnswer(line));
        rl.once("close", () => resolveAnswer(""));
      });
      write("\n");
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  }
}

export class Interrupted extends Error {
  readonly exitCode = CLI_EXIT_CODES.interrupted;
  constructor() {
    super("interrupted");
  }
}
