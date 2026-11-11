import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { CliProvider } from "./cli.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function executable(source: string) {
  const root = mkdtempSync(join(tmpdir(), "director-cli-test-"));
  roots.push(root);
  const path = join(root, "fixture.cjs");
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return path;
}
const request = {
  system: "Plan",
  messages: [{ role: "user" as const, content: "Hello" }],
  maxTokens: 100,
  temperature: 0,
  responseSchema: z.object({ ready: z.boolean() }),
};

it("validates Codex structured output and records measured usage", async () => {
  const bin = executable(
    `const fs=require('node:fs'); const a=process.argv; const schema=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1])); if(!schema.$schema.includes('draft-07'))process.exit(2); fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({ready:true})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}}));`,
  );
  const result = await new CliProvider({ kind: "codex-cli", executable: bin }).complete(request);
  expect(result.parsed).toEqual({ ready: true });
  expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
});

it("validates Claude structured output and counts cached input usage", async () => {
  const bin = executable(
    `console.log(JSON.stringify({structured_output:{ready:true},usage:{input_tokens:2,cache_read_input_tokens:10,cache_creation_input_tokens:3,output_tokens:4}}));`,
  );
  const result = await new CliProvider({ kind: "claude-cli", executable: bin }).complete(request);
  expect(result.parsed).toEqual({ ready: true });
  expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 4 });
});

it("rejects malformed structured results instead of treating the process exit as success", async () => {
  const bin = executable(`console.log(JSON.stringify({structured_output:{ready:'wrong'}}));`);
  await expect(
    new CliProvider({ kind: "claude-cli", executable: bin }).complete(request),
  ).rejects.toMatchObject({ code: "invalid_output" });
});

it("times out hung providers and reports unavailable executables", async () => {
  const bin = executable(`setInterval(()=>{},1000);`);
  await expect(
    new CliProvider({ kind: "claude-cli", executable: bin, timeoutMs: 100 }).complete(request),
  ).rejects.toThrow(/time limit/);
  await expect(
    new CliProvider({ kind: "claude-cli", executable: `${bin}-missing` }).complete(request),
  ).rejects.toMatchObject({ code: "provider_unavailable" });
});

it("preserves ordinary text responses and does not invent missing usage", async () => {
  const bin = executable(`console.log(JSON.stringify({result:'A plain answer'}));`);
  const plain = {
    system: request.system,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
  };
  const result = await new CliProvider({
    kind: "claude-cli",
    executable: bin,
    model: "chosen-model",
  }).complete(plain);
  expect(result).toMatchObject({ text: "A plain answer", usage: null, model: "chosen-model" });
  expect(result.parsed).toBeUndefined();
});

it("handles CLI errors without exposing stderr content", async () => {
  const bin = executable(`process.stderr.write('private diagnostic');process.exitCode=7;`);
  await expect(
    new CliProvider({ kind: "claude-cli", executable: bin }).complete(request),
  ).rejects.toThrow(/status 7/);
  const failed = executable(
    `console.log(JSON.stringify({is_error:true,result:'private diagnostic'}));`,
  );
  await expect(
    new CliProvider({ kind: "claude-cli", executable: failed }).complete(request),
  ).rejects.toMatchObject({ code: "api_error" });
});

it("rejects excessive output and malformed JSON", async () => {
  const large = executable(
    `process.stdout.write('x'.repeat(9*1024*1024));setInterval(()=>{},1000);`,
  );
  await expect(
    new CliProvider({ kind: "claude-cli", executable: large }).complete(request),
  ).rejects.toThrow(/output limit/);
  const malformed = executable(`console.log('not JSON');`);
  await expect(
    new CliProvider({ kind: "claude-cli", executable: malformed }).complete(request),
  ).rejects.toMatchObject({ code: "invalid_output" });
});

it("reads Codex output without a schema and ignores non-event progress", async () => {
  const bin = executable(
    `const fs=require('node:fs'),a=process.argv;fs.writeFileSync(a[a.indexOf('--output-last-message')+1],'plain');console.log('progress');console.log(JSON.stringify({type:'item.completed'}));`,
  );
  const result = await new CliProvider({ kind: "codex-cli", executable: bin }).complete({
    system: "Explain",
    messages: [],
    temperature: 0,
    maxTokens: 20,
  });
  expect(result.text).toBe("plain");
  expect(result.usage).toBeNull();
});

