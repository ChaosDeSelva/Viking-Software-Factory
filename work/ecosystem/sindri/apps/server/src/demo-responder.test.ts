import type { CompleteRequest } from "@sindri/director";
import { describe, expect, it } from "vitest";
import { contextIdsOf, demoResponder } from "./demo-responder.js";

const req = (content: string, purpose = "draft_spec"): CompleteRequest => ({
  system: "s",
  messages: [{ role: "user", content }],
  maxTokens: 10,
  temperature: 0,
  metadata: { purpose },
});

describe("demoResponder", () => {
  it("reads context ids from plain and nonce-suffixed untrusted_data blocks", () => {
    const text = [
      '<untrusted_data id="intake:a" kind="intake">\nx\n</untrusted_data>',
      '<untrusted_data_9f3k id="chunk:7" kind="chunk">\ny\n</untrusted_data_9f3k>',
    ].join("\n");
    expect(contextIdsOf(req(text))).toEqual(["intake:a", "chunk:7"]);
  });

  it("classifies, and drafts citing the intake and first chunk with one blocking question", () => {
    const r = demoResponder();
    expect(r(req("", "classify"), 0).output).toMatchObject({ kind: "feature" });
    const out = r(
      req(
        '<untrusted_data_ab id="intake:i1">\nx\n</untrusted_data_ab>\n<untrusted_data_ab id="chunk:3">\ny\n</untrusted_data_ab>',
      ),
      1,
    ).output as { problem: { citations: string[] }; openQuestions: { blocking: boolean }[] };
    expect(out.problem.citations).toEqual(["intake:i1", "chunk:3"]);
    expect(out.openQuestions.filter((q) => q.blocking)).toHaveLength(1);
  });
});
