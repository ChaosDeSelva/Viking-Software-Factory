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
