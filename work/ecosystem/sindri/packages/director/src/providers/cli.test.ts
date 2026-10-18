import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
