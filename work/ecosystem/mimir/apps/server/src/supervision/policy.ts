import { z } from "zod";
export const SupervisorPolicySchema = z
  .object({
    missionId: z.string().min(1),
    agentKind: z.enum(["codex", "claude"]),
    enabled: z.boolean(),
    intervalMs: z.number().int().min(30000).max(3600000).default(60000),
    maxTurns: z.number().int().min(1).max(100).default(10),
  })
  .strict();
export type SupervisorPolicy = z.infer<typeof SupervisorPolicySchema>;
export type StoredPolicy = SupervisorPolicy & { actor: string; turns: number; lastQueued: number };
