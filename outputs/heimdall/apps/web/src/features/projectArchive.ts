// Archiving and restoring a project, free of React so node --test covers it.
import { projectAliases, projectKey } from "./workflowState.ts";
type R = Record<string, any>;

/**
 * Archives or restores `project` in the saved preferences. A project may carry Mimir's and
 * Sindri's IDs; restoring clears every alias, archiving adds one. The success message, closing the
 * dialog and switching away from an archived selection follow only a save that went through.
 */
export async function changeArchive(
  project: R,
  archive: boolean,
  ctx: {
    archived: string[];
    sindriProjects: R[];
    allProjects: R[];
    filter: string;
    save: (value: R) => Promise<boolean>;
    selectAll: () => void;
    done: (message: string) => void;
  },
): Promise<boolean> {
  const aliases = projectAliases(project, ctx.sindriProjects);
  const next = archive
    ? [...new Set([...ctx.archived, project.id])]
    : ctx.archived.filter((value) => !aliases.includes(value));
  if (!(await ctx.save({ archivedProjects: next }))) return false;
  if (
    archive &&
    aliases.some((alias) =>
      ctx.allProjects.some(
        (p) => p.id === alias && projectKey(p) === ctx.filter,
      ),
    )
  )
    ctx.selectAll();
  ctx.done(
    archive
      ? "Project archived. Files and history preserved."
      : "Project restored.",
  );
  return true;
}
