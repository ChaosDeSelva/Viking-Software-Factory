import type { CompleteRequest, FakeResponder, FakeResponse } from "@sindri/director";

/**
 * Ids of the untrusted data blocks the Director placed in the prompt. Accepts both
 * `<untrusted_data id="…">` and the nonce-delimited `<untrusted_data_<nonce> id="…">` form.
 */
export function contextIdsOf(req: CompleteRequest): string[] {
  const text = req.messages.map((m) => m.content).join("\n");
  return [...text.matchAll(/<untrusted_data(?:_[0-9a-z]+)? id="([^"]+)"/gi)].map((m) => m[1] ?? "");
}

/**
 * Deterministic responder for `FakeProvider`, used by server tests and the web e2e run.
 * It classifies every request as a feature and drafts a spec that cites the intake (and
 * the first indexed chunk, when one was provided), with one blocking question `Q1`.
 */
export function demoResponder(): FakeResponder {
  return (req): FakeResponse => {
    if (req.metadata?.purpose === "classify")
      return { output: { kind: "feature", impactedAreas: [], confidence: 0.8 } };
    const ids = contextIdsOf(req);
    const intake = ids.find((i) => i.startsWith("intake:")) ?? "request";
    const chunk = ids.find((i) => i.startsWith("chunk:"));
    const cites = chunk ? [intake, chunk] : [intake];
    return {
      usage: { inputTokens: 1200, outputTokens: 300 },
      output: {
        title: "CSV export for reports",
        problem: { text: "Users cannot export reports as CSV.", citations: cites },
        goals: [{ text: "Export the reports page as CSV", citations: [intake] }],
        nonGoals: [{ text: "Excel export", citations: [intake] }],
        constraints: [],
        risks: [{ text: "Large reports may be slow to export", citations: cites }],
        assumptions: [{ text: "Exports run in the browser", risk: "medium" }],
        acceptanceCriteria: [
          {
            id: "AC1",
            text: "A CSV download button exists on the reports page",
            verification: "test",
            citations: cites,
          },
        ],
        openQuestions: [
          { id: "Q1", text: "Which columns must the CSV include?", blocking: true },
          { id: "Q2", text: "Preferred file name?", blocking: false },
        ],
      },
    };
  };
}
