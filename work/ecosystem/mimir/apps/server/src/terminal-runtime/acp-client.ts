import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
type PermissionOption = { optionId: string; kind: string; name?: string };
type RecordValue = {
  [key: string]: unknown;
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  protocolVersion?: number;
  sessionId?: string;
  authMethods?: { id: string }[];
  stopReason?: string;
  result?: RecordValue;
  error?: { code: number; message: string };
  params?: {
    sessionId?: string;
    options?: PermissionOption[];
    toolCall?: { title?: string; toolCallId?: string };
    update?: { sessionUpdate?: string; content?: { type?: string; text?: string }; title?: string; toolCallId?: string; status?: string };
  };
};
type Permission = { id: string | number; options: PermissionOption[] };
/** A small ACP v1 client. It advertises no filesystem, terminal or authentication UI capabilities. */
export class AcpClient {
  private serial = 0;
  private buffer = "";
  private pending = new Map<
    number,
    {
      resolve: (value: RecordValue) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private permissions = new Map<string, Permission>();
  private sessionId: string | undefined;
  private active = false;
  private closed = false;
  constructor(
    private input: Writable,
    output: Readable,
    private callbacks: {
      output: (text: string) => void;
      state: (state: "running" | "waiting" | "blocked", reason: string) => void;
      failure: (error: Error) => void;
    },
    private timeoutMs = 1200000,
  ) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
        this.fail(new Error("ACP frame exceeds 1 MiB"));
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail(new Error("Invalid ACP message"));
        }
      }
    });
    output.once("end", () => this.fail(new Error("ACP connection closed")));
    output.once("error", (error) => this.fail(error));
    input.once("error", (error) => this.fail(error));
  }
  private send(value: RecordValue) {
    if (this.closed) throw Error("ACP connection is closed");
    this.input.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  }
  private request(
    method: string,
    params: RecordValue,
    timeout = this.timeoutMs,
  ): Promise<RecordValue> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`ACP ${method} timed out; not replayed`)),
        timeout,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }
  private receive(message: RecordValue) {
    if (this.closed) return;
    if (!message || message.jsonrpc !== "2.0" || Array.isArray(message))
      throw Error("Invalid envelope");
    if (typeof message.method !== "string") {
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(
            `ACP error ${message.error.code}: ${String(message.error.message).slice(0, 400)}`,
          ),
        );
      else if (message.result && typeof message.result === "object")
        pending.resolve(message.result);
      else pending.reject(new Error("Invalid ACP result"));
      return;
    }
    const params = message.params;
    if (
      message.method === "session/request_permission" &&
      (typeof message.id === "number" || typeof message.id === "string")
    ) {
      const options = params?.options;
      if (
        !this.active ||
        params?.sessionId !== this.sessionId ||
        !Array.isArray(options) ||
        options.length > 16 ||
        this.permissions.size >= 16
      ) {
        this.send({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      const choices = options.filter(
        (option) =>
          option &&
          typeof option.optionId === "string" &&
          option.optionId.length <= 256 &&
          ["allow_once", "reject_once"].includes(option.kind),
      );
      if (!choices.length) {
        this.send({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      const nonce = randomUUID();
      this.permissions.set(nonce, { id: message.id, options: choices });
      this.callbacks.state("waiting", "harness_permission_request");
      this.callbacks.output(
        `\nPermission requested: ${String(params?.toolCall?.title ?? params?.toolCall?.toolCallId ?? "tool operation").slice(0, 1000)}\n${choices.map((choice, index) => `${index + 1}: ${String(choice.name ?? choice.kind)} (${choice.kind})`).join("\n")}\nReply /permit ${nonce} <number>, or /cancel.\n`,
      );
      return;
    }
    if (message.method === "session/update" && params?.sessionId === this.sessionId) {
      const update = params?.update;
      if (
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string"
      )
        this.callbacks.output(update.content.text);
      if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate ?? ""))
        this.callbacks.output(
          `\n[tool] ${String(update?.title ?? update?.toolCallId ?? "operation").slice(0, 1000)}: ${String(update?.status ?? "pending")}\n`,
        );
      return;
    }
    if (message.id !== undefined)
      this.send({
        id: message.id,
        error: { code: -32601, message: "Client capability not supported" },
      });
  }
  async initialize(cwd: string, kind: string) {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "mimir", version: "0.1.0" },
      },
      15000,
    );
    if (result.protocolVersion !== 1) throw Error("Unsupported ACP protocol version");
    // Only validate existing credentials. Never initiate a browser/device login here.
    const methods = Array.isArray(result.authMethods)
      ? result.authMethods.map((m: RecordValue) => m.id)
      : [];
    const methodId =
      kind === "grok"
        ? methods.includes("cached_token")
          ? "cached_token"
          : process.env.XAI_API_KEY && methods.includes("xai.api_key")
            ? "xai.api_key"
            : undefined
        : undefined;
    if (methodId)
      await this.request("authenticate", { methodId, _meta: { headless: true } }, 15000);
    const session = await this.request("session/new", { cwd, mcpServers: [] }, 15000);
    if (
      typeof session.sessionId !== "string" ||
      !session.sessionId ||
      session.sessionId.length > 1024
    )
      throw Error("Missing ACP session identity");
    this.sessionId = session.sessionId;
  }
  async prompt(text: string) {
    if (!this.sessionId || this.active || this.closed)
      throw Error("ACP session is not ready for a prompt");
    if (!text.trim() || Buffer.byteLength(text) > 65536)
      throw Error("Prompt must contain 1–65536 bytes");
    this.active = true;
    this.callbacks.state("running", "harness_working");
    try {
      const result = await this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
      const waiting = ["end_turn", "cancelled", "refusal"].includes(result.stopReason ?? "");
      this.callbacks.state(
        waiting ? "waiting" : "blocked",
        waiting ? "harness_awaiting_input" : "harness_quota_wait",
      );
      this.callbacks.output(`\n[turn ended: ${String(result.stopReason ?? "unknown")}]\n`);
    } catch (error) {
      if (!this.closed) this.callbacks.state("blocked", "harness_quota_wait");
      throw error;
    } finally {
      this.active = false;
      this.cancelPermissions();
    }
  }
  async operatorInput(text: string) {
    if (text === "/cancel") {
      this.cancel();
      return;
    }
    if (text.startsWith("/permit ")) {
      const [, nonce, number] = text.trim().split(/\s+/);
      const permission = this.permissions.get(nonce ?? "");
      const index = Number(number) - 1;
      const choice = Number.isInteger(index) ? permission?.options[index] : undefined;
      if (!permission || !choice) throw Error("Permission selection is invalid or expired");
      this.permissions.delete(nonce!);
      this.send({
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: choice.optionId } },
      });
      if (!this.permissions.size) this.callbacks.state("running", "harness_working");
      return;
    }
    if (this.permissions.size)
      throw Error("Resolve the permission request or /cancel before sending a prompt");
    if (text.startsWith("/prompt ")) {
      const prompt = JSON.parse(text.slice(8));
      if (typeof prompt !== "string") throw Error("Invalid prompt envelope");
      await this.prompt(prompt);
    } else await this.prompt(text);
  }
  private cancelPermissions() {
    for (const permission of this.permissions.values()) {
      if (!this.closed)
        this.send({ id: permission.id, result: { outcome: { outcome: "cancelled" } } });
    }
    this.permissions.clear();
  }
  cancel() {
    this.cancelPermissions();
    if (this.sessionId && this.active && !this.closed)
      this.send({ method: "session/cancel", params: { sessionId: this.sessionId } });
  }
  close() {
    this.fail(new Error("ACP client closed"));
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.permissions.clear();
    this.callbacks.failure(error);
  }
}
