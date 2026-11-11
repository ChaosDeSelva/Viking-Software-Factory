import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import type { ExecutionProfile } from "../api/types.js";
import { NoticeRegion } from "../components/Layout.js";
import { mockApi, PROJECT, renderWithStore } from "../test/utils.js";
import { ProjectSettingsScreen } from "./ProjectSettingsScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <ProjectSettingsScreen />
  </>
);
const value = (el: HTMLElement) => (el as HTMLInputElement).value;
const type = (el: HTMLElement, text: string) => fireEvent.change(el, { target: { value: text } });
const form = () => screen.findByRole("form", { name: "Execution profile" });

const GO: ExecutionProfile = {
  checks: [
    {
      id: "lint",
      title: "make lint",
      command: ["make", "lint"],
      cwd: "services/api",
      timeoutSeconds: 900,
    },
    { id: "script", command: ["sh", "run tests.sh"], required: false },
  ],
  network: "allow",
  env: { GOCACHE: "/Users/me/cache/go-build" },
  pathPrepend: ["/Users/me/shims", "/opt/go/bin"],
  codexSandbox: { writableRoots: ["/Users/me/cache/go-build"], networkAccess: true },
  verificationTimeoutMs: 2_700_000,
};

describe("Project settings: execution profile", () => {
  it("loads and shows the selected project's profile", async () => {
    const api = mockApi({ listProjects: [PROJECT], getProfile: GO });
    renderWithStore(ui, api);
    const f = await form();
    expect(api.getProfile).toHaveBeenCalledWith("p1");
    expect(screen.getByRole("heading", { name: "Execution profile" })).toBeTruthy();
    const first = within(f).getByRole("group", { name: /Check 1/ });
    expect(value(within(first).getByLabelText("Id"))).toBe("lint");
    expect(value(within(first).getByLabelText("Command"))).toBe("make lint");
    expect(first.textContent).toContain('Will run: ["make","lint"]');
    expect(value(within(first).getByLabelText("Working directory"))).toBe("services/api");
    expect(value(within(first).getByLabelText("Timeout (seconds)"))).toBe("900");
    expect((within(first).getByLabelText("Required") as HTMLInputElement).checked).toBe(true);
    const second = within(f).getByRole("group", { name: /Check 2/ });
    expect(value(within(second).getByLabelText("Command"))).toBe("sh 'run tests.sh'");
    expect(second.textContent).toContain('Will run: ["sh","run tests.sh"]');
    expect((within(second).getByLabelText("Required") as HTMLInputElement).checked).toBe(false);
    expect(value(within(f).getByLabelText("Network for checks"))).toBe("allow");
    expect(value(within(f).getByLabelText("Variable 1 name"))).toBe("GOCACHE");
    expect(value(within(f).getByLabelText("Variable 1 value"))).toBe("/Users/me/cache/go-build");
    expect(value(within(f).getByLabelText("Directories put first on PATH"))).toBe(
      "/Users/me/shims\n/opt/go/bin",
    );
    expect(value(within(f).getByLabelText("Writable directories"))).toBe(
      "/Users/me/cache/go-build",
    );
    expect((within(f).getByLabelText("Allow network access") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(f.textContent).toMatch(/lets commands run by the agent reach the\s+network/);
    expect(value(within(f).getByLabelText("Verification timeout (minutes)"))).toBe("45");
    expect(within(f).queryByText(/No checks set/)).toBeNull();
  });

  it("says that built-in checks are used when the profile has no checks", async () => {
    renderWithStore(ui, mockApi({ listProjects: [PROJECT], getProfile: {} }));
    expect(
      within(await form()).getByText(
        "No checks set: plans use the built-in checks, which assume a Node project.",
      ),
    ).toBeTruthy();
  });

  it("adds a check and saves exactly the profile the form describes", async () => {
    const harness = { name: "sindri-demo-1a2b3c4d", version: "1.0.0" };
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: {},
      putProfile: (_id: string, profile: ExecutionProfile) => Promise.resolve({ profile, harness }),
    });
    renderWithStore(ui, api);
    const f = await form();
    await userEvent.click(within(f).getByRole("button", { name: "Add check" }));
    const check = within(f).getByRole("group", { name: /Check 1/ });
    expect(within(f).queryByText(/No checks set/)).toBeNull();
    type(within(check).getByLabelText("Id"), "test");
    type(within(check).getByLabelText("Command"), `pytest -k "not slow"  tests`);
    expect(check.textContent).toContain('Will run: ["pytest","-k","not slow","tests"]');
    expect(check.textContent).toMatch(/Run directly, not through a shell/);
    type(within(check).getByLabelText("Working directory"), "services/api");
    type(within(check).getByLabelText("Timeout (seconds)"), "900");
    await userEvent.click(within(f).getByRole("button", { name: "Add variable" }));
    type(within(f).getByLabelText("Variable 1 name"), "PIP_CACHE_DIR");
    type(within(f).getByLabelText("Variable 1 value"), "/Users/me/cache/pip");
    type(
      within(f).getByLabelText("Directories put first on PATH"),
      "/Users/me/shims\n\n  /opt/python/bin  \n",
    );
    type(within(f).getByLabelText("Verification timeout (minutes)"), "45");
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));

    expect(api.putProfile.mock.calls).toStrictEqual([
      [
        "p1",
        {
          checks: [
            {
              id: "test",
              command: ["pytest", "-k", "not slow", "tests"],
              cwd: "services/api",
              timeoutSeconds: 900,
            },
          ],
          env: { PIP_CACHE_DIR: "/Users/me/cache/pip" },
          pathPrepend: ["/Users/me/shims", "/opt/python/bin"],
          verificationTimeoutMs: 2_700_000,
        },
      ],
    ]);
    expect((await screen.findByText(/Checks are installed as harness/)).textContent).toBe(
      "Checks are installed as harness sindri-demo-1a2b3c4d",
    );
    expect(screen.getByText(/Execution profile saved/)).toBeTruthy();
    expect(
      value(within(within(f).getByRole("group", { name: /Check 1/ })).getByLabelText("Id")),
    ).toBe("test");
  });

  it("sends the sandbox settings, an optional check and the network choice", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: { checks: [{ id: "lint", command: ["make", "lint"] }] },
      putProfile: (_id: string, profile: ExecutionProfile) =>
        Promise.resolve({ profile, harness: null }),
    });
    renderWithStore(ui, api);
    const f = await form();
    await userEvent.click(within(f).getByRole("button", { name: "Add check" }));
    const extra = within(f).getByRole("group", { name: /Check 2/ });
    type(within(extra).getByLabelText("Id"), "extra");
    type(within(extra).getByLabelText("Command"), "make extra");
    await userEvent.click(within(extra).getByLabelText("Required"));
    await userEvent.selectOptions(within(f).getByLabelText("Network for checks"), "allow");
    type(within(f).getByLabelText("Writable directories"), "/Users/me/cache/a\n/Users/me/cache/b");
    await userEvent.click(within(f).getByLabelText("Allow network access"));
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    expect(api.putProfile.mock.calls).toStrictEqual([
      [
        "p1",
        {
          checks: [
            { id: "lint", command: ["make", "lint"] },
            { id: "extra", command: ["make", "extra"], required: false },
          ],
          network: "allow",
          codexSandbox: {
            writableRoots: ["/Users/me/cache/a", "/Users/me/cache/b"],
            networkAccess: true,
          },
        },
      ],
    ]);
    await screen.findByText(/Execution profile saved/);
    expect(screen.queryByText(/Checks are installed as harness/)).toBeNull();
  });

  it("removes a check", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: GO,
      putProfile: (_id: string, profile: ExecutionProfile) =>
        Promise.resolve({ profile, harness: null }),
    });
    renderWithStore(ui, api);
    const f = await form();
    await userEvent.click(within(f).getByRole("button", { name: "Remove check 2" }));
    await userEvent.click(within(f).getByRole("button", { name: "Remove variable 1" }));
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    const expected: ExecutionProfile = { ...GO, checks: [GO.checks![0]!] };
    delete expected.env;
    expect(api.putProfile.mock.calls).toStrictEqual([["p1", expected]]);
  });

  it("keeps Save disabled until approvals are unlocked", async () => {
    let unlocked = false;
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: GO,
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "local:test/web#aps_1", expiresAt: "" });
      },
    });
    renderWithStore(ui, api);
    const f = await form();
    // Locked: aria-disabled with its reason, so the button stays focusable and explains itself.
    const save = within(f).getByRole("button", { name: /^Save profile/ });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.textContent).toContain("needs the approval pairing code");
    type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    expect(await within(f).findByRole("button", { name: "Save profile" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByLabelText("Approval pairing code")).toBeNull();
  });

  it("shows a 422 from the server and keeps what was typed", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: {},
      putProfile: () =>
        Promise.reject(
          new ApiError(422, "validation_failed", "request validation failed", [
            {
              code: "custom",
              path: ["env", "NODE_OPTIONS"],
              message: "this variable cannot be set from a profile",
            },
          ]),
        ),
    });
    renderWithStore(ui, api);
    const f = await form();
    await userEvent.click(within(f).getByRole("button", { name: "Add variable" }));
    type(within(f).getByLabelText("Variable 1 name"), "NODE_OPTIONS");
    type(within(f).getByLabelText("Variable 1 value"), "--max-old-space-size=4096");
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    const refused = await within(f).findByRole("alert", {
      name: "The server did not accept the profile",
    });
    expect(refused.textContent).toContain(
      "env.NODE_OPTIONS: this variable cannot be set from a profile",
    );
    expect(
      screen.getAllByRole("alert").some((a) => /request validation failed/.test(a.textContent)),
    ).toBe(true);
    expect(value(within(f).getByLabelText("Variable 1 name"))).toBe("NODE_OPTIONS");
    expect(value(within(f).getByLabelText("Variable 1 value"))).toBe("--max-old-space-size=4096");
    expect(within(f).getByRole("button", { name: "Save profile" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("marks obvious mistakes and does not send them", async () => {
    const api = mockApi({ listProjects: [PROJECT], getProfile: {} });
    renderWithStore(ui, api);
    const f = await form();
    await userEvent.click(within(f).getByRole("button", { name: "Add check" }));
    type(within(f).getByLabelText("Directories put first on PATH"), "bin");
    expect(within(f).queryByText("Give the check an id.")).toBeNull();
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    expect(within(f).getByText("Give the check an id.")).toBeTruthy();
    expect(within(f).getByText("Enter the command to run.")).toBeTruthy();
    expect(within(f).getByText("Not an absolute path: bin")).toBeTruthy();
    expect(api.putProfile).not.toHaveBeenCalled();
  });

  it("Reset reloads the saved profile and drops the edits", async () => {
    const api = mockApi({ listProjects: [PROJECT], getProfile: GO });
    renderWithStore(ui, api);
    const f = await form();
    type(within(f).getByLabelText("Verification timeout (minutes)"), "5");
    await userEvent.click(within(f).getByRole("button", { name: "Reset" }));
    expect(value(within(await form()).getByLabelText("Verification timeout (minutes)"))).toBe("45");
    expect(api.getProfile).toHaveBeenCalledTimes(2);
  });
});
