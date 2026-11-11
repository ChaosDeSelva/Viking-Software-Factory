import { screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { description, isChecked, setup } from "../test/render.js";
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from "./controls.js";

describe("Button", () => {
  it("with disabledReason stays focusable, blocks clicks and explains why", async () => {
    const onClick = vi.fn();
    const { user } = setup(
      <Button disabledReason="Unlock operator controls to approve." onClick={onClick}>
        Approve
      </Button>,
    );
    // The reason is the description only: the name stays the visible label.
    const button = screen.getByRole("button", { name: "Approve" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(description(button)).toMatch(/Unlock operator controls/);
    await user.tab();
    expect(document.activeElement).toBe(button);
    expect((await screen.findByRole("tooltip")).textContent).toMatch(/Unlock operator controls/);
    await user.click(button);
    await user.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps a caller's aria-describedby alongside the disabled reason", () => {
    setup(
      <>
        <p id="hint">Needs one approval.</p>
        <Button disabledReason="Read-only session." aria-describedby="hint">
          Merge
        </Button>
      </>,
    );
    const button = screen.getByRole("button", { name: "Merge" });
    expect(description(button)).toBe("Read-only session. Needs one approval.");
  });

  it("is busy and disabled while loading", () => {
    setup(<Button loading>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("IconButton is named by its label", () => {
    setup(<IconButton icon="refresh" label="Refresh" />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});

describe("Field", () => {
  it("labels its control and wires hint, error, required and aria-invalid", async () => {
    const { container } = setup(
      <form>
        <Field label="Repository URL" hint="Use https." error="Enter a URL" required>
          <Input />
        </Field>
        <Field label="Notes" hint="Optional">
          <Textarea />
        </Field>
      </form>,
    );
    const input = screen.getByRole("textbox", { name: /Repository URL/ });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(description(input)).toMatch(/Enter a URL.*Use https/);
    expect(description(screen.getByRole("textbox", { name: "Notes" }))).toMatch("Optional");
    await expectNoSeriousA11yViolations(container);
  });
});

describe("Switch, Checkbox, SegmentedControl, Select", () => {
  it("Switch toggles with click and keyboard", async () => {
    function Demo() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onCheckedChange={setOn} label="Notify me" />;
    }
    const { user } = setup(<Demo />);
    const sw = screen.getByRole("switch", { name: "Notify me" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await user.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    sw.focus();
    await user.keyboard(" ");
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("Checkbox is labelled and described", async () => {
    const { user } = setup(<Checkbox label="Include archived" description="Read-only" />);
    const box = screen.getByRole("checkbox", { name: "Include archived" });
    expect(description(box)).toMatch("Read-only");
    await user.click(screen.getByText("Include archived"));
    expect(isChecked(box)).toBe(true);
  });

  it("SegmentedControl is a radio group that moves with arrow keys", async () => {
    function Demo() {
      const [mode, setMode] = useState("off");
      return (
        <SegmentedControl
          label="Steward mode"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "off", label: "Off" },
            { value: "recommend", label: "Recommend" },
            { value: "auto", label: "Automatic" },
          ]}
        />
      );
    }
    const { user } = setup(<Demo />);
    expect(screen.getByRole("radiogroup", { name: "Steward mode" })).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Off" }));
    // Radix moves focus on a timer and selects only while the arrow key is still down.
    await user.keyboard("{ArrowRight>}");
    await waitFor(() =>
      expect(isChecked(screen.getByRole("radio", { name: "Recommend" }))).toBe(true),
    );
    await user.keyboard("{/ArrowRight}");
  });

  it("Select takes options as data and reports the choice", async () => {
    const onChange = vi.fn();
    const { user } = setup(
      <Field label="Harness">
        <Select
          value="codex"
          onValueChange={onChange}
          options={[
            { value: "codex", label: "Codex" },
            { value: "claude", label: "Claude Code" },
          ]}
        />
      </Field>,
    );
    const trigger = screen.getByRole("combobox", { name: "Harness" });
    expect(trigger.textContent).toMatch("Codex");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Claude Code" }));
    expect(onChange).toHaveBeenCalledWith("claude");
  });
});
