import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../test/render.js";
import { findingLocation, FindingsTable, sortFindings, type Finding } from "./findings.js";

const findings: Finding[] = [
  { id: "a", severity: "minor", file: "src/b.ts", line: 9, message: "Rename this variable" },
  {
    id: "b",
    severity: "critical",
    file: "src/a.ts",
    line: 3,
    endLine: 7,
    message: "SQL injection",
  },
  { id: "c", severity: "nit", message: "Typo in the description", placement: "general" },
  { id: "d", severity: "critical", file: "src/a.ts", line: 1, message: "Secret in source" },
  {
    id: "e",
    severity: "major",
    file: "src/c.ts",
    line: 4,
    message: "Unhandled rejection",
    category: "correctness",
    suggestion: "await fetch(url).catch(report)",
  },
];

describe("findingLocation", () => {
  it("formats file, line ranges and general findings", () => {
    expect(findingLocation({ id: "1", severity: "info", message: "", file: "a.ts", line: 3 })).toBe(
      "a.ts:3",
    );
    expect(
      findingLocation({
        id: "1",
        severity: "info",
        message: "",
        file: "a.ts",
        line: 3,
        endLine: 5,
      }),
    ).toBe("a.ts:3-5");
    expect(findingLocation({ id: "1", severity: "info", message: "", file: "a.ts" })).toBe("a.ts");
    expect(findingLocation({ id: "1", severity: "info", message: "" })).toBe("General");
    expect(
      findingLocation({
        id: "1",
        severity: "info",
        message: "",
        file: "a.ts",
        placement: "general",
      }),
    ).toBe("General");
  });
});

describe("FindingsTable", () => {
  it("sorts by severity, then file and line, with unknown severities last", () => {
    const sorted = sortFindings([
      ...findings,
      { id: "z", severity: "weird", message: "Unknown" },
      { id: "y", severity: "Major", file: "src/a.ts", line: 2, message: "Upper case" },
    ]);
    expect(sorted.map((f) => f.id)).toEqual(["d", "b", "y", "e", "a", "c", "z"]);
  });

  it("renders severity, location, message and a suggestion disclosure", () => {
    const { container } = render(<FindingsTable findings={findings} caption="PR findings" />);
    expect(screen.getByRole("table", { name: "PR findings" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Severity",
      "Location",
      "Finding",
    ]);
    const first = screen.getAllByRole("row")[1]!;
    expect(within(first).getByText("Critical")).toBeTruthy();
    expect(within(first).getByText("src/a.ts:1")).toBeTruthy();
    expect(screen.getByText("src/a.ts:3-7")).toBeTruthy();
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("correctness")).toBeTruthy();
    expect(container.querySelector("details summary")?.textContent).toBe("Suggestion");
    expect(container.querySelector("details pre")?.textContent).toBe(
      "await fetch(url).catch(report)",
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
  });

  it("shows the empty text", () => {
    render(<FindingsTable findings={[]} emptyText="Nothing to report." />);
    expect(screen.getByText("Nothing to report.")).toBeTruthy();
  });

  it("toggles inclusion through onChange with labelled checkboxes", async () => {
    const onChange = vi.fn();
    const { user } = setup(<FindingsTable findings={findings} editable onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "Include finding: SQL injection" });
    expect((box as HTMLInputElement).checked).toBe(true);
    await user.click(box);
    expect(onChange).toHaveBeenCalledWith({ ...findings[1], included: false });
  });

  it("marks excluded findings in read-only mode", () => {
    render(<FindingsTable findings={[{ ...findings[0]!, included: false }, findings[1]!]} />);
    expect(screen.getAllByText("Excluded")).toHaveLength(1);
    expect(screen.getByText("Rename this variable").className).toMatch("line-through");
    expect(screen.getByText("SQL injection").className).not.toMatch("line-through");
  });

  it("shows excluded findings unchecked", () => {
    render(
      <FindingsTable
        findings={[{ ...findings[0]!, included: false }]}
        editable
        onChange={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("checkbox", { name: /Include finding/ }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("edits a message inline with the keyboard; Save sends it, Cancel and Escape discard", async () => {
    const onChange = vi.fn();
    const { user } = setup(<FindingsTable findings={findings} editable onChange={onChange} />);
    const edit = screen.getByRole("button", { name: "Edit finding: Rename this variable" });
    edit.focus();
    await user.keyboard("{Enter}");
    const box = screen.getByRole("textbox", { name: "Finding message" });
    expect(document.activeElement).toBe(box);
    expect((box as HTMLTextAreaElement).value).toBe("Rename this variable");
    await user.clear(box);
    await user.type(box, "Rename to userCount");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange).toHaveBeenCalledWith({ ...findings[0], message: "Rename to userCount" });
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit finding: SQL injection" }));
    await user.type(screen.getByRole("textbox", { name: "Finding message" }), " changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Edit finding: SQL injection" }));
    await user.type(screen.getByRole("textbox", { name: "Finding message" }), " again{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not save an empty message", async () => {
    const onChange = vi.fn();
    const { user } = setup(<FindingsTable findings={findings} editable onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Edit finding: SQL injection" }));
    await user.clear(screen.getByRole("textbox", { name: "Finding message" }));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("blocking severity", () => {
  it("sorts and colours as critical but keeps its label", () => {
    const f = (id: string, severity: string): Finding => ({ id, severity, message: id });
    expect(sortFindings([f("a", "minor"), f("b", "blocking")]).map((x) => x.id)).toEqual([
      "b",
      "a",
    ]);
    render(<FindingsTable findings={[f("b", "blocking")]} />);
    expect(screen.getByText("Blocking")).toBeTruthy();
  });
});