it("gives Claude read-only tools and the repository as cwd only when a workspace is named", async () => {
  const bin = executable(
    `const a=process.argv; console.log(JSON.stringify({structured_output:{ready:true},result:JSON.stringify({cwd:process.cwd(),tools:a[a.indexOf('--tools')+1],allowed:a.includes('--allowedTools')?a[a.indexOf('--allowedTools')+1]:null,settings:a.includes('--settings')?a[a.indexOf('--settings')+1]:null})}));`,
  );
  const workspace = mkdtempSync(join(tmpdir(), "director-cli-workspace-"));
  roots.push(workspace);
  const provider = new CliProvider({ kind: "claude-cli", executable: bin });
  const seen = (r: { text: string }) =>
    JSON.parse(r.text) as {
      cwd: string;
      tools: string;
      allowed: string | null;
      settings: string | null;
    };

  const grounded = seen(await provider.complete({ ...request, workspace }));
  expect(realpathSync(grounded.cwd)).toBe(realpathSync(workspace));
  expect(grounded.tools).toBe("Read,Grep,Glob");
  expect(grounded.allowed).toBeNull();
  const deny = JSON.parse(grounded.settings!).permissions.deny as string[];
  for (const rule of ["Read(./**/.env*)", "Read(./.npmrc)", "Read(./**/*credentials*)"])
    expect(deny).toContain(rule);

  for (const req of [request, { ...request, workspace: join(workspace, "missing") }]) {
    const isolated = seen(await provider.complete(req));
    expect(isolated.tools).toBe("");
    expect(isolated.allowed).toBeNull();
    expect(isolated.cwd).toContain("sindri-director-");
  }
});

it("keeps a Codex planner on the supplied context: it gets no workspace to read", async () => {
  const bin = executable(
    `const fs=require('node:fs'); const a=process.argv; fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({ready:true,cwd:process.cwd()}));`,
  );
  const workspace = mkdtempSync(join(tmpdir(), "director-cli-workspace-"));
  roots.push(workspace);
  const result = await new CliProvider({ kind: "codex-cli", executable: bin }).complete({
    system: "Plan",
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 100,
    temperature: 0,
    workspace,
  });
  expect((JSON.parse(result.text) as { cwd: string }).cwd).toContain("sindri-director-");
});

it("says why a CLI failed: not signed in, rate limited, timed out, or the CLI's own words", async () => {
  const claude = (source: string, timeoutMs?: number) =>
    new CliProvider({
      kind: "claude-cli",
      executable: executable(source),
      ...(timeoutMs ? { timeoutMs } : {}),
    })
      .complete(request)
      .catch((e: unknown) => e);

  expect(
    await claude(`console.error('Invalid API key · Please run /login'); process.exit(1);`),
  ).toMatchObject({ code: "auth", detail: "Invalid API key · Please run /login" });
  // The Claude CLI reports errors as a JSON result, with or without a failing exit status.
  expect(
    await claude(
      `console.log(JSON.stringify({is_error:true,result:'OAuth token has expired. Please run /login'})); process.exit(1);`,
    ),
  ).toMatchObject({ code: "auth", detail: "OAuth token has expired. Please run /login" });
  expect(
    await claude(
      `console.log(JSON.stringify({is_error:true,api_error_status:429,terminal_reason:'api_error',result:'API Error: Request rejected (429)'}));`,
    ),
  ).toMatchObject({ code: "rate_limited", detail: "API Error: Request rejected (429)" });
  // What the installed CLI (2.1.x) prints for a rejected key: the status decides, not the words.
  expect(
    await claude(
      `console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,api_error_status:401,terminal_reason:'api_error',result:'Invalid API key · Fix external API key'})); process.exit(1);`,
    ),
  ).toMatchObject({ code: "auth", detail: "Invalid API key · Fix external API key" });
  expect(await claude(`setInterval(()=>{},1000);`, 100)).toMatchObject({
    code: "timeout",
    message: expect.stringMatching(/time limit/),
  });

  const secret = "sk-ant-api03-" + "Z9y8X7w6V5u4T3s2R1q0".repeat(4);
  const other = (await claude(
    `console.error('x'.repeat(5000) + ' model not found: opus-9 key ${secret}'); process.exit(3);`,
  )) as { code: string; message: string; detail: string };
  expect(other.code).toBe("api_error");
  expect(other.message).toMatch(/exited with status 3/);
  expect(other.detail).toContain("model not found: opus-9");
  expect(other.detail).not.toContain(secret);
  expect(other.detail.length).toBeLessThanOrEqual(600);
}, 30_000);

