import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { meta, spec } from "../test/fixtures.js";
import { ContextList, OpenQuestions, refLabel, SpecView } from "./SpecView.js";

describe("refLabel", { timeout: 20_000 }, () => {
  it("names every kind of source", () => {
    expect(refLabel({ intakeId: "i1aaaaaaaaaa" })).toBe("intake:i1aaaaaa");
    expect(refLabel({ knowledgeEntryId: "k1bbbbbbbbbb" })).toBe("knowledge:k1bbbbbb");
    expect(refLabel({ taskEvidenceId: "ev1ccccccccc" })).toBe("evidence:ev1ccccc");
    expect(refLabel({ documentId: "d1dddddddddd" })).toBe("document:d1dddddd");
    expect(refLabel({ documentId: "d1", startLine: 4 })).toBe("document:d1#L4-L4");
    expect(
      refLabel({ documentId: "d1", startLine: 1, endLine: 3 }, [
        { id: "x", kind: "intake", title: "Not a document", ref: null, excerpt: "" },
        { id: "y", kind: "intake", title: "Intake", ref: { intakeId: "d1" }, excerpt: "" },
        { id: "z", kind: "doc", title: "README.md", ref: { documentId: "d1" }, excerpt: "" },
      ]),
    ).toBe("README.md#L1-L3");
  });
});

describe("SpecView", { timeout: 20_000 }, () => {
  it("shows approval, empty sections, risks, recommendations and unverified claims", () => {
    const s = spec({
      status: "approved",
      approvedBy: "local:me/web",
      body: {
        ...spec().body,
        assumptions: [],
        openQuestions: [
          {
            id: "Q1",
            text: "Which columns?",
            blocking: false,
            recommendation: "Date and total",
            rationale: "The page lists them.",
          },
          { id: "Q2", text: "File name?", blocking: true, recommendation: "report.csv" },
        ],
      },
      // No acceptance-criteria provenance at all.
      provenance: { goals: [{ knowledgeEntryId: "k1" }], risks: "not a list" },
    });
    render(
      <SpecView
        spec={s}
        meta={meta({
          unverifiedClaims: [
            { section: "constraints", text: "Uses Postgres", unknownCitations: [] },
          ],
        })}
      />,
    );
    const article = screen.getByRole("article", { name: "Specification CSV export for reports" });
    expect(article.textContent).toMatch(/approved by local:me\/web/);
    expect(within(article).getByText("Sources: knowledge:k1")).toBeTruthy();
    expect(within(article).queryByText(/Sources: document/)).toBeNull();
    expect(within(article).getByText(/Date and total/).textContent).toMatch(
      /Recommended: Date and totalThe page lists them\./,
    );
    expect(within(article).getByText(/report\.csv/).textContent).toBe("Recommended: report.csv");
    expect(within(article).getByText("constraints: Uses Postgres")).toBeTruthy();
    // Assumptions are empty; non-goals too.
    expect(within(article).getAllByText("None").length).toBeGreaterThanOrEqual(2);
  });

  it("marks high-risk assumptions and shows no banner or claims without meta", () => {
    render(
      <SpecView
        spec={spec({
          body: {
            ...spec().body,
            assumptions: [{ text: "Data fits in memory", risk: "high" }],
            openQuestions: [],
          },
        })}
        meta={null}
      />,
    );
    expect(screen.getByText(/Data fits in memory/).textContent).toMatch(/high risk/);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/Unverified claims/)).toBeNull();
  });
});

describe("ContextList", { timeout: 20_000 }, () => {
  it("renders nothing without context and lists cited items otherwise", () => {
    const { container, rerender } = render(<ContextList items={[]} />);
    expect(container.textContent).toBe("");
    rerender(
      <ContextList
        items={[{ id: "doc:README.md", kind: "doc", title: "README", ref: null, excerpt: "" }]}
      />,
    );
    expect(screen.getByText("Loaded context (1 cited items)")).toBeTruthy();
    expect(screen.getByText("doc:README.md")).toBeTruthy();
  });
});

describe("OpenQuestions", { timeout: 20_000 }, () => {
  it("says when no question remains", () => {
    render(<OpenQuestions questions={[]} busy={false} onAnswer={vi.fn()} />);
    expect(screen.getByText("No open questions remain.")).toBeTruthy();
  });

  it("does not send a blank answer even if the form is submitted", () => {
    const onAnswer = vi.fn();
    render(
      <OpenQuestions
        questions={[{ id: "Q1", text: "Which columns?", blocking: true }]}
        busy={false}
        onAnswer={onAnswer}
        answers={{ Q1: "   " }}
        onAnswersChange={vi.fn()}
      />,
    );
    fireEvent.submit(screen.getByRole("form", { name: "Answer Q1" }));
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
