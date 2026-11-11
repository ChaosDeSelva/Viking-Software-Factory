import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { CliProvider } from "./cli.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function executable(source: string) {
  const root = mkdtempSync(join(tmpdir(), "director-cli-paths-"));
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
  responseSchema: z.object({ title: z.string() }),
};

it("keeps a character whose bytes arrive in two separate output chunks", async () => {
  // The CLI writes the JSON in two pieces with a pause between them; the split falls inside
  // the four bytes of one emoji, so each piece reaches the reader as its own chunk.
  const bin = executable(
    `const b=Buffer.from(JSON.stringify({structured_output:{title:'Export \\u{1F4C8} r\\u00e9sum\\u00e9'}}));` +
      `const i=b.indexOf(0xf0)+2; process.stdout.write(b.subarray(0,i));` +
      `setTimeout(()=>process.stdout.write(b.subarray(i)),200);`,
  );
  const result = await new CliProvider({ kind: "claude-cli", executable: bin }).complete(request);
  expect(result.parsed).toEqual({ title: "Export \u{1F4C8} résumé" });
});

it("runs the CLI named by SINDRI_CLAUDE_BIN or SINDRI_CODEX_BIN when none is configured", async () => {
  const claude = executable(`console.log(JSON.stringify({structured_output:{title:'claude'}}));`);
  const codex = executable(
    `const fs=require('node:fs'),a=process.argv;fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({title:'codex'}));`,
  );
  const saved = { c: process.env["SINDRI_CLAUDE_BIN"], x: process.env["SINDRI_CODEX_BIN"] };
  process.env["SINDRI_CLAUDE_BIN"] = claude;
  process.env["SINDRI_CODEX_BIN"] = codex;
  try {
    expect((await new CliProvider({ kind: "claude-cli" }).complete(request)).parsed).toEqual({
      title: "claude",
    });
    expect((await new CliProvider({ kind: "codex-cli" }).complete(request)).parsed).toEqual({
      title: "codex",
    });
  } finally {
    for (const [k, v] of [
      ["SINDRI_CLAUDE_BIN", saved.c],
      ["SINDRI_CODEX_BIN", saved.x],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

it("passes the model and names the workspace label in the prompt", async () => {
  const bin = executable(
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=process.argv;console.log(JSON.stringify({structured_output:{title:(a.includes('--model')?a[a.indexOf('--model')+1]:'none')+'|'+(s.includes('LABEL-XYZ')?'label':'no label')}}));});`,
  );
  const workspace = mkdtempSync(join(tmpdir(), "director-cli-paths-ws-"));
  roots.push(workspace);
  const named = await new CliProvider({
    kind: "claude-cli",
    executable: bin,
    model: "m-1",
  }).complete({ ...request, workspace, workspaceLabel: "LABEL-XYZ" });
  expect(named.parsed).toEqual({ title: "m-1|label" });
  const plain = await new CliProvider({
    kind: "claude-cli",
    executable: bin,
    model: "default",
  }).complete({ ...request, workspace });
  expect(plain.parsed).toEqual({ title: "none|no label" });
});

it("counts usage without cache fields and returns empty text without a result", async () => {
  const bin = executable(`console.log(JSON.stringify({usage:{input_tokens:5,output_tokens:1}}));`);
  const result = await new CliProvider({ kind: "claude-cli", executable: bin }).complete({
    system: "s",
    messages: [],
    maxTokens: 10,
    temperature: 0,
  });
  expect(result).toMatchObject({ text: "", usage: { inputTokens: 5, outputTokens: 1 } });
});

it("reports an exit status when the CLI quits before reading a large prompt", async () => {
  const bin = executable(`process.exit(5);`);
  const huge = { ...request, messages: [{ role: "user" as const, content: "x".repeat(4 << 20) }] };
  await expect(
    new CliProvider({ kind: "claude-cli", executable: bin }).complete(huge),
  ).rejects.toMatchObject({ code: "api_error", message: expect.stringMatching(/status 5/) });
});

it("keeps only the CLI's own string messages as the failure detail", async () => {
  const bin = executable(
    `console.log(JSON.stringify({is_error:true,subtype:'error_during_execution',errors:[{x:1}],result:{a:1}})); process.exit(1);`,
  );
  await expect(
    new CliProvider({ kind: "claude-cli", executable: bin }).complete(request),
  ).rejects.toMatchObject({ code: "api_error", detail: "error_during_execution" });
  const codex = executable(`console.log('null'); console.log('{"item":null}'); process.exit(1);`);
  const failure = await new CliProvider({ kind: "codex-cli", executable: codex })
    .complete(request)
    .catch((e: unknown) => e);
  expect(failure).toMatchObject({ code: "api_error" });
  expect((failure as { detail?: string }).detail).toBeUndefined();
});
