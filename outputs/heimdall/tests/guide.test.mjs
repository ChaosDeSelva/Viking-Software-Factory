import test from "node:test";
import assert from "node:assert/strict";
import { setup, send } from "./support.mjs";

const answer = {
  answer: "One task is escalated. Open Reviews in Sindri to decide it.",
  links: [{ label: "Open Reviews", href: "#/reviews?project=prj_demo" }],
  sources: ["state"],
};

/** The fixture answers the Guide route as the test says and records what reached it. */
function guide(source, respond) {
  const seen = [];
  source.intercept = (req, res, body) => {
    if (req.url !== "/v1/guide/ask") return false;
    seen.push({ body: JSON.parse(body), headers: req.headers });
    const [status, value] = respond();
    send(res, status, value, { "content-type": "application/json" });
    return true;
  };
  return seen;
}

test("the Guide is a read through Heimdall's session, forwarded with the stored Sindri token", async (t) => {
  const { source, call, signIn } = await setup(t);
  const seen = guide(source, () => [200, answer]);
  const question = {
    question: "Why is my run waiting?",
    context: { app: "heimdall", projectId: "prj_demo" },
  };
  assert.equal((await call("details/guide/ask", question)).status, 401);
  assert.equal(seen.length, 0);
  await signIn();
  // A read session is enough: no operator unlock, no idempotency key.
  const res = await call("details/guide/ask", question);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), answer);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].body, question);
  assert.equal(seen[0].headers.authorization, "Bearer fixture-token");
  assert.equal(seen[0].headers["idempotency-key"], undefined);
  // GET is not the Guide.
  assert.equal((await call("details/guide/ask")).status, 404);
});

test("the Guide passes Sindri's refusals through and needs the same-origin header", async (t) => {
  const { source, call, signIn } = await setup(t);
  let reply = [
    429,
    {
      error: {
        code: "rate_limited",
        message: "too many Guide questions; retry in 30 s",
      },
    },
  ];
  guide(source, () => reply);
  await signIn();
  const limited = await call("details/guide/ask", { question: "Again?" });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).message, /too many Guide questions/);
  reply = [
    503,
    {
      error: {
        code: "provider_unavailable",
        message: "The Guide could not get an answer",
      },
    },
  ];
  const down = await call("details/guide/ask", { question: "Again?" });
  assert.equal(down.status, 503);
  assert.match((await down.json()).message, /could not get an answer/);
  assert.equal(
    (
      await call(
        "details/guide/ask",
        { question: "x" },
        { "x-heimdall-request": "0" },
      )
    ).status,
    403,
  );
});

test("the Guide answers 503 when Sindri is not connected", async (t) => {
  const { call, signIn } = await setup(t, { sources: ["mimir"] });
  await signIn();
  const res = await call("details/guide/ask", { question: "What now?" });
  assert.equal(res.status, 503);
});

test("each signed-in session asks with its own client ID, so operators do not share Sindri's rate limit", async (t) => {
  const { source, call, signIn } = await setup(t);
  const seen = guide(source, () => [200, answer]);
  const first = await signIn();
  await call("details/guide/ask", { question: "One?" });
  await call("details/guide/ask", { question: "Two?" });
  const second = await signIn();
  await call("details/guide/ask", { question: "Three?" });
  const ids = seen.map((s) => s.headers["x-guide-client"]);
  for (const id of ids) assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(ids[0], ids[1], "stable within a session");
  assert.notEqual(ids[1], ids[2], "distinct across sessions");
  // A hash, never the session cookie itself.
  for (const cookie of [first, second])
    assert.ok(!ids.includes(cookie.split("=")[1]));
});
