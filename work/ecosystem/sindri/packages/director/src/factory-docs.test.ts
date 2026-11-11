import { describe, expect, it } from "vitest";
import { createFactoryDocs } from "./factory-docs.js";
import { buildGuidePrompt } from "./guide.js";

const docs = createFactoryDocs();

describe("createFactoryDocs: glossary", () => {
  it("looks terms up case-insensitively by term, id and alias", () => {
    expect(docs.empty).toBe(false);
    for (const t of ["Escalation", "ESCALATION", " escalation "])
      expect(docs.glossary(t)?.term).toBe("Escalation");
    expect(docs.glossary("Pairing Code")?.term).toBe("Approval pairing code");
    expect(docs.glossary("approval-pairing-code")?.term).toBe("Approval pairing code");
    const e = docs.glossary("escalation")!;
    expect(Object.keys(e).sort()).toEqual(["long", "seeAlso", "short", "term"]);
    expect(e.short.length).toBeLessThanOrEqual(140);
  });

  it("resolves unambiguous multi-word raw status values, not ambiguous or empty ones", () => {
    expect(docs.glossary("not_paired")?.term).toMatch(/^Not paired \(/);
    expect(docs.glossary("not paired")?.term).toMatch(/^Not paired \(/);
    expect(docs.glossary("budget exceeded")?.term).toBe("Budget exceeded");
    expect(docs.glossary("draft")).toBeUndefined();
    expect(docs.glossary("")).toBeUndefined();
    expect(docs.glossary("no such thing at all")).toBeUndefined();
  });
});

describe("createFactoryDocs: search", () => {
  it("returns the relevant section, not the whole page", () => {
    const cases: [string, RegExp][] = [
      ["What is an escalation?", /escalation/i],
      ["Why is my task blocked by budget?", /budget/i],
      ["Where do I find the pairing code?", /pairing code/i],
    ];
    for (const [q, title] of cases) {
      const hits = docs.search(q);
      expect(hits.length, q).toBeGreaterThan(0);
      expect(hits[0]!.title, q).toMatch(title);
      expect(hits[0]!.title, q).toContain(" › ");
      expect(hits[0]!.slug, q).toMatch(/^[a-z0-9-]+#[a-z0-9-]+$/);
      for (const h of hits) expect(h.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it("finds where to delete a project's data", () => {
    expect(docs.search("How do I delete project data?")[0]!.slug).toMatch(/delete/);
  });

  it("returns nothing for an empty or stop-word query, and unique slugs otherwise", () => {
    expect(docs.search("")).toEqual([]);
    expect(docs.search("what is the")).toEqual([]);
    const slugs = docs.search("escalation budget pairing").map((h) => h.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.length).toBeLessThanOrEqual(8);
  });

  it("feeds the Guide prompt with docs and glossary blocks", () => {
    const p = buildGuidePrompt({
      question: "What is an escalation?",
      context: { app: "sindri" },
      state: { projects: [] },
      docs,
    });
    expect(p.docsAbsent).toBe(false);
    expect(p.user).toMatch(/id="docs:[a-z0-9-]+#[a-z0-9-]*escalation[a-z0-9-]*" kind="docs"/);
    expect(p.user).toContain('id="glossary:Escalation" kind="glossary"');
  });
});
