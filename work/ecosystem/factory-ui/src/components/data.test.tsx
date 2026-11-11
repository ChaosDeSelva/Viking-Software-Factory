import { act, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { setup } from "../test/render.js";
import {
  DataTable,
  formatRelative,
  Id,
  LogView,
  Pagination,
  Stepper,
  Tabs,
  Timeline,
  Timestamp,
  type Column,
  type SortState,
} from "./data.js";
import { EmptyState } from "./status.js";

interface Row {
  id: string;
  name: string;
  tasks: number;
}
const rows: Row[] = [
  { id: "a", name: "Alpha", tasks: 3 },
  { id: "b", name: "Bravo", tasks: 1 },
];
const columns: Column<Row>[] = [
  { key: "name", header: "Run", primary: true, sortable: true, cell: (r) => r.name },
  { key: "tasks", header: "Tasks", align: "right", sortable: true, cell: (r) => r.tasks },
];

describe("DataTable", () => {
  it("renders a captioned table with labelled cells for the stacked phone layout", async () => {
    const { container } = render(
      <DataTable caption="Runs" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );
    const table = screen.getByRole("table", { name: "Runs" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const cell = within(table).getByText("3").closest("td")!;
    expect(cell.getAttribute("data-label")).toBe("Tasks");
    expect(cell.className).toMatch("text-right");
    await expectNoSeriousA11yViolations(container);
  });

  it("shows the empty slot, loading skeleton and error with retry", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <DataTable
        caption="Runs"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No runs yet" body="Approve a plan to start one." />}
      />,
    );
    expect(screen.getByText("No runs yet")).toBeTruthy();
    rerender(<DataTable caption="Runs" columns={columns} rows={[]} rowKey={(r) => r.id} loading />);
    expect(screen.getByRole("table").getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByRole("row")).toHaveLength(6);
    rerender(
      <DataTable
        caption="Runs"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        error={new Error("503")}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch("503");
    screen.getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("sorts through header buttons with aria-sort and opens rows from the keyboard", async () => {
    const onRowClick = vi.fn();
    function Demo() {
      const [sort, setSort] = useState<SortState>({ key: "name", direction: "asc" });
      const sorted = [...rows].sort(
        (a, b) =>
          (sort.direction === "asc" ? 1 : -1) *
          (sort.key === "tasks" ? a.tasks - b.tasks : a.name.localeCompare(b.name)),
      );
      return (
        <DataTable
          caption="Runs"
          columns={columns}
          rows={sorted}
          rowKey={(r) => r.id}
          sort={sort}
          onSortChange={setSort}
          onRowClick={onRowClick}
          rowLabel={(r) => `Open ${r.name}`}
        />
      );
    }
    const { user } = setup(<Demo />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.getAttribute("aria-sort"))).toEqual(["ascending", "none"]);
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getAllByRole("columnheader").map((h) => h.getAttribute("aria-sort"))).toEqual([
      "none",
      "ascending",
    ]);
    expect(screen.getAllByRole("button", { name: /^Open/ }).map((b) => b.textContent)).toEqual([
      "Bravo",
      "Alpha",
    ]);
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getAllByRole("columnheader")[1]!.getAttribute("aria-sort")).toBe("descending");
    screen.getByRole("button", { name: "Open Alpha" }).focus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });
});

describe("Pagination", () => {
  it("marks the current page and disables the ends", async () => {
    const onPage = vi.fn();
    const { user } = setup(<Pagination page={1} pageCount={10} onPageChange={onPage} />);
    expect(screen.getByRole("button", { name: "Page 1" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPage).toHaveBeenCalledWith(2);
    expect(screen.getByText("…")).toBeTruthy();
  });
});

describe("Id and Timestamp", () => {
  it("Id truncates, keeps the full value accessible and copies it", async () => {
    const value = "0e7c1f2a-93b1-4a77-9f3e-6c1d2b8a9f01";
    const { user } = setup(<Id value={value} label="Run ID" />);
    // After setup: userEvent installs its own clipboard stub.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(screen.getByText("0e7c1f2a…9f01")).toBeTruthy();
    expect(screen.getByLabelText(`Run ID ${value}`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy Run ID" }));
    expect(writeText).toHaveBeenCalledWith(value);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("Id with tail={0} shows only the head and an ellipsis", () => {
    const value = "0e7c1f2a-93b1-4a77-9f3e-6c1d2b8a9f01";
    setup(<Id value={value} head={6} tail={0} label="Run ID" />);
    expect(screen.getByLabelText(`Run ID ${value}`).textContent).toBe("0e7c1f…");
  });

  it("Timestamp shows relative time with a machine-readable dateTime and an absolute tooltip", async () => {
    const now = new Date("2026-11-11T12:00:00Z");
    expect(formatRelative(new Date("2026-11-11T11:57:00Z"), now)).toBe("3 minutes ago");
    expect(formatRelative(new Date("2026-11-10T12:00:00Z"), now)).toBe("yesterday");
    expect(formatRelative(new Date("2026-11-11T11:59:50Z"), now)).toBe("just now");
    const { user } = setup(<Timestamp value="2026-11-11T11:00:00Z" now={now} prefix="Updated" />);
    const time = screen.getByText("Updated 1 hour ago");
    expect(time.getAttribute("datetime")).toBe("2026-11-11T11:00:00.000Z");
    await user.tab();
    expect((await screen.findByRole("tooltip")).textContent).toMatch("2026");
    render(<Timestamp value="not a date" />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("Tabs", () => {
  it("are real ARIA tabs and sync the selection to the URL", async () => {
    const items = [
      { value: "summary", label: "Summary", content: <p>Summary body</p> },
      { value: "history", label: "History", count: 3, content: <p>History body</p> },
    ];
    const { user } = setup(<Tabs label="Spec sections" items={items} urlParam="tab" />);
    expect(screen.getByRole("tablist", { name: "Spec sections" })).toBeTruthy();
    expect(screen.getByRole("tabpanel").textContent).toBe("Summary body");
    await user.click(screen.getByRole("tab", { name: /History/ }));
    expect(window.location.search).toBe("?tab=history");
    expect(screen.getByRole("tabpanel").textContent).toBe("History body");
    await user.keyboard("{ArrowLeft}");
    expect(window.location.search).toBe("");
  });

  it("read their initial tab from the URL", () => {
    window.history.replaceState(null, "", "/?tab=history");
    render(
      <Tabs
        label="Sections"
        urlParam="tab"
        items={[
          { value: "a", label: "A", content: "A body" },
          { value: "history", label: "History", content: "H body" },
        ]}
      />,
    );
    expect(screen.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("LogView, Timeline, Stepper", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  it("LogView collapses repeats and filters by level", async () => {
    const { user } = setup(
      <LogView
        now={now}
        entries={[
          { id: "1", time: "2026-11-11T11:50:00Z", type: "session.output", message: "npm test" },
          { id: "2", time: "2026-11-11T11:51:00Z", type: "session.output", message: "npm test" },
          {
            id: "3",
            time: "2026-11-11T11:52:00Z",
            level: "error",
            type: "gate",
            message: "lint failed",
          },
        ]}
      />,
    );
    const log = screen.getByRole("log", { name: "Event log" });
    // The log wraps a real list, so its items are not orphaned (axe listitem).
    expect(within(log).getByRole("list").tagName).toBe("OL");
    expect(within(log).getAllByRole("listitem")).toHaveLength(2);
    await expectNoSeriousA11yViolations(log.parentElement!);
    expect(screen.getByLabelText("repeated 2 times")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Errors" }));
    expect(
      within(log)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("lint failed")]);
  });

  it("Timeline groups by day", () => {
    render(
      <Timeline
        now={now}
        items={[
          { id: "1", time: "2026-11-11T11:00:00Z", title: "Verified" },
          { id: "2", time: "2026-11-10T11:00:00Z", title: "Approved" },
        ]}
      />,
    );
    expect(screen.getByRole("region", { name: "Today" }).textContent).toMatch("Verified");
    expect(screen.getByRole("region", { name: "Yesterday" }).textContent).toMatch("Approved");
  });

  it("Stepper marks the current step", () => {
    render(
      <Stepper
        current={1}
        steps={[
          { id: "a", label: "Describe" },
          { id: "b", label: "Review" },
        ]}
      />,
    );
    expect(screen.getByText("Review").closest("li")!.getAttribute("aria-current")).toBe("step");
    expect(screen.getByRole("img", { name: "Done" })).toBeTruthy();
  });
});

it("Timestamp ticks without a fixed now (no wall-clock assertions)", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    render(<Timestamp value="2026-11-11T11:59:00Z" />);
    expect(screen.getByText("1 minute ago")).toBeTruthy();
    act(() => {
      vi.setSystemTime(new Date("2026-11-11T12:05:00Z"));
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("6 minutes ago")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
