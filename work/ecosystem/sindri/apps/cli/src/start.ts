import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, startServer } from "@sindri/server";
import { CliError, EXIT_CONFIG, EXIT_INFRA } from "./env.js";

export function webDistDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["SINDRI_WEB_DIST"] || new URL("../../web/dist", import.meta.url).pathname;
}

export interface StartResult {
  url: string;
  close: () => Promise<void>;
}

/** Server + built web app on one origin; config from env over `<dataDir>/config.json`. */
export async function start(env: NodeJS.ProcessEnv = process.env): Promise<StartResult> {
  const web = webDistDir(env);
  if (!existsSync(join(web, "index.html")))
    throw new CliError(`web build not found at ${web}; run \`pnpm build\``, EXIT_CONFIG);
  try {
    loadConfig(env);
  } catch (e) {
    throw new CliError((e as Error).message, EXIT_CONFIG);
  }
  try {
    const s = await startServer(env, {
      webDist: web,
      logLevel: env["SINDRI_LOG_LEVEL"] ?? "warn",
      // The approval pairing code is shown on this terminal only, never logged (audit M9).
      overrides: {
        approval: {
          onPairingCode: (code) =>
            process.stderr.write(
              `sindri approval pairing code: ${code}\n  Enter it in the browser or at the \`sindri approve\` prompt to approve specs, plans and PRs. Never give it to an agent.\n`,
            ),
        },
      },
    });
    return { url: s.url, close: () => s.close() };
  } catch (e) {
    throw new CliError(`cannot start: ${(e as Error).message}`, EXIT_INFRA);
  }
}
