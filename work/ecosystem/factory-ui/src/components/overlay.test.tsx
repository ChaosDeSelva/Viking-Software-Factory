import { act, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../test/render.js";
import { Button } from "./controls.js";
import { Markdown } from "./docs.js";
import {
  ConfirmDialog,
  Dialog,
  Drawer,
  GlossaryProvider,
  InfoHint,
  ToastProvider,
  Tooltip,
  useToast,
} from "./overlay.js";
import { StatusPill } from "./status.js";

const glossary = [{ term: "Steward", short: "Proposes routine decisions for you." }];

describe("Tooltip", () => {
  it("opens on keyboard focus and names the trigger's description", async () => {
    const { user } = setup(
      <Tooltip content="Refreshes the snapshot">
        <button type="button">Refresh</button>
      </Tooltip>,
    );
    await user.tab();
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toMatch("Refreshes the snapshot");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("renders the child alone when there is no content", () => {
    setup(
      <Tooltip content="">
        <button type="button">Plain</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "Plain" })).toBeTruthy();
  });
});

describe("InfoHint", () => {
  it("looks the term up in the glossary and links to Docs", async () => {
    const { user } = setup(
      <GlossaryProvider entries={glossary} docsHref={(t) => `/docs/glossary#${t.toLowerCase()}`}>
        <InfoHint term="steward" />
      </GlossaryProvider>,
    );
    await user.click(screen.getByRole("button", { name: "What is Steward?" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch("Proposes routine decisions");
    expect(screen.getByRole("link", { name: /Read more in Docs/ }).getAttribute("href")).toBe(
      "/docs/glossary#steward",
    );
  });

  it("links by default to the id the glossary page gives the term's heading", async () => {
    const { user } = setup(
      <GlossaryProvider entries={[{ term: "Node.js", short: "The JavaScript runtime." }]}>
        <InfoHint term="Node.js" />
        <Markdown source={"## Node.js"} />
      </GlossaryProvider>,
    );
    const heading = screen.getByRole("heading", { level: 2, name: "Node.js" });
    await user.click(screen.getByRole("button", { name: "What is Node.js?" }));
    await screen.findByRole("dialog");
    expect(screen.getByRole("link", { name: /Read more in Docs/ }).getAttribute("href")).toBe(
      `/docs/glossary#${heading.id}`,
    );
  });

  it("falls back to its children and renders nothing without text", () => {
    const { container } = setup(<InfoHint term="Nonexistent" />);
    expect(container.innerHTML).toBe("");
    setup(<InfoHint label="About budgets">Spending cap per task.</InfoHint>);
    expect(screen.getByRole("button", { name: "About budgets" })).toBeTruthy();
  });
});

describe("StatusPill", () => {
  it("shows a human label with a role, and the raw value in its tooltip", async () => {
    const { user } = setup(<StatusPill app="sindri" value="verified_pending_review" />);
    const pill = screen.getByRole("img", { name: "Status: Awaiting review" });
    expect(pill.getAttribute("data-role")).toBe("waiting");
    await user.tab();
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toMatch("verified_pending_review");
  });

  it("shows an unknown value as its raw text with the unknown role", () => {
    setup(<StatusPill app="heimdall" value="teleporting" tooltip={false} />);
    const pill = screen.getByRole("img", { name: "Status: teleporting" });
    expect(pill.getAttribute("data-role")).toBe("unknown");
    expect(pill.getAttribute("tabindex")).toBeNull();
  });

  it("accepts a label and description from the docs package", async () => {
    const { user } = setup(
      <StatusPill app="mimir" value="leased" label="Claimed" description="A worker took it." />,
    );
    expect(screen.getByRole("img", { name: "Status: Claimed" })).toBeTruthy();
    await user.tab();
    expect((await screen.findByRole("tooltip")).textContent).toMatch("A worker took it.");
  });
});

describe("Dialog, ConfirmDialog, Drawer", () => {
  function DialogDemo() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Request changes"
          description="Send it back."
        >
          <input aria-label="Note" />
        </Dialog>
      </>
    );
  }

  it("traps focus, closes on Escape and returns focus to the opener", async () => {
    const { user } = setup(<DialogDemo />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Request changes" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("ConfirmDialog is an alertdialog that confirms or cancels", async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const { user } = setup(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("alertdialog", { name: "Cancel this run?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Keep running" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("busy dialogs ignore Escape", async () => {
    const onOpenChange = vi.fn();
    const { user } = setup(
      <Drawer open busy onOpenChange={onOpenChange} title="Saving">
        <p>Working</p>
      </Drawer>,
    );
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Saving" })).toBeTruthy();
  });
});

describe("Toast", () => {
  function Trigger({ tone }: { tone: "success" | "danger" }) {
    const toast = useToast();
    return <Button onClick={() => toast({ title: `${tone} toast`, tone })}>Notify</Button>;
  }

  it("shows a toast; success clears itself, errors persist until dismissed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user } = setup(
        <ToastProvider>
          <Trigger tone="success" />
        </ToastProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Notify" }));
      expect(screen.getByText("success toast")).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });
      await waitFor(() => expect(screen.queryByText("success toast")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("error toasts stay until dismissed", async () => {
    const { user } = setup(
      <ToastProvider>
        <Trigger tone="danger" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getByText("danger toast")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("danger toast")).toBeNull());
  });
});
