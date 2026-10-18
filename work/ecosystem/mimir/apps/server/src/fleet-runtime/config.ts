import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SkidbladnirRuntime } from "../skidbladnir-runtime/adapter.js";
import { SshRuntime } from "../ssh-runtime/adapter.js";
import { TerminalRuntime } from "../terminal-runtime/adapter.js";
import { NativeTerminalBackend } from "../terminal-runtime/backend.js";
import { CliRuntime } from "../cli-runtime/adapter.js";
import { FleetRuntime, type FleetNode } from "./adapter.js";
const WorkerSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    capacity: z.number().int().min(1).max(128),
    agentKinds: z.array(z.string().min(1)).min(1).optional(),
    runtime: z.enum([
      "ssh",
      "cli",
      "tmux",
      "tmux-interactive",
      "zellij",
      "cmux",
      "orca",
      "skidbladnir",
    ]),
    host: z.string().optional(),
    url: z.string().optional(),
    template: z.enum(["node", "python", "general"]).optional(),
    minutes: z.number().int().min(5).max(240).optional(),
    backend: z.literal("tmux-interactive").optional(),
    root: z.string().optional(),
  })
  .strict()
  .refine((w) => w.runtime !== "ssh" || (!!w.host && !!w.root), "SSH workers require host and root")
  .refine(
    (w) => w.runtime !== "skidbladnir" || (!!w.url && !!w.root && !!w.template && !!w.minutes),
    "Skidbladnir workers require url, root, template and minutes",
  );
export const FleetConfigSchema = z
  .object({ version: z.literal(1), workers: z.array(WorkerSchema).min(1).max(64) })
  .strict();
export function loadFleet(file: string, dataDir: string): FleetRuntime {
  const config = FleetConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (new Set(config.workers.map((w) => w.id)).size !== config.workers.length)
    throw new Error("Duplicate worker IDs");
  const nodes: FleetNode[] = config.workers.map((w) => ({
    id: w.id,
    capacity: w.capacity,
    identity: JSON.stringify(
      w.runtime === "skidbladnir"
        ? [w.runtime, w.url, w.root, w.template, w.minutes]
        : [w.runtime, w.host ?? null, w.root ?? null, w.backend ?? null],
    ),
    ...(w.agentKinds ? { agentKinds: w.agentKinds } : {}),
    runtime:
      w.runtime === "skidbladnir"
        ? new SkidbladnirRuntime(
            { url: w.url!, root: w.root!, template: w.template!, minutes: w.minutes!, id: w.id },
            join(dataDir, "fleet", `${w.id}-skidbladnir.json`),
          )
        : w.runtime === "ssh"
          ? new SshRuntime(
              { host: w.host!, root: w.root!, ...(w.backend ? { backend: w.backend } : {}) },
              join(dataDir, "fleet", `${w.id}-ssh.json`),
            )
          : w.runtime === "cli" || w.runtime === "tmux"
            ? new CliRuntime({}, w.runtime)
            : new TerminalRuntime(
                new NativeTerminalBackend(w.runtime, join(dataDir, "fleet", w.id)),
                join(dataDir, "fleet", w.id),
              ),
  }));
  return new FleetRuntime(nodes, join(dataDir, "fleet", "placements.json"));
}
