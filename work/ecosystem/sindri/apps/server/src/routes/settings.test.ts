import { Writable } from "node:stream";
import { openDatabase } from "@sindri/knowledge";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ApprovalAuthority } from "../approval.js";
import { envelope, toApiError } from "../errors.js";
import { createServices } from "../services.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { settingsRoutes } from "./settings.js";

function server(afterChange?: () => Promise<void>) {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const app = Fastify({ logger: { level: "info", stream } });
  app.setErrorHandler((err, _req, reply) => {
    const e = toApiError(err);
    return reply.code(e.status).send(envelope(e));
  });
  const services = createServices({ db: openDatabase(":memory:") });
  settingsRoutes(app, services, {
    version: "0.0.0",
    approvals: new ApprovalAuthority({ pairingCode: "ABCDE-FGH23" }),
    ...(afterChange ? { afterChange } : {}),
  });
  return { app, services, logs };
}

describe("settings routes", () => {
  it("keeps the saved settings and logs it when the follow-up reconnect fails", async () => {
    let fail!: () => void;
    const failed = new Promise<void>((resolve) => (fail = resolve));
    const { app, services, logs } = server(async () => {
      fail();
      throw new Error("reconnect failed");
    });
    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings",
      payload: { ...DEFAULT_SETTINGS, model: "m2" },
    });
    expect(res.statusCode).toBe(200);
    await failed;
    await new Promise((r) => setImmediate(r));
    expect(services.settings.get().model).toBe("m2");
    expect(logs.join("")).toContain("Settings saved; Mimir reconnection failed");
    // No token location without a data directory.
    expect((await app.inject({ url: "/v1/settings" })).json().tokenLocation).toBeNull();
    await app.close();
  });

  it("deletes a project's data on a request that carries no Idempotency-Key", async () => {
    const { app, services } = server();
    const project = services.knowledge.projects.create({ name: "P", repoPath: "/nonexistent" });
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}/data`,
      payload: { confirm: "P" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: { projectId: project.id } });
    expect(services.knowledge.projects.get(project.id)).toBeUndefined();
    await app.close();
  });
});
