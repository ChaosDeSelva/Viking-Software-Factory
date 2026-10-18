#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { doctor } from "./doctor.js";
import { CliError, EXIT_CONFIG, EXIT_INFRA, EXIT_OK } from "./env.js";
import { exportMission } from "./export.js";
import { runDemo } from "./demo.js";
import { init, showToken } from "./init.js";
import { checkRuntime, runServer } from "./serve.js";

const program = new Command();
program
  .name("mimir")
  .description("Mimir command-line tools")
  .exitOverride()
  .configureOutput({ writeErr: (s) => process.stderr.write(s) });

const json = (cmd: Command): boolean => Boolean(cmd.opts<{ json?: boolean }>().json);
const emit = (asJson: boolean, data: unknown, text: string): void => {
  process.stdout.write(
    asJson ? JSON.stringify(data) + "\n" : text.endsWith("\n") ? text : text + "\n",
  );
};
const withJson = (c: Command): Command => c.option("--json", "machine-readable output");

withJson(program.command("init").description("create the data dir and auth token")).action(
  function (this: Command) {
    const r = init();
    emit(
      json(this),
      r,
      `data dir: ${r.dataDir}\ntoken: ${r.tokenPath} (${r.tokenCreated ? "created" : "already present"})`,
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

withJson(program.command("doctor").description("check the local environment")).action(function (
  this: Command,
) {
  const r = doctor();
  const text = r.checks
    .map((c) => `${c.status.toUpperCase().padEnd(4)} ${c.name.padEnd(13)} ${c.detail}`)
    .join("\n");
  emit(json(this), r, text);
  if (!r.ok) process.exitCode = EXIT_INFRA;
});

withJson(program.command("export").description("export a mission's events as JSON"))
  .requiredOption("--mission <id>", "mission id")
  .requiredOption("--out <file>", "output file")
  .option("--force", "overwrite an existing output file")
  .action(function (this: Command) {
    const o = this.opts<{ mission: string; out: string; force?: boolean }>();
    const r = exportMission(o.mission, o.out, { force: o.force === true });
    emit(json(this), r, `exported ${r.count} events to ${r.out}`);
  });

program
  .command("start")
  .description("start the server and serve the web app on the same origin")
  .option("--runtime <runtime>", "fake | herdr | none (default: MIMIR_RUNTIME, else fake)")
  .action(async function (this: Command) {
    const o = this.opts<{ runtime?: string }>();
    checkRuntime(o.runtime);
    process.exitCode = await runServer(process.env, { runtime: o.runtime });
  });

program
  .command("demo")
  .description("run a throwaway demo mission on the fake runtime")
  .action(async () => {
    process.exitCode = await runDemo(
      process.env,
      (l) => process.stdout.write(l + "\n"),
      (l) => process.stderr.write(l + "\n"),
    );
  });

try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof CommanderError) {
    process.exitCode = e.exitCode === 0 ? EXIT_OK : EXIT_CONFIG;
  } else if (e instanceof CliError) {
    process.stderr.write(`mimir: ${e.message}\n`);
    process.exitCode = e.exitCode;
  } else {
    process.stderr.write(`mimir: ${(e as Error).message}\n`);
    process.exitCode = EXIT_INFRA;
  }
}
