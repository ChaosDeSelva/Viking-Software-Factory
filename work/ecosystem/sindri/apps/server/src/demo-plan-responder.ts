import type { FakeResponder, FakeResponse } from "@sindri/director";
import { SKELETON_MARKER } from "@sindri/planner";
import { contextIdsOf, demoResponder } from "./demo-responder.js";

interface SkeletonTask {
  id: string;
  role: string;
  acceptanceCriteria: string[];
}

/**
 * Deterministic responder for `FakeProvider` that also answers the planner: for `plan`
 * requests it fills exactly the skeleton tasks Sindri generated (read from the JSON after
 * `SKELETON_MARKER`); for `delivery_summary` it writes one cited sentence per evidence block;
 * every other request goes to `fallback` (the spec demo responder).
 * Used by server tests and the web e2e run only.
 */
export function demoPlanResponder(fallback: FakeResponder = demoResponder()): FakeResponder {
  return (req, index): FakeResponse => {
    if (req.metadata?.purpose === "delivery_summary") {
      // One sentence per evidence block, each citing it, so the citation validator keeps them.
      const ids = contextIdsOf(req);
      return {
        usage: { inputTokens: 400, outputTokens: 80 },
        text: ids.map((id, i) => `Evidence item ${i + 1} was recorded [ref:${id}].`).join(" "),
      };
    }
    if (req.metadata?.purpose !== "plan") return fallback(req, index);
    const text = req.messages.map((m) => m.content).join("\n");
    const at = text.lastIndexOf(SKELETON_MARKER);
    const skeleton = JSON.parse(text.slice(at + SKELETON_MARKER.length).trim()) as {
      tasks: SkeletonTask[];
    };
    return {
      usage: { inputTokens: 900, outputTokens: 200 },
      output: {
        tasks: skeleton.tasks.map((t) => ({
          id: t.id,
          objective:
            t.acceptanceCriteria.length > 0
              ? `As ${t.role}, satisfy ${t.acceptanceCriteria.join(", ")} for the reports CSV export.`
              : `As ${t.role}, document the reports CSV export.`,
          inputs: ["approved specification"],
          outputs: t.role === "implementer" ? ["code change", "tests"] : ["review notes"],
        })),
      },
    };
  };
}
