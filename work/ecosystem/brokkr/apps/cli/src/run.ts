import { Command, CommanderError, Option } from "commander";
import { CLI_EXIT_CODES } from "./exit.js";
import { CommandContext, Interrupted, type CliIO, type GlobalOptions } from "./io.js";
import { CLI_VERSION } from "./paths.js";

type Handler = (ctx: CommandContext, ...args: never[]) => Promise<number>;

/**
 * Run the Brokkr CLI with `argv` (user arguments only) and return the exit
 * code. Command implementations are imported lazily so `--help` stays fast.
 */
export async function run(argv: string[], partial: Partial<CliIO> = {}): Promise<number> {
  const io: CliIO = {
    stdout: partial.stdout ?? ((s) => process.stdout.write(s)),
    stderr: partial.stderr ?? ((s) => process.stderr.write(s)),
    env: partial.env ?? process.env,
    stdin: partial.stdin ?? process.stdin,
    ...(partial.signal ? { signal: partial.signal } : {}),
  };
  let exitCode: number = CLI_EXIT_CODES.ok;
  let ctxRef: CommandContext | undefined;

  const program = new Command();
  program
    .name("brokkr")
    .description(
      "Engineering harnesses, skill resolution and deterministic verification for AI coding agents",
    )
    .version(CLI_VERSION)
    .option("--json", "machine-readable JSON output")
    .option("--cwd <dir>", "repository root (default: current directory)")
    .option("--verbose", "debug logging to stderr")
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showSuggestionAfterError();

  const action =
    (load: () => Promise<Handler>) =>
    async (...args: unknown[]): Promise<void> => {
      const command = args[args.length - 1] as Command;
      const options = command.optsWithGlobals<GlobalOptions & Record<string, unknown>>();
      if (options.verbose)
        io.env = { ...io.env, BROKKR_LOG_LEVEL: io.env.BROKKR_LOG_LEVEL ?? "debug" };
      const ctx = new CommandContext(io, options);
      ctxRef = ctx;
      const handler = await load();
      // Positional args, then the command's own options object.
      exitCode = await handler(ctx, ...(args.slice(0, -1) as never[]));
    };

  program
    .command("init")
    .description(
      "inspect the repository, recommend harnesses, write .brokkr/config.yaml and the lockfile",
    )
    .option("-y, --yes", "approve without prompting (non-interactive)")
    .action(action(async () => (await import("./commands/init.js")).initCommand as Handler));

  const harness = program.command("harness").description("manage harness packages");
  harness
    .command("list")
    .description("list harnesses from every registry source")
    .action(action(async () => (await import("./commands/harness.js")).harnessList as Handler));
  harness
    .command("inspect <name>")
    .description("show a harness manifest, skills, checks and policies")
    .option("--range <range>", "semver range", "*")
    .action(action(async () => (await import("./commands/harness.js")).harnessInspect as Handler));
  harness
    .command("validate <dir>")
    .description("validate a harness package directory")
    .action(action(async () => (await import("./commands/harness.js")).harnessValidate as Handler));
  harness
    .command("add <spec>")
    .description("add name[@range] to .brokkr/config.yaml and relock")
    .action(action(async () => (await import("./commands/harness.js")).harnessAdd as Handler));
  harness
    .command("lock")
    .description("write .brokkr/harness.lock.json from the configured harnesses")
    .option("--verify", "verify the existing lockfile against the harness contents instead")
    .action(action(async () => (await import("./commands/harness.js")).harnessLock as Handler));

  const skills = program.command("skills").description("inspect skills");
  skills
    .command("list")
    .description("list skills shipped by available harnesses")
    .action(action(async () => (await import("./commands/skills.js")).skillsList as Handler));
  skills
    .command("resolve")
    .description("select skills for a task")
    .requiredOption("--task <file>", "task descriptor (JSON or YAML)")
    .option("--budget <tokens>", "context budget in estimated tokens")
    .action(action(async () => (await import("./commands/skills.js")).skillsResolve as Handler));

  program
    .command("prepare")
    .description("generate provider-specific agent instructions for a task")
    .addOption(new Option("--provider <id>", "provider adapter").makeOptionMandatory())
    .requiredOption("--task <file>", "task descriptor (JSON or YAML)")
    .option("--budget <tokens>", "context budget in estimated tokens")
    .option(
      "--modify-project-instructions",
      "write into the project's own CLAUDE.md/AGENTS.md (explicit approval)",
    )
    .option("--cleanup", "remove a previously prepared bundle instead")
    .action(action(async () => (await import("./commands/prepare.js")).prepareCommand as Handler));

  program
    .command("doctor")
    .description("diagnose the environment and harness lock integrity")
    .action(action(async () => (await import("./commands/doctor.js")).doctorCommand as Handler));

  const trust = program.command("trust").description("manage trusted external harness sources");
  trust
    .command("list")
    .description("list harness sources and their trust")
    .action(action(async () => (await import("./commands/trust.js")).trustList as Handler));
  trust
    .command("add <source>")
    .description("trust a pinned external source (directory or .tgz) after checking its digest")
    .option("--digest <sha256>", "expected digest (sha256:...)")
    .action(action(async () => (await import("./commands/trust.js")).trustAdd as Handler));

  program
    .command("verify")
    .description("run the configured checks and record a verification report")
    .option("--profile <name>", "verify with a named profile")
    .option(
      "--task <file>",
      "task descriptor (JSON or YAML) for exception scope and policy overrides",
    )
    .option("--executor <id>", "check executor", "local")
    .option("--exceptions <file>", "approval exceptions file (instead of .brokkr/exceptions.yaml)")
    .option("--policy <file>", "project policy file (instead of policies in .brokkr/config.yaml)")
    .option(
      "--untrusted-workspace",
      "the workspace is the work under test: read config, lock, exceptions and policy only from caller-supplied files or ~/.brokkr",
    )
    .option(
      "--config <file>",
      "caller-supplied project config (required with --untrusted-workspace unless ~/.brokkr/config.yaml exists)",
    )
    .option(
      "--lock <file>",
      "caller-supplied harness lock (a missing lock blocks with --untrusted-workspace)",
    )
    .option(
      "--approver <id>",
      "approver identity whose exceptions are honoured (repeatable; required for exceptions with --untrusted-workspace)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action(action(async () => (await import("./commands/verify.js")).verifyCommand as Handler));

  program
    .command("report")
    .description("show a stored verification report after checking its integrity")
    .option("--latest", "the most recent run (default)")
    .option("--run <id>", "a specific run id")
    .option("--format <format>", "json, md or html")
    .action(action(async () => (await import("./commands/report.js")).reportCommand as Handler));

  const runs = program.command("runs").description("manage stored verification runs");
  runs
    .command("list")
    .description("list verification runs, newest first")
    .action(action(async () => (await import("./commands/runs.js")).runsList as Handler));
  runs
    .command("prune")
    .description("delete old runs (retention)")
    .option("--keep <n>", "keep the newest n runs")
    .option("--older-than <duration>", "delete runs older than e.g. 7d, 12h")
    .action(action(async () => (await import("./commands/runs.js")).runsPrune as Handler));

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.exitCode === 0
      ) {
        return CLI_EXIT_CODES.ok;
      }
      if (argv.includes("--json")) {
        io.stdout(
          `${JSON.stringify({ error: { code: "usage", message: error.message } }, null, 2)}\n`,
        );
      }
      return CLI_EXIT_CODES.invalidConfig;
    }
    if (error instanceof Interrupted) {
      io.stderr("interrupted\n");
      return CLI_EXIT_CODES.interrupted;
    }
    const { reportError } = await import("./errors.js");
    return reportError(error, io, ctxRef?.json ?? argv.includes("--json"));
  }
}
