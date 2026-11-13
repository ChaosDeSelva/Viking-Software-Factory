import { fitGuidance, GUIDANCE_CAP_BYTES, sha256Text } from "@sindri/knowledge";
import type { Plan } from "@sindri/planner";
import { describe, expect, it } from "vitest";
import { mapPlan, mimirInputSlug, modeFor } from "./mapping.js";
import { approvedPlan, planTask } from "./testing.js";

const research = (
  sources: { code: boolean; feedbackGraph: boolean; web: boolean },
  over: Partial<Plan> = {},
): Plan =>
  approvedPlan(
    [
      planTask("research", {
        role: "investigator",
        lessons: ["fg:l1"],
        lessonContext: [{ id: "fg:l1", title: "Retries", text: "Retries use backoff." }],
      }),
      planTask("fact-check", { role: "reviewer", dependsOn: ["research"] }),
    ],
    {
      work: {
        kind: "research",
        research: { sources, factCheck: true, question: "How are retries scheduled?" },
      },
      ...over,
    },
  );

const skill = (name: string, size: number) => {
  const content = "z".repeat(size);
  return { id: `skl_${name}`, name, digest: sha256Text(content), content };
};

describe("task modes", () => {
  it("sends no mode for a change plan", () => {
    const mapped = mapPlan(approvedPlan([planTask("a")]));
    expect(mapped.tasks[0]!.mode).toBeUndefined();
    expect(modeFor({}, { role: "implementer" })).toBeUndefined();
  });

  it("runs the investigator as a read-only document task, web only when enabled", () => {
    const off = mapPlan(research({ code: true, feedbackGraph: false, web: false }));
    expect(off.tasks.find((t) => t.planTaskId === "research")!.mode).toEqual({
      deliverable: "document",
      access: "read",
      network: "none",
    });
    expect(off.tasks.find((t) => t.planTaskId === "fact-check")!.mode).toEqual({
      deliverable: "document",
      access: "read",
      network: "none",
    });
    const on = mapPlan(research({ code: false, feedbackGraph: false, web: true }));
    expect(on.tasks.map((t) => t.mode?.network)).toEqual(["web", "web"]);
  });
});

describe("research briefs", () => {
  it("asks for the document, the sources file and citations of the allowed sources", () => {
    const brief = mapPlan(research({ code: true, feedbackGraph: true, web: false })).tasks[0]!
      .brief;
    expect(brief).toContain(JSON.stringify("How are retries scheduled?"));
    expect(brief).toContain("## Answer, ## Findings, ## Open questions, ## Sources");
    expect(brief).toContain(".mimir/artifacts/research.md");
    expect(brief).toContain(".mimir/artifacts/sources.json");
    expect(brief).toContain("The task fails without .mimir/artifacts/research.md");
    expect(brief).toContain("written as [1] or [1, 2] (no ranges such as [1-3])");
    expect(brief).toContain("`path:line` or `path:start-end`");
    expect(brief).not.toContain("The web: search");
    expect(brief).toContain('- lesson:l1 "Retries": "Retries use backoff."');
    expect(brief).not.toContain("- fg:l1");
    expect(brief).toMatch(/Do not modify, create or delete any file outside \.mimir\/artifacts/);
    expect(brief).not.toContain("leave your source changes in the worktree");
  });

  it("leaves lessons out when the request does not allow them", () => {
    const brief = mapPlan(research({ code: false, feedbackGraph: false, web: true })).tasks[0]!
      .brief;
    expect(brief).not.toContain("lesson:");
    expect(brief).not.toContain("Retries use backoff");
    expect(brief).toContain("Cite the page's full http(s) URL");
  });

  it("titles the research task with its bare id, the slug Mimir hands to the fact-check", () => {
    const mapped = mapPlan(research({ code: true, feedbackGraph: false, web: false }));
    expect(mapped.tasks.map((t) => t.title)).toEqual(["research", "fact-check: do fact-check"]);
  });

  it("tells the fact-checker to verify claims and write review.json", () => {
    const brief = mapPlan(research({ code: true, feedbackGraph: false, web: false })).tasks[1]!
      .brief;
    expect(brief).toContain(".mimir/inputs/research/research.md");
    expect(brief).toMatch(/at least five claims/);
    expect(brief).toContain(".mimir/artifacts/review.json");
    expect(brief).toContain("each decision MUST be an object");
  });
});

