import { screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../test/render.js";
import { Combobox, CommandPalette, ProjectPicker } from "./combobox.js";

const options = [
  { value: "m1", label: "Greeting endpoint", group: "Recent" },
  { value: "m2", label: "Invoice rounding", group: "Recent" },
  { value: "m3", label: "Search ranking", group: "All missions", keywords: "relevance" },
];

describe("Combobox", () => {
  function Demo({ onChange = () => undefined }: { onChange?: (v: string) => void }) {
    const [value, setValue] = useState<string | null>(null);
    return (
      <Combobox
        label="Mission"
        options={options}
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
    );
  }

  it("filters as you type, including keywords, and shows an empty message", async () => {
    const { user } = setup(<Demo />);
    await user.click(screen.getByRole("button", { name: /Mission/ }));
    const input = await screen.findByRole("combobox", { name: "Mission" });
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.type(input, "relev");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Search ranking"]);
    await user.clear(input);
    await user.type(input, "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("groups options and moves the active option with arrow keys (aria-activedescendant)", async () => {
    const onChange = vi.fn();
    const { user } = setup(<Demo onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Mission/ }));
    const input = await screen.findByRole("combobox", { name: "Mission" });
    expect(document.activeElement).toBe(input);
    const recent = screen.getByRole("group", { name: "Recent" });
    expect(within(recent).getAllByRole("option")).toHaveLength(2);
    const activeLabel = () =>
      document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(activeLabel()).toBe("Greeting endpoint");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(activeLabel()).toBe("Search ranking");
    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Greeting endpoint");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenCalledWith("m3");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: /Mission/ }).textContent).toMatch("Search ranking");
  });
});

describe("ProjectPicker", () => {
  const projects = [
    { id: "p1", name: "demo-app" },
    { id: "p2", name: "acme-billing" },
    { id: "p3", name: "acme-search" },
  ];

  it("lists recent projects first, maps All projects to null and offers Manage projects", async () => {
    const onChange = vi.fn();
    const onManage = vi.fn();
    const { user } = setup(
      <ProjectPicker
        projects={projects}
        value="p1"
        onChange={onChange}
        recentIds={["p2"]}
        allowAll
        onManage={onManage}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Project/ }));
    const groups = screen.getAllByRole("group");
    expect(
      groups.map(
        (g) => g.getAttribute("aria-labelledby") && within(g).getAllByRole("option").length,
      ),
    ).toEqual([1, 2]);
    expect(within(groups[0]!).getByRole("option").textContent).toMatch("acme-billing");
    await user.click(screen.getByRole("option", { name: /All projects/ }));
    expect(onChange).toHaveBeenCalledWith(null);
    await user.click(screen.getByRole("button", { name: /Project/ }));
    await user.click(screen.getByRole("option", { name: /Manage projects/ }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("truncates a long name within a capped width and keeps the full name in a tooltip", () => {
    const long = "acme-platform-monorepo-with-a-very-long-descriptive-name";
    setup(<ProjectPicker projects={[{ id: "p9", name: long }]} value="p9" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: `Project: ${long}` });
    expect(trigger.className).toMatch(/\bmax-w-64\b/);
    const label = within(trigger).getByText(long);
    expect(label.className).toMatch(/\btruncate\b/);
    expect(label.getAttribute("title")).toBe(long);
  });

  it("is disabled with a reason on global pages", () => {
    setup(
      <ProjectPicker
        projects={projects}
        value={null}
        onChange={() => undefined}
        disabledReason="Fleet covers all projects"
      />,
    );
    const trigger = screen.getByRole("button", { name: /Project/ }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toBe("Fleet covers all projects");
  });
});

describe("CommandPalette", () => {
  it("runs the chosen item and closes", async () => {
    const run = vi.fn();
    const onOpenChange = vi.fn();
    const { user } = setup(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        items={[
          { id: "a", label: "Overview", group: "Pages", run: () => undefined },
          { id: "b", label: "Runs", group: "Pages", run },
        ]}
      />,
    );
    await user.type(screen.getByRole("combobox", { name: "Jump to" }), "runs{Enter}");
    expect(run).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
