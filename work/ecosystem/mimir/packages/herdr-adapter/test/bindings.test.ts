import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JsonFileBindingStore,
  MemoryBindingStore,
  defaultBindingsPath,
  type BindingStore,
  type SessionBinding,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bindings-"));
  dirs.push(d);
  return path.join(d, "bindings.json");
}

const binding = (n: number): SessionBinding => ({
  sessionId: `ses_${n}`,
  idempotencyKey: `idem_${n}`,
  paneId: `w${n}:p1`,
  workspaceId: `w${n}`,
  cwd: "/tmp",
  agentKind: "shell",
  createdAt: new Date(0).toISOString(),
});

describe.each<[string, () => BindingStore]>([
  ["MemoryBindingStore", () => new MemoryBindingStore()],
  ["JsonFileBindingStore", () => new JsonFileBindingStore(tmpFile())],
])("%s", (_name, make) => {
  it("looks bindings up by key and by session id, and reports unknown ones as undefined", async () => {
    const store = make();
    await store.put(binding(1));
    await store.put(binding(2));
    expect(await store.get("idem_2")).toEqual(binding(2));
    expect(await store.getBySessionId("ses_1")).toEqual(binding(1));
    expect(await store.get("idem_9")).toBeUndefined();
    expect(await store.getBySessionId("ses_9")).toBeUndefined();
    expect((await store.list()).map((b) => b.sessionId)).toEqual(["ses_1", "ses_2"]);
  });

  it("hands out copies: mutating a result does not change the store", async () => {
    const store = make();
    const mine = binding(1);
    await store.put(mine);
    mine.lost = true;
    (await store.get("idem_1"))!.paneId = "changed";
    (await store.getBySessionId("ses_1"))!.paneId = "changed";
    (await store.list())[0]!.paneId = "changed";
    expect(await store.get("idem_1")).toEqual(binding(1));
  });

  it("put replaces the binding with the same idempotencyKey", async () => {
    const store = make();
    await store.put(binding(1));
    await store.put({ ...binding(1), finalState: "completed", exitCode: 0 });
    expect(await store.list()).toEqual([{ ...binding(1), finalState: "completed", exitCode: 0 }]);
  });
});

describe("JsonFileBindingStore file handling", () => {
  it("a file without a bindings key is an empty store", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "{}");
    expect(await new JsonFileBindingStore(file).list()).toEqual([]);
  });

  it("a corrupt file fails loudly, and the store recovers once the file is readable", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "{ not json");
    const store = new JsonFileBindingStore(file);
    await expect(store.list()).rejects.toThrow(SyntaxError);
    await expect(store.put(binding(1))).rejects.toThrow(SyntaxError);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json"); // never overwritten blindly
    fs.writeFileSync(file, JSON.stringify({ bindings: { idem_2: binding(2) } }));
    expect((await store.list()).map((b) => b.sessionId)).toEqual(["ses_2"]);
  });

  it("leaves no temp file behind and writes the documented shape", async () => {
    const file = tmpFile();
    const store = new JsonFileBindingStore(file);
    await store.put(binding(1));
    expect(fs.readdirSync(path.dirname(file))).toEqual(["bindings.json"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ bindings: { idem_1: binding(1) } });
  });

  it("defaultBindingsPath honours MIMIR_DATA_DIR and falls back to ~/.mimir", () => {
    expect(defaultBindingsPath({ MIMIR_DATA_DIR: "/data/m" })).toBe("/data/m/herdr-bindings.json");
    expect(defaultBindingsPath({})).toBe(path.join(os.homedir(), ".mimir", "herdr-bindings.json"));
    expect(defaultBindingsPath({ MIMIR_DATA_DIR: "" })).toBe(
      path.join(os.homedir(), ".mimir", "herdr-bindings.json"),
    );
  });
});
