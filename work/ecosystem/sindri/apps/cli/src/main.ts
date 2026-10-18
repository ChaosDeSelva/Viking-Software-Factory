#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Command, CommanderError } from "commander";
import { demo } from "./demo.js";
import { approve, type ApproveKind } from "./approve.js";
import { doctor } from "./doctor.js";
import { CliError, EXIT_CONFIG, EXIT_INFRA, EXIT_OK } from "./env.js";
import { exportData } from "./export.js";
import { init, showToken } from "./init.js";
import { start } from "./start.js";

const program = new Command();
program
  .name("sindri")
  .description("Sindri command-line tools")
  .exitOverride()
  .configureOutput({ writeErr: (s) => process.stderr.write(s) });

const json = (cmd: Command): boolean => Boolean(cmd.opts<{ json?: boolean }>().json);
const emit = (asJson: boolean, data: unknown, text: string): void => {
  process.stdout.write(
    asJson ? JSON.stringify(data) + "\n" : text.endsWith("\n") ? text : text + "\n",
  );
};
const withJson = (c: Command): Command => c.option("--json", "machine-readable output");

withJson(program.command("init").description("create the data dir, config and auth token")).action(
  function (this: Command) {
    const r = init();
    emit(
      json(this),
      r,
      `data dir: ${r.dataDir}\nconfig: ${r.configPath} (environment variables override it)\ntoken: ${r.tokenPath} (${r.tokenCreated ? "created" : "already present"})`,
    );
  },
);

const token = program.command("token").description("auth token commands");
withJson(token.command("show").description("print the auth token")).action(function (
  this: Command,
) {
  const t = showToken();
  emit(json(this), { token: t }, t);
});

withJson(program.command("doctor").description("check the local environment")).action(
  async function (this: Command) {
    const r = await doctor();
    const text = r.checks
      .map((c) => `${c.status.toUpperCase().padEnd(4)} ${c.name.padEnd(13)} ${c.detail}`)
      .join("\n");
    emit(json(this), r, text);
    if (!r.ok) process.exitCode = EXIT_INFRA;
  },
);

withJson(program.command("start").description("run the server and web app on one origin")).action(
  async function (this: Command) {
    const s = await start();
    emit(json(this), { url: s.url }, `sindri listening on ${s.url}`);
    const stop = (): void => {
      void s.close().finally(() => process.exit(EXIT_OK));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },
);

withJson(
  program.command("export").description("export the database snapshot and settings as a zip"),
)
  .requiredOption("--out <file>", "output file")
  .option("--force", "overwrite an existing output file")
  .action(function (this: Command) {
    const o = this.opts<{ out: string; force?: boolean }>();
    const r = exportData(o.out, { force: o.force === true });
    emit(json(this), r, `exported ${r.bytes} bytes to ${r.out}`);
  });

withJson(
  program
    .command("approve")
    .description("approve a spec or plan, or request a PR, at this terminal (needs a TTY)")
    .argument("<kind>", "spec, plan or pr (pr takes an execution id)")
    .argument("<id>", "the spec, plan or execution id"),
).action(async function (this: Command, kind: string, id: string) {
  if (kind !== "spec" && kind !== "plan" && kind !== "pr")
    throw new CliError(`unknown kind ${kind}: use spec, plan or pr`, EXIT_CONFIG);
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    : undefined;
  try {
    const r = await approve(kind as ApproveKind, id, {
      io: {
        isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
        prompt: (q) => (rl ? rl.question(q) : Promise.resolve("")),
        write: (t) => void process.stderr.write(t),
      },
    });
    emit(json(this), r, `${kind} ${id} approved by ${r.approvedBy}`);
  } finally {
    rl?.close();
  }
});

withJson(
  program
    .command("demo")
    .description("create a sample repo, bootstrap it and import a fixture ticket"),
)
  .option("--dir <path>", "where to create the demo (absent or empty); default a temp dir")
  .option("--with-failing-test", "plant one failing test (fails once, then passes)")
  .action(async function (this: Command) {
    const o = this.opts<{ dir?: string; withFailingTest?: boolean }>();
    const r = await demo({
      ...(o.dir ? { dir: o.dir } : {}),
      failingTest: o.withFailingTest === true,
    });
    emit(
      json(this),
      r,
      [
        `demo repo: ${r.repoPath}`,
        `project:   ${r.projectId} (bootstrap indexed ${r.bootstrap.indexed} files)`,
        `ticket:    ${r.intakeId} imported from ${r.ticketPath}`,
        ...(r.failingTest ? [`planted failing test: ${r.failingTest} (fails once)`] : []),
        "",
        "Next: run `sindri start`, open the URL below, paste `sindri token show`,",
        "then draft a spec from the ticket in Director.",
        r.url,
      ].join("\n"),
    );
  });

/** Errors go to stderr, or to stdout as `{ok:false,error,exitCode}` under --json (review m3). */
function fail(message: string, exitCode: number): void {
  if (process.argv.includes("--json"))
    process.stdout.write(JSON.stringify({ ok: false, error: message, exitCode }) + "\n");
  else process.stderr.write(`sindri: ${message}\n`);
  process.exitCode = exitCode;
}

try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof CommanderError) {
    process.exitCode = e.exitCode === 0 ? EXIT_OK : EXIT_CONFIG;
  } else if (e instanceof CliError) {
    fail(e.message, e.exitCode);
  } else {
    fail((e as Error).message, EXIT_INFRA);
  }
}
