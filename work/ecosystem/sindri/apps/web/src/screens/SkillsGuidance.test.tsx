import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { skill } from "../test/work-fixtures.js";
import { ProjectSettingsScreen } from "./ProjectSettingsScreen.js";
import { SettingsScreen } from "./SettingsScreen.js";

const settings = {
  settings: { provider: "fake", model: "m", localOnly: true },
  tokenLocation: null,
};

function openSkills(over: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    getSettings: settings,
    mimirStatus: {
      configured: false,
      url: null,
      tokenSecret: null,
      blocked: null,
      reachable: null,
      serverVersion: null,
      error: null,
    },
    listSkills: [
      skill(),
      skill({ id: "sk2", name: "security", changedOnDisk: true }),
      skill({ id: "sk3", name: "old", missingOnDisk: true }),
    ],
    ...over,
  });
  renderWithStore(
    <>
      <NoticeRegion />
      <SettingsScreen />
    </>,
    api,
  );
  return api;
}

describe("Settings → Skills", () => {
  it("lists skills with digest prefixes and disk-state badges", async () => {
    openSkills();
    await userEvent.click(await screen.findByRole("tab", { name: "Skills" }));
    const list = await screen.findByRole("list", { name: "Skills" });
    expect(within(list).getByText("code-review", { selector: ".font-medium" })).toBeTruthy();
    expect(within(list).getAllByText("a1b2c3d4e5f6")).toHaveLength(3);
    expect(within(list).getByText("Changed on disk")).toBeTruthy();
    expect(within(list).getByText("Missing on disk")).toBeTruthy();
  });

  it("imports by absolute path, refuses relative ones and lists skipped folders", async () => {
    const api = openSkills({
      importSkills: {
        imported: [skill({ id: "sk4", name: "new" })],
        skipped: [{ path: "/s/big/SKILL.md", reason: "too_large" }],
      },
    });
    await userEvent.click(await screen.findByRole("tab", { name: "Skills" }));
    const form = screen.getByRole("form", { name: "Import skills" });
    expect(within(form).getByText(/~\/\.claude\/skills\/<name>/)).toBeTruthy();
    const input = within(form).getByLabelText("Skill folder");
    await userEvent.type(input, "~/skills");
    const submit = within(form).getByRole("button", { name: /^Import/ });
    expect(submit.textContent).toMatch(/absolute path/);
    await userEvent.click(submit);
    expect(api.importSkills).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, " /s ");
    await userEvent.click(within(form).getByRole("button", { name: "Import" }));
    expect(api.importSkills).toHaveBeenCalledWith("/s");
    expect(await screen.findByText(/Imported 1 skill$/)).toBeTruthy();
    expect(screen.getByText("Skipped 1")).toBeTruthy();
    expect(screen.getByText(/over 64 KB/)).toBeTruthy();
    expect(api.listSkills).toHaveBeenCalledTimes(2);
  });

  it("previews, re-imports and deletes a skill after an in-page confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const api = openSkills({
      getSkill: { ...skill(), content: "# Code review\nLook for bugs." },
      reimportSkill: skill(),
      deleteSkill: { deleted: "sk1" },
    });
    await userEvent.click(await screen.findByRole("tab", { name: "Skills" }));
    await screen.findByRole("list", { name: "Skills" });
    await userEvent.click(screen.getByRole("button", { name: "Preview code-review" }));
    expect(await screen.findByText(/Look for bugs/)).toBeTruthy();
    expect(api.getSkill).toHaveBeenCalledWith("sk1");
    await userEvent.click(screen.getByRole("button", { name: "Re-import security" }));
    expect(api.reimportSkill).toHaveBeenCalledWith("sk2");
    expect(await screen.findByText(/Re-imported security/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete code-review" }));
    expect(api.deleteSkill).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete code-review" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete skill" }));
    expect(api.deleteSkill).toHaveBeenCalledWith("sk1");
    expect(await screen.findByText(/Deleted code-review/)).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("reports a failed re-import", async () => {
    openSkills({
      reimportSkill: () =>
        Promise.reject(new ApiError(422, "validation_failed", "SKILL.md can no longer be read")),
    });
    await userEvent.click(await screen.findByRole("tab", { name: "Skills" }));
    await userEvent.click(await screen.findByRole("button", { name: "Re-import old" }));
    expect(await screen.findByText(/can no longer be read/)).toBeTruthy();
  });
});

describe("Project settings → Guidance", () => {
  function openGuidance(over: Parameters<typeof mockApi>[0] = {}) {
    const api = mockApi({
      getGuidance: {
        projectId: "p1",
        notes: "Check auth",
        defaultSkillIds: ["sk1"],
        updatedAt: null,
      },
      listSkills: [skill(), skill({ id: "sk2", name: "security" })],
      putGuidance: {
        projectId: "p1",
        notes: "Check auth and CSRF",
        defaultSkillIds: ["sk1", "sk2"],
        updatedAt: "x",
      },
      ...over,
    });
    renderWithStore(
      <>
        <NoticeRegion />
        <ProjectSettingsScreen />
      </>,
      api,
    );
    return api;
  }

  it("saves standing notes and default skills", async () => {
    const api = openGuidance();
    await userEvent.click(await screen.findByRole("tab", { name: "Guidance" }));
    const form = await screen.findByRole("form", { name: "Project guidance" });
    const save = () => within(form).getByRole("button", { name: /^Save guidance/ });
    expect(save().textContent).toMatch(/No changes to save/);
    await userEvent.type(within(form).getByLabelText("Standing review notes"), " and CSRF");
    await waitFor(() =>
      expect((within(form).getByLabelText(/code-review/) as HTMLInputElement).checked).toBe(true),
    );
    await userEvent.click(within(form).getByLabelText(/security/));
    await userEvent.click(save());
    expect(api.putGuidance).toHaveBeenCalledWith("p1", {
      notes: "Check auth and CSRF",
      defaultSkillIds: ["sk1", "sk2"],
    });
    expect(await screen.findByText("Guidance saved")).toBeTruthy();
  });

  it("refuses notes over 16 KB", async () => {
    const api = openGuidance({
      getGuidance: {
        projectId: "p1",
        notes: "x".repeat(16 * 1024),
        defaultSkillIds: [],
        updatedAt: null,
      },
    });
    await userEvent.click(await screen.findByRole("tab", { name: "Guidance" }));
    const form = await screen.findByRole("form", { name: "Project guidance" });
    const notes = within(form).getByLabelText("Standing review notes");
    expect(within(form).getByText(/16384 \/ 16384 bytes/)).toBeTruthy();
    await userEvent.type(notes, "é");
    expect(notes.getAttribute("aria-invalid")).toBe("true");
    const save = within(form).getByRole("button", { name: /^Save guidance/ });
    expect(save.textContent).toMatch(/over 16 KB/);
    await userEvent.click(save);
    expect(api.putGuidance).not.toHaveBeenCalled();
  });
});
