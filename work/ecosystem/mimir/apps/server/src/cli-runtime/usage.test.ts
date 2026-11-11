import { describe, expect, it } from "vitest";
import { usageOfEvent } from "./adapter.js";

/**
 * Streams shaped like the ones recorded live (session.output of msn_01M74CYMZ4FZWCXBHHWFMK3ZPA
 * and msn_01M74CYRSF0T80VXTEXF0W238N), usage numbers verbatim, message text elided.
 */
const codexSession = (usage: Record<string, number>) => [
  { type: "thread.started", thread_id: "01a1c8cf-87ca-7123-8b84-44e0e2f08a24" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "…" } },
  { type: "item.started", item: { id: "item_1", type: "command_execution", command: "npm test" } },
  { type: "turn.completed", usage },
];
const claudeSession = (usage: Record<string, unknown>, cost: number) => [
  { type: "system", subtype: "init" },
  {
    type: "assistant",
    message: {
      id: "msg_011CgvVe6toT6fGspHgEh5XQ",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 5525,
        cache_read_input_tokens: 17022,
        output_tokens: 16,
      },
    },
  },
  { type: "user", message: { content: [] } },
  { type: "rate_limit_event" },
  { type: "result", subtype: "success", num_turns: 8, total_cost_usd: cost, usage },
];

/** What the runtime records for a session: the last usage event of its stdout. */
function sessionUsage(events: readonly object[]) {
  let last = null;
  for (const line of [
    "plain terminal text",
    ...events.map((e) => JSON.stringify(e)),
    "{not json",
  ]) {
    last = usageOfEvent(line) ?? last;
  }
  return last;
}

describe("usage of a Codex `exec --json` session", () => {
  it("counts fresh input and output; cached input is reported apart", () => {
    expect(
      sessionUsage(
        codexSession({
          input_tokens: 259194,
          cached_input_tokens: 235520,
          cache_write_input_tokens: 0,
          output_tokens: 3699,
          reasoning_output_tokens: 301,
        }),
      ),
    ).toEqual({ tokens: 259194 - 235520 + 3699, cachedTokens: 235520, estimatedCost: null });
  });

  it("recomputes the live implementer crew: 900,215 before, 86,775 now", () => {
    const sessions = [
      [259194, 235520, 3699],
      [253861, 229888, 4346],
      [374646, 348032, 4469],
    ].map(([input, cached, output]) =>
      sessionUsage(
        codexSession({
          input_tokens: input!,
          cached_input_tokens: cached!,
          cache_write_input_tokens: 0,
          output_tokens: output!,
          reasoning_output_tokens: 0,
        }),
      ),
    );
    expect(sessions.reduce((n, u) => n + u!.tokens, 0)).toBe(86_775);
    expect(sessions.reduce((n, u) => n + u!.cachedTokens, 0)).toBe(813_440);
  });

  it("keeps the last running total of a multi-turn thread instead of summing turns", () => {
    const turns = [
      { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 },
      { input_tokens: 2500, cached_input_tokens: 1900, output_tokens: 120 },
    ].map((usage) => ({ type: "turn.completed", usage }));
    expect(sessionUsage(turns)).toEqual({
      tokens: 2500 - 1900 + 120,
      cachedTokens: 1900,
      estimatedCost: null,
    });
  });

  it("never counts negative fresh input when cached exceeds input", () => {
    expect(
      usageOfEvent(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 15, output_tokens: 1 },
        }),
      ),
    ).toEqual({ tokens: 1, cachedTokens: 10, estimatedCost: null });
  });
});

describe("usage of a Claude `stream-json` session", () => {
  it("counts input, cache writes and output; cache reads are reported apart", () => {
    expect(
      sessionUsage(
        claudeSession(
          {
            input_tokens: 24,
            cache_creation_input_tokens: 12949,
            cache_read_input_tokens: 320647,
            output_tokens: 5059,
            output_tokens_details: { thinking_tokens: 175 },
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
          },
          0.2689974,
        ),
      ),
    ).toEqual({ tokens: 24 + 12949 + 5059, cachedTokens: 320647, estimatedCost: 0.2689974 });
  });

  it("ignores per-message usage nested in assistant events (the result is the total)", () => {
    expect(sessionUsage(claudeSession({ input_tokens: 0, output_tokens: 0 }, 0))).toMatchObject({
      tokens: 0,
      cachedTokens: 0,
    });
  });
});

it("ignores events without a usable usage", () => {
  for (const line of [
    "",
    "null",
    "42",
    JSON.stringify({ type: "turn.completed" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: -1, output_tokens: 2 } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: "1", output_tokens: 2 } }),
    JSON.stringify({ type: "item.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
  ])
    expect(usageOfEvent(line)).toBeNull();
});
