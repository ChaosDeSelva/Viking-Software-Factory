import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The top-bar project picker: a combobox trigger named `Project: <current>`. */
export const projectPicker = () => screen.getByRole("button", { name: /^Project: / });

/** Opens the project picker and chooses the project with this name. */
export async function pickProject(name: string) {
  await userEvent.click(projectPicker());
  const list = await screen.findByRole("listbox", { name: "Project" });
  await userEvent.click(within(list).getByRole("option", { name: new RegExp(`^${esc(name)}`) }));
}

export const projectNav = () => screen.getByRole("navigation", { name: "Project pages" });
export const globalNav = () => screen.getByRole("navigation", { name: "Global pages" });
export const bottomBar = () => screen.getByRole("contentinfo", { name: "Status and global" });

/** A top tab or global link by its visible label (the label may be followed by a count). */
export const tab = (label: string) =>
  within(projectNav()).getByRole("link", { name: new RegExp(`^${esc(label)}( ?\\d+)?$`) });
export const globalLink = (label: string) =>
  within(globalNav()).getByRole("link", { name: new RegExp(`^${esc(label)}$`) });
