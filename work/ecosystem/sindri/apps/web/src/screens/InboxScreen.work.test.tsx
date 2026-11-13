import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { intake } from "../test/fixtures.js";
import { mockApi, PROJECT, renderWithStore } from "../test/utils.js";
import { skill } from "../test/work-fixtures.js";
import { InboxScreen } from "./InboxScreen.js";
import { PR_URL } from "./WorkForms.js";

const ui = (
  <>
    <NoticeRegion />
    <InboxScreen />
  </>
);

const linked = { link: { projectKey: "demo", source: "auto" }, lessons: [], error: null };
const unlinked = { link: { projectKey: null, source: "none" }, lessons: [], error: null };

function setup(over: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    listIntakes: [],
    listSkills: [skill(), skill({ id: "sk2", name: "security", description: "" })],
    getProjectFeedbackGraph: linked,
    getGuidance: { projectId: "p1", notes: "", defaultSkillIds: ["sk2"], updatedAt: null },
    githubStatus: { enabled: true, configured: true, ghInstalled: true, localOnly: false },
    ...over,
  });
  renderWithStore(ui, api);
  return api;
}

const chooseKind = async (name: string) =>
  userEvent.click(await screen.findByRole("radio", { name }));

describe("Inbox work kinds", () => {
  it("offers Change / Research / Review a PR as a radio group", async () => {
    setup();
    const group = await screen.findByRole("radiogroup", { name: "Kind of work" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Change", "Research", "Review a PR"]);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("form", { name: "Manual intake" })).toBeTruthy();
    await chooseKind("Research");
    expect(screen.getByRole("form", { name: "Research question" })).toBeTruthy();
    await chooseKind("Review a PR");
    expect(screen.getByRole("form", { name: "Review a pull request" })).toBeTruthy();
  });

  it("submits a research question with sources, fact-check, notes and skills", async () => {
    const api = setup({ createIntake: intake({ workKind: "research" }) });
    await chooseKind("Research");
    const form = screen.getByRole("form", { name: "Research question" });
    const lessons = within(form).getByLabelText("Lessons from your feedback history");
    await waitFor(() => expect((lessons as HTMLInputElement).checked).toBe(true));
    expect((within(form).getByLabelText("Project code") as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByLabelText("Web") as HTMLInputElement).checked).toBe(false);
    expect(within(form).getByRole("switch", { name: "Fact-check the document" })).toBeTruthy();
    await userEvent.type(within(form).getByLabelText("Question"), "How are totals computed?");
    await userEvent.type(within(form).getByLabelText("Background (optional)"), "For the audit");
    await userEvent.click(within(form).getByLabelText("Web"));
    await userEvent.click(within(form).getByRole("switch", { name: "Fact-check the document" }));
    await userEvent.type(within(form).getByLabelText("Notes (optional)"), "Cite line numbers");
    await userEvent.click(await within(form).findByLabelText(/code-review/));
    await userEvent.click(within(form).getByRole("button", { name: "Ask" }));
    expect(api.createIntake).toHaveBeenCalledWith({
      projectId: "p1",
      title: "How are totals computed?",
      body: "For the audit",
      workKind: "research",
      research: { sources: { code: true, feedbackGraph: true, web: true }, factCheck: false },
      notes: "Cite line numbers",
      skillIds: ["sk1"],
    });
    expect(await screen.findByText(/Added research question/)).toBeTruthy();
  });

  it("disables lessons when the project is not linked and needs at least one source", async () => {
    const api = setup({ getProjectFeedbackGraph: unlinked, createIntake: intake() });
    await chooseKind("Research");
    const form = screen.getByRole("form", { name: "Research question" });
    const lessons = within(form).getByLabelText(
      "Lessons from your feedback history",
    ) as HTMLInputElement;
    await waitFor(() =>
      expect(within(form).getByText(/not linked to a lessons source/)).toBeTruthy(),
    );
    expect(lessons.disabled).toBe(true);
    expect(lessons.checked).toBe(false);
    await userEvent.type(within(form).getByLabelText("Question"), "Q?");
    await userEvent.click(within(form).getByLabelText("Project code"));
    const ask = within(form).getByRole("button", { name: /^Ask/ });
    expect(ask.textContent).toMatch(/Pick at least one source/);
    await userEvent.click(ask);
    expect(api.createIntake).not.toHaveBeenCalled();
    await userEvent.click(within(form).getByLabelText("Project code"));
    await userEvent.click(within(form).getByRole("button", { name: "Ask" }));
    expect(api.createIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        research: { sources: { code: true, feedbackGraph: false, web: false }, factCheck: true },
      }),
    );
    // Unset notes and skills are left out.
    expect(api.createIntake.mock.calls[0]![0]).not.toHaveProperty("notes");
    expect(api.createIntake.mock.calls[0]![0]).not.toHaveProperty("skillIds");
  });

  it("validates the pull request URL on the client", async () => {
    const api = setup();
    await chooseKind("Review a PR");
    const form = screen.getByRole("form", { name: "Review a pull request" });
    const input = within(form).getByLabelText("Pull request URL");
    await userEvent.type(input, "https://gitlab.com/o/r/merge_requests/1");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(within(form).getByText(/not a GitHub pull request URL/)).toBeTruthy();
    const submit = within(form).getByRole("button", { name: /^Import pull request/ });
    expect(submit.textContent).toMatch(/github.com pull request URL/);
    await userEvent.click(submit);
    expect(api.importIntake).not.toHaveBeenCalled();
    expect(PR_URL.test("https://github.com/acme/shop/pull/12")).toBe(true);
    expect(PR_URL.test("https://github.com/acme/shop/pull/12/files")).toBe(true);
    expect(PR_URL.test("https://github.com/acme/shop/issues/12")).toBe(false);
    expect(PR_URL.test("http://github.com/acme/shop/pull/12")).toBe(false);
  });

  it("pre-selects the project's default skills and imports the PR without a project", async () => {
    const api = setup({ importIntake: intake({ workKind: "pr_review", source: "github" }) });
    await chooseKind("Review a PR");
    const form = screen.getByRole("form", { name: "Review a pull request" });
    await waitFor(() =>
      expect((within(form).getByLabelText(/security/) as HTMLInputElement).checked).toBe(true),
    );
    expect((within(form).getByLabelText(/code-review/) as HTMLInputElement).checked).toBe(false);
    await userEvent.type(
      within(form).getByLabelText("Pull request URL"),
      "https://github.com/acme/shop/pull/7",
    );
    await userEvent.type(within(form).getByLabelText("Notes (optional)"), "Focus on CSV escaping");
    await userEvent.click(within(form).getByRole("button", { name: "Import pull request" }));
    expect(api.importIntake).toHaveBeenCalledWith({
      url: "https://github.com/acme/shop/pull/7",
      workKind: "pr_review",
      notes: "Focus on CSV escaping",
      skillIds: ["sk2"],
    });
    expect(await screen.findByText(/Imported pull request/)).toBeTruthy();
  });

  it("asks for the project when the server answers project_required", async () => {
    const other = { id: "p2", name: "Shop", repoPath: "/repo/shop" };
    const api = setup({ importIntake: intake({ projectId: "p2", workKind: "pr_review" }) });
    api.importIntake.mockRejectedValueOnce(
      new ApiError(422, "project_required", "which project?", { candidates: [PROJECT, other] }),
    );
    await chooseKind("Review a PR");
    const form = screen.getByRole("form", { name: "Review a pull request" });
    await userEvent.type(
      within(form).getByLabelText("Pull request URL"),
      "https://github.com/acme/shop/pull/7",
    );
    await userEvent.click(within(form).getByRole("button", { name: "Import pull request" }));
    const picker = await within(form).findByLabelText("Project");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a project…", "Demo", "Shop"]);
    const again = within(form).getByRole("button", { name: /^Import for this project/ });
    expect(again.textContent).toMatch(/Choose the project first/);
    await userEvent.selectOptions(picker, "p2");
    await userEvent.click(within(form).getByRole("button", { name: "Import for this project" }));
    expect(api.importIntake).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "https://github.com/acme/shop/pull/7", projectId: "p2" }),
    );
    expect(
      await screen.findByText(/Imported pull request "Add CSV" to another project/),
    ).toBeTruthy();
    expect(within(form).queryByLabelText("Project")).toBeNull();
  });

  it("shows kind badges and degrades unknown kinds to Other", async () => {
    const odd = intake({
      id: "i3",
      workKind: "translation",
      display: { title: "Odd one", body: "" },
    });
    setup({
      listIntakes: [
        intake(),
        intake({ id: "i2", workKind: "research", display: { title: "Why slow?", body: "" } }),
        odd,
      ],
      getIntake: { intake: odd, comments: [] },
    });
    const list = await screen.findByRole("list", { name: "Inbox items" });
    expect(within(list).getByText("Research")).toBeTruthy();
    expect(within(list).getByText("Change")).toBeTruthy();
    expect(within(list).getByText("Other")).toBeTruthy();
    await userEvent.click(within(list).getByRole("button", { name: /Odd one/ }));
    const detail = await screen.findByRole("article", { name: "Intake detail" });
    expect(within(detail).getByText("Other")).toBeTruthy();
  });

  it("shows research settings and notes on a research item", async () => {
    const rec = intake({
      workKind: "research",
      research: { sources: { code: true, feedbackGraph: false, web: true }, factCheck: false },
      notes: "Cite tests",
      skillIds: ["sk1"],
    });
    setup({ listIntakes: [rec], getIntake: { intake: rec, comments: [] } });
    await userEvent.click(await screen.findByRole("button", { name: /Add CSV/ }));
    const detail = await screen.findByRole("article", { name: "Intake detail" });
    expect(within(detail).getByText("Project code, Web")).toBeTruthy();
    expect(within(detail).getByText("Off")).toBeTruthy();
    expect(within(detail).getByText("Cite tests")).toBeTruthy();
  });

  it.each([
    [{ ghInstalled: false }, /needs the GitHub CLI \(gh\)/],
    [{ enabled: false }, /turned off in settings/],
    [{ localOnly: true }, /local-only mode is on/],
  ])("disables Review a PR when GitHub is unavailable (%o)", async (patch, reason) => {
    setup({
      githubStatus: {
        enabled: true,
        configured: true,
        ghInstalled: true,
        localOnly: false,
        ...patch,
      },
    });
    const radio = await screen.findByRole("radio", { name: "Review a PR" });
    await waitFor(() => expect(radio.hasAttribute("disabled")).toBe(true));
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Review a pull request" })).toBeNull();
  });

  it("shows the pull request facts on a PR intake", async () => {
    const rec = intake({
      source: "github",
      workKind: "pr_review",
      externalUrl: "https://github.com/acme/shop/pull/7",
      pullRequest: {
        owner: "acme",
        repo: "shop",
        number: 7,
        url: "https://github.com/acme/shop/pull/7",
        author: "octo",
        state: "OPEN",
        baseRef: "main",
        baseSha: "1".repeat(40),
        headRef: "csv",
        headSha: "2".repeat(40),
        isCrossRepository: true,
        additions: 10,
        deletions: 2,
        changedFiles: 3,
      },
    });
    setup({ listIntakes: [rec], getIntake: { intake: rec, comments: [] } });
    await userEvent.click(await screen.findByRole("button", { name: /Add CSV/ }));
    const detail = await screen.findByRole("article", { name: "Intake detail" });
    expect(within(detail).getByText("GitHub")).toBeTruthy();
    expect(within(detail).getByText("PR review")).toBeTruthy();
    expect(within(detail).getByText("csv → main (from a fork)")).toBeTruthy();
    expect(within(detail).getByText("3 files, +10 −2")).toBeTruthy();
    expect(
      within(detail)
        .getByRole("link", { name: /acme\/shop#7/ })
        .getAttribute("target"),
    ).toBe("_blank");
  });
});
