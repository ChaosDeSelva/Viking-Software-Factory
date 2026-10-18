import { SKELETON_MARKER } from "@sindri/planner";
import { describe, expect, it } from "vitest";
import { demoPlanResponder } from "./demo-plan-responder.js";

describe("demoPlanResponder", () => {
  it("fills exactly the skeleton tasks for plan requests", () => {
    const skeleton = {
      tasks: [
        { id: "implement-frontend", role: "implementer", acceptanceCriteria: ["AC1"] },
        { id: "docs", role: "docs", acceptanceCriteria: [] },
      ],
    };
    const out = demoPlanResponder()(
      {
        system: "s",
        messages: [
          { role: "user", content: `blocks\n${SKELETON_MARKER}\n${JSON.stringify(skeleton)}` },
        ],
        maxTokens: 10,
        temperature: 0,
        metadata: { purpose: "plan" },
      },
      0,
    );
    const tasks = (out.output as { tasks: { id: string; objective: string }[] }).tasks;
    expect(tasks.map((t) => t.id)).toEqual(["implement-frontend", "docs"]);
    expect(tasks[0]?.objective).toMatch(/AC1/);
  });

  it("delegates other purposes to the spec responder", () => {
    const out = demoPlanResponder()(
      {
        system: "s",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
        temperature: 0,
        metadata: { purpose: "classify" },
      },
      0,
    );
    expect(out.output).toMatchObject({ kind: "feature" });
  });

  it("writes a cited implementation summary from the evidence block ids", () => {
    const out = demoPlanResponder()(
      {
        system: "s",
        messages: [
          {
            role: "user",
            content:
              '<untrusted_data_ab12 id="evt_1" kind="task">Plan task qa completed.</untrusted_data_ab12>\n' +
              '<untrusted_data_ab12 id="evt_2" kind="test_run">Test run</untrusted_data_ab12>',
          },
        ],
        maxTokens: 10,
        temperature: 0,
        metadata: { purpose: "delivery_summary" },
      },
      0,
    );
    expect(out.text).toMatch(/\[ref:evt_1\]/);
    expect(out.text).toMatch(/\[ref:evt_2\]/);
  });
});
