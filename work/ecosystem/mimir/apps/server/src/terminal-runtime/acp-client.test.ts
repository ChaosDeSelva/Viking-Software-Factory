import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { AcpClient } from "./acp-client.js";
const clients: AcpClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(timeout = 1000) {
  const input = new PassThrough(),
    output = new PassThrough();
  const sent: ReturnType<typeof JSON.parse>[] = [],
    text: string[] = [],
    states: string[] = [],
    failures: Error[] = [];
  input.on("data", (part) => {
    for (const row of part.toString().trim().split("\n")) sent.push(JSON.parse(row));
  });
  const client = new AcpClient(
    input,
    output,
    { output: (s) => text.push(s), state: (s) => states.push(s), failure: (e) => failures.push(e) },
    timeout,
  );
  clients.push(client);
  const reply = (value: object) =>
    output.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const initialize = async () => {
    const ready = client.initialize("/task", "kimi");
    expect(sent[0].params.clientCapabilities).toEqual({});
    reply({ id: sent.at(-1).id, result: { protocolVersion: 1 } });
    await flush();
    reply({ id: sent.at(-1).id, result: { sessionId: "owned" } });
    await ready;
  };
  return { client, input, output, sent, text, states, failures, reply, initialize };
}
it("negotiates ACP, preserves multiline prompts and uses response boundaries rather than tool completion", async () => {
  const f = fixture();
  await f.initialize();
  const turn = f.client.operatorInput('/prompt "first\\nsecond"');
  expect(f.sent.at(-1).params.prompt[0].text).toBe("first\nsecond");
  const id = f.sent.at(-1).id;
  f.reply({
    method: "session/update",
    params: {
      sessionId: "owned",
      update: { sessionUpdate: "tool_call_update", status: "completed", toolCallId: "tool" },
    },
  });
  expect(f.states.at(-1)).toBe("running");
  f.reply({
    method: "session/update",
    params: {
      sessionId: "foreign",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreign" } },
    },
  });
  expect(f.text.join("")).not.toContain("foreign");
  f.reply({ id, result: { stopReason: "end_turn" } });
  await turn;
  expect(f.states.at(-1)).toBe("waiting");
});
it("requires an exact live operator choice, never grants persistent permission, and expires choices", async () => {
  const f = fixture();
  await f.initialize();
  const turn = f.client.prompt("build");
  const id = f.sent.at(-1).id;
  f.reply({
    id: "permission",
    method: "session/request_permission",
    params: {
      sessionId: "owned",
      toolCall: { title: "Write file" },
      options: [
        { optionId: "forever", kind: "allow_always", name: "Always" },
        { optionId: "once", kind: "allow_once", name: "Once" },
        { optionId: "no", kind: "reject_once", name: "No" },
      ],
    },
  });
  expect(f.states.at(-1)).toBe("waiting");
  expect(f.sent.filter((m) => m.id === "permission")).toHaveLength(0);
  expect(f.text.join("")).not.toContain("Always");
  await expect(f.client.operatorInput("yes")).rejects.toThrow("Resolve");
  await expect(f.client.operatorInput("/permit wrong 1")).rejects.toThrow("expired");
  const nonce = f.text.join("").match(/\/permit ([\w-]+)/)![1];
  await f.client.operatorInput(`/permit ${nonce} 1`);
  expect(f.sent.at(-1).result.outcome).toEqual({ outcome: "selected", optionId: "once" });
  await expect(f.client.operatorInput(`/permit ${nonce} 1`)).rejects.toThrow("expired");
  f.reply({ id, result: { stopReason: "end_turn" } });
  await turn;
});
it("cancels pending permissions and waits for cancellation acknowledgment", async () => {
  const f = fixture();
  await f.initialize();
  const turn = f.client.prompt("build");
  const id = f.sent.at(-1).id;
  f.reply({
    id: 900,
    method: "session/request_permission",
    params: { sessionId: "owned", options: [{ optionId: "yes", kind: "allow_once" }] },
  });
  f.client.cancel();
  expect(f.sent.find((m) => m.id === 900).result.outcome.outcome).toBe("cancelled");
  expect(f.sent.at(-1).method).toBe("session/cancel");
  f.reply({ id, result: { stopReason: "cancelled" } });
  await turn;
  expect(f.states.at(-1)).toBe("waiting");
});
it("rejects foreign permissions and unadvertised filesystem capabilities", async () => {
  const f = fixture();
  await f.initialize();
  f.reply({
    id: 7,
    method: "session/request_permission",
    params: { sessionId: "foreign", options: [{ optionId: "yes", kind: "allow_once" }] },
  });
  expect(f.sent.at(-1).result.outcome.outcome).toBe("cancelled");
  f.reply({ id: 8, method: "fs/write_text_file", params: { path: "/sensitive", content: "bad" } });
  expect(f.sent.at(-1).error.code).toBe(-32601);
});
it("never retries an uncertain turn and closes malformed connections", async () => {
  const f = fixture(10);
  await f.initialize();
  await expect(f.client.prompt("one execution")).rejects.toThrow("timed out");
  expect(f.sent.filter((m) => m.method === "session/prompt")).toHaveLength(1);
  await expect(f.client.prompt("retry")).rejects.toThrow("not ready");
  const broken = fixture();
  const ready = broken.client.initialize("/task", "kimi");
  broken.output.write("bad JSON\n");
  await expect(ready).rejects.toThrow("Invalid ACP");
});
it("does not claim idle after an unknown stop reason or accept overlapping turns", async () => {
  const f = fixture();
  await f.initialize();
  const turn = f.client.prompt("first");
  const id = f.sent.at(-1).id;
  await expect(f.client.prompt("second")).rejects.toThrow("not ready");
  f.reply({ id, result: { stopReason: "future_reason" } });
  await turn;
  expect(f.states.at(-1)).toBe("blocked");
});
it("rejects a handshake step instead of hanging when the connection closed between steps", async () => {
  const f = fixture(60000);
  const ready = f.client.initialize("/task", "kimi");
  // One chunk answers initialize and then breaks the connection before session/new is sent.
  f.output.write(
    JSON.stringify({ jsonrpc: "2.0", id: f.sent.at(-1).id, result: { protocolVersion: 1 } }) +
      "\nnot JSON\n",
  );
  const outcome = await Promise.race([
    ready.then(
      () => "resolved",
      (error: Error) => error.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 200)),
  ]);
  expect(outcome).toBe("ACP connection is closed");
  expect(f.failures.map((error) => error.message)).toEqual(["Invalid ACP message"]);
  expect(f.sent.map((message) => message.method)).toEqual(["initialize"]);
});
it("fails closed on an oversized frame and on broken streams", async () => {
  const big = fixture();
  const ready = big.client.initialize("/task", "kimi");
  big.output.write("x".repeat(1024 * 1024 + 1));
  await expect(ready).rejects.toThrow("ACP frame exceeds 1 MiB");
  for (const side of ["input", "output"] as const) {
    const f = fixture();
    f[side].emit("error", new Error(`${side} broke`));
    expect(f.failures.map((error) => error.message)).toEqual([`${side} broke`]);
    await expect(f.client.prompt("late")).rejects.toThrow("not ready");
  }
});
it("rejects malformed envelopes and results without trusting stray responses", async () => {
  const f = fixture();
  await f.initialize();
  const turn = f.client.prompt("one");
  const id = f.sent.at(-1).id;
  // Blank lines, responses to unknown or non-numeric ids and notifications for no one are ignored.
  f.output.write("\n   \n");
  f.reply({ id: String(id), result: { stopReason: "end_turn" } });
  f.reply({ id: id + 100, result: { stopReason: "end_turn" } });
  f.reply({ method: "session/unknown_notification", params: {} });
  expect(f.sent.at(-1).method).toBe("session/prompt");
  f.reply({ id, error: { code: -32000, message: "y".repeat(1000) } });
  const error = await turn.catch((rejection: Error) => rejection);
  expect((error as Error).message).toBe(`ACP error -32000: ${"y".repeat(400)}`);
  expect(f.states.at(-1)).toBe("blocked");
  const second = f.client.prompt("two");
  f.reply({ id: f.sent.at(-1).id, result: "not an object" });
  await expect(second).rejects.toThrow("Invalid ACP result");
  const third = f.client.prompt("three");
  f.output.write(JSON.stringify({ jsonrpc: "1.0", id: f.sent.at(-1).id, result: {} }) + "\n");
  await expect(third).rejects.toThrow("Invalid ACP message");
  // Once closed, nothing the agent sends is answered.
  const count = f.sent.length;
  f.reply({ id: 5, method: "fs/read_text_file", params: {} });
  expect(f.sent).toHaveLength(count);
});
it("reports a turn without a stop reason as blocked rather than idle", async () => {
  const f = fixture();
  await f.initialize();
  const turn = f.client.prompt("one");
  f.reply({ id: f.sent.at(-1).id, result: {} });
  await turn;
  expect(f.states.at(-1)).toBe("blocked");
  expect(f.text.at(-1)).toBe("\n[turn ended: unknown]\n");
});
it("does not report a quota wait when the client itself closes during a turn", async () => {
  const f = fixture();
  await f.initialize();
  const turn = f.client.prompt("one");
  f.client.close();
  await expect(turn).rejects.toThrow("ACP client closed");
  expect(f.states).toEqual(["running"]);
});
it.each([
  [
    "a session that is not owned",
    { sessionId: "other", options: [{ optionId: "yes", kind: "allow_once" }] },
  ],
  ["no usable options", { options: [{ optionId: "always", kind: "allow_always" }, null] }],
  ["more than 16 options", { options: Array(17).fill({ optionId: "yes", kind: "allow_once" }) }],
  ["an overlong option id", { options: [{ optionId: "x".repeat(257), kind: "allow_once" }] }],
  ["no options at all", { options: "allow_once" }],
])("cancels a permission request with %s", async (_name, params) => {
  const f = fixture();
  await f.initialize();
  const turn = f.client.prompt("build");
  const id = f.sent.at(-1).id;
  f.reply({
    id: "ask",
    method: "session/request_permission",
    params: {
      sessionId: "owned",
      ...params,
    },
  });
  expect(f.sent.at(-1)).toMatchObject({ id: "ask", result: { outcome: { outcome: "cancelled" } } });
  expect(f.states.at(-1)).toBe("running");
  f.reply({ id, result: { stopReason: "end_turn" } });
  await turn;
});
it("cancels permission requests outside a turn and beyond 16 open requests", async () => {
  const f = fixture();
  await f.initialize();
  const option = { optionId: "yes", kind: "allow_once" };
  f.reply({
    id: 1,
    method: "session/request_permission",
    params: { sessionId: "owned", options: [option] },
  });
  expect(f.sent.at(-1)).toMatchObject({ id: 1, result: { outcome: { outcome: "cancelled" } } });
  const turn = f.client.prompt("build");
  const id = f.sent.at(-1).id;
  for (let n = 0; n < 17; n++)
    f.reply({
      id: `p${n}`,
      method: "session/request_permission",
      params: { sessionId: "owned", options: [option] },
    });
  expect(f.sent.filter((m) => typeof m.id === "string" && m.id.startsWith("p"))).toEqual([
    { jsonrpc: "2.0", id: "p16", result: { outcome: { outcome: "cancelled" } } },
  ]);
  f.reply({ id, result: { stopReason: "end_turn" } });
  await turn;
  // Ending the turn withdraws every open request.
  expect(f.sent.filter((m) => typeof m.id === "string" && m.id.startsWith("p"))).toHaveLength(17);
});
it("shows fallback labels and keeps waiting while another permission is open", async () => {
  const f = fixture();
  await f.initialize();
  const turn = f.client.prompt("build");
  const id = f.sent.at(-1).id;
  f.reply({
    method: "session/update",
    params: { sessionId: "owned", update: { sessionUpdate: "tool_call" } },
  });
  f.reply({
    method: "session/update",
    params: {
      sessionId: "owned",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "image" } },
    },
  });
  f.reply({ method: "session/update", params: { sessionId: "owned" } });
  expect(f.text).toEqual(["\n[tool] operation: pending\n"]);
  for (const [request, toolCall] of [
    [41, { toolCallId: "call-7" }],
    [42, undefined],
  ] as const)
    f.reply({
      id: request,
      method: "session/request_permission",
      params: { sessionId: "owned", toolCall, options: [{ optionId: "ok", kind: "allow_once" }] },
    });
  const shown = f.text.join("");
  expect(shown).toContain("Permission requested: call-7\n1: allow_once (allow_once)");
  expect(shown).toContain("Permission requested: tool operation\n");
  const [first, second] = [...shown.matchAll(/\/permit ([\w-]+)/g)].map((match) => match[1]);
  await expect(f.client.operatorInput(`/permit ${first} 1.5`)).rejects.toThrow("expired");
  await expect(f.client.operatorInput("/permit ")).rejects.toThrow("expired");
  await expect(f.client.operatorInput(`/permit ${first} 2`)).rejects.toThrow("expired");
  await f.client.operatorInput(`/permit ${first} 1`);
  expect(f.states.at(-1)).toBe("waiting");
  await f.client.operatorInput(`/permit ${second} 1`);
  expect(f.states.at(-1)).toBe("running");
  await f.client.operatorInput("/cancel");
  expect(f.sent.at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: "owned" } });
  f.reply({ id, result: { stopReason: "cancelled" } });
  await turn;
  // Outside a turn, /cancel has nothing to cancel.
  const count = f.sent.length;
  await f.client.operatorInput("/cancel");
  expect(f.sent).toHaveLength(count);
  await expect(f.client.operatorInput("/prompt 5")).rejects.toThrow("Invalid prompt envelope");
  await expect(f.client.operatorInput("x".repeat(65537))).rejects.toThrow("1–65536 bytes");
});
it.each([
  ["a cached Grok token", "grok", ["cached_token", "xai.api_key"], "key", "cached_token"],
  ["an existing xAI API key", "grok", ["xai.api_key"], "key", "xai.api_key"],
  ["no usable credential", "grok", ["xai.api_key"], undefined, undefined],
  ["a non-Grok agent", "kimi", ["cached_token"], "key", undefined],
] as const)(
  "authenticates headlessly only with %s",
  async (_name, kind, methods, key, expected) => {
    const prior = process.env.XAI_API_KEY;
    if (key === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = key;
    try {
      const f = fixture();
      const ready = f.client.initialize("/task", kind);
      f.reply({
        id: f.sent.at(-1).id,
        result: { protocolVersion: 1, authMethods: methods.map((id) => ({ id })) },
      });
      await flush();
      if (expected) {
        expect(f.sent.at(-1)).toMatchObject({
          method: "authenticate",
          params: { methodId: expected, _meta: { headless: true } },
        });
        f.reply({ id: f.sent.at(-1).id, result: {} });
        await flush();
      }
      expect(f.sent.at(-1)).toMatchObject({
        method: "session/new",
        params: { cwd: "/task", mcpServers: [] },
      });
      expect(f.sent.filter((m) => m.method === "authenticate")).toHaveLength(expected ? 1 : 0);
      f.reply({ id: f.sent.at(-1).id, result: { sessionId: "owned" } });
      await ready;
    } finally {
      if (prior === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prior;
    }
  },
);
it.each([
  ["no session id", {}],
  ["an empty session id", { sessionId: "" }],
  ["an overlong session id", { sessionId: "s".repeat(1025) }],
])("refuses a session with %s", async (_name, result) => {
  const f = fixture();
  const ready = f.client.initialize("/task", "grok");
  f.reply({ id: f.sent.at(-1).id, result: { protocolVersion: 1, authMethods: "none" } });
  await flush();
  f.reply({ id: f.sent.at(-1).id, result });
  await expect(ready).rejects.toThrow("Missing ACP session identity");
  await expect(f.client.prompt("never")).rejects.toThrow("not ready");
});