it("classifies a CLI failure from what the CLI reports, never from the prompt or the model's answer", async () => {
  const run = (kind: "claude-cli" | "codex-cli", source: string) =>
    new CliProvider({ kind, executable: executable(source) })
      .complete(request)
      .catch((e: unknown) => e) as Promise<{ code: string; detail?: string }>;
  // A ticket about rate limiting and sign-in, echoed by the model, that fails for another reason.
  const answer =
    "I will add rate limiting to the login endpoint: check credentials, sign in, authentication, 401, 429, quota";

  const maxTurns = await run(
    "claude-cli",
    `console.log(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true,errors:['Reached maximum number of turns (1)'],result:${JSON.stringify(answer)}})); process.exit(1);`,
  );
  expect(maxTurns).toMatchObject({
    code: "api_error",
    detail: "Reached maximum number of turns (1)",
  });
  // An error result that names no cause says nothing rather than quoting the answer.
  const unnamed = await run(
    "claude-cli",
    `console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:${JSON.stringify(answer)}}));`,
  );
  expect(unnamed.code).toBe("api_error");
  expect(unnamed.detail).toBeUndefined();
  const subtypeOnly = await run(
    "claude-cli",
    `console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:${JSON.stringify(answer)}}));`,
  );
  expect(subtypeOnly).toMatchObject({ code: "api_error", detail: "error_during_execution" });

  // Codex: only its error events count, not the agent's messages or other output.
  const message = `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(answer)}}}));`;
  const codexOther = await run(
    "codex-cli",
    `${message} console.log(JSON.stringify({type:'error',message:'model not found: gpt-9'})); console.log(JSON.stringify({type:'turn.failed',error:{message:'model not found: gpt-9'}})); process.exit(1);`,
  );
  expect(codexOther).toMatchObject({ code: "api_error", detail: "model not found: gpt-9" });
  const codexSilent = await run("codex-cli", `${message} process.exit(1);`);
  expect(codexSilent.code).toBe("api_error");
  expect(codexSilent.detail).toBeUndefined();
  expect(
    await run(
      "codex-cli",
      `${message} console.log(JSON.stringify({type:'turn.failed',error:{message:'exceeded retry limit, last status: 429 Too Many Requests'}})); process.exit(1);`,
    ),
  ).toMatchObject({ code: "rate_limited", detail: expect.stringContaining("429 Too Many") });
  expect(
    await run("codex-cli", `console.error('Not logged in. Run codex login'); process.exit(1);`),
  ).toMatchObject({ code: "auth" });
}, 30_000);

it("keeps the measured usage when the structured output fails validation", async () => {
  const claude = executable(
    `console.log(JSON.stringify({structured_output:{ready:'wrong'},usage:{input_tokens:20,output_tokens:5}}));`,
  );
  await expect(
    new CliProvider({ kind: "claude-cli", executable: claude, model: "m" }).complete(request),
  ).rejects.toMatchObject({
    code: "invalid_output",
    usage: { inputTokens: 20, outputTokens: 5 },
    model: "m",
  });
  const codex = executable(
    `const fs=require('node:fs'); const a=process.argv; fs.writeFileSync(a[a.indexOf('--output-last-message')+1],'not json'); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:2}}));`,
  );
  await expect(
    new CliProvider({ kind: "codex-cli", executable: codex }).complete(request),
  ).rejects.toMatchObject({ code: "invalid_output", usage: { inputTokens: 7, outputTokens: 2 } });
});