describe("operator guidance in briefs", () => {
  it("renders skills, project notes and request notes in that order", () => {
    const a = skill("a", 10);
    const plan = approvedPlan([planTask("a")], {
      guidance: fitGuidance({ skills: [a], projectNotes: "Project rule", requestNotes: "Ask" }),
    });
    const brief = mapPlan(plan).tasks[0]!.brief;
    expect(brief).toContain(`### Skill: a (sha256 ${a.digest.slice(0, 12)})`);
    expect(brief.indexOf("### Skill: a")).toBeLessThan(brief.indexOf("### Project notes"));
    expect(brief.indexOf("### Project notes")).toBeLessThan(brief.indexOf("### Request notes"));
  });

  it("caps the block and lists skills that did not fit instead of cutting them", () => {
    const big = [skill("one", 30_000), skill("two", 30_000), skill("three", 5_000)];
    // A snapshot stored without fitting is still capped when the brief is built.
    const plan = approvedPlan([planTask("a")], {
      guidance: {
        skills: big,
        omitted: [],
        projectNotes: "",
        requestNotes: "",
        projectNotesDigest: null,
        requestNotesDigest: null,
      },
    });
    const brief = mapPlan(plan).tasks[0]!.brief;
    const block = brief.slice(brief.indexOf("Operator guidance:"));
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(GUIDANCE_CAP_BYTES);
    expect(block).toContain("Omitted (size cap): two");
    expect(block).toContain("z".repeat(30_000));
    expect(block).toContain("### Skill: three");
    expect(block).not.toContain("### Skill: two");
  });

  it("adds no block without guidance and none to shell commands", () => {
    expect(mapPlan(approvedPlan([planTask("a")])).tasks[0]!.brief).not.toContain(
      "Operator guidance",
    );
    const plan = approvedPlan([planTask("a")], {
      guidance: fitGuidance({ skills: [], projectNotes: "n" }),
    });
    expect(mapPlan(plan, { agentKindFor: () => "shell" }).tasks[0]!.brief).not.toContain(
      "Operator guidance",
    );
  });
});

describe("fact-check input folder", () => {
  it("follows the research task's Mimir title with Mimir's slug rule", () => {
    expect(mimirInputSlug("Research: Q?")).toBe("research-q");
    expect(mimirInputSlug("***")).toBe("task");
    expect(mimirInputSlug("a".repeat(80))).toHaveLength(60);
    const plan = approvedPlan(
      [
        planTask("Deep_Dive", { role: "investigator" }),
        planTask("fact-check", { role: "reviewer", dependsOn: ["Deep_Dive"] }),
      ],
      {
        work: {
          kind: "research",
          research: { sources: { code: true, feedbackGraph: false, web: false }, factCheck: true },
        },
      },
    );
    const brief = mapPlan(plan).tasks.find((t) => t.planTaskId === "fact-check")!.brief;
    expect(brief).toContain(".mimir/inputs/deep-dive/research.md");
    expect(brief).toContain(".mimir/inputs/deep-dive/sources.json");
  });
});

describe("follow-up context", () => {
  it("puts the earlier document under its own heading, after the question", () => {
    const plan = research(
      { code: true, feedbackGraph: false, web: false },
      {
        work: {
          kind: "research",
          research: {
            sources: { code: true, feedbackGraph: false, web: false },
            factCheck: false,
            question: "Which columns?",
            context: { executionId: "exe_1", document: "## Answer\nDates [1]." },
          },
        },
      },
    );
    const brief = mapPlan(plan).tasks[0]!.brief;
    const q = brief.indexOf('"Which columns?"');
    const c = brief.indexOf("Earlier document (context)");
    expect(q).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(q);
    expect(brief).toContain(JSON.stringify("## Answer\nDates [1]."));
  });
});
