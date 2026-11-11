// What every page needs from the app, without threading props through each screen.
import { createContext, useContext } from "react";
import type { Api, Propose, R } from "../lib/api";
import type { Scope } from "../features/scope";
import type { PageId } from "../lib/router";

export interface Session {
  operator?: boolean;
  pairedSindri?: boolean;
}

export interface Heimdall {
  api: Api;
  /** Heimdall's own session: operator unlock and Sindri pairing. */
  session: Session;
  /** Reads /api/session again (after unlock or pairing). */
  refreshSession: () => Promise<void>;
  /** The latest snapshot; null until the first one arrives. */
  state: R | null;
  /** The snapshot narrowed to the selected project (or all projects). */
  scope: Scope;
  /** Name of the selected project, or null for all projects. */
  projectName: string | null;
  /** Selects a project by projectKey ("all" for every project). */
  setProject: (key: string) => void;
  /** Opens the confirmation dialog for an operator command (it asks for the audit reason). */
  propose: Propose;
  /** Opens a record in the inspector drawer (`?inspect=kind:id`, so Back closes it). */
  open: (kind: string, row: R) => void;
  /** Changes after every confirmed command, so pages re-read what they fetched themselves. */
  reloadKey: number;
  /** The answer to the last confirmed project.profile command, for the profile form. */
  profileSaved: { id: string; harness: R | null } | null;
  /** Shows a message: errors persist until dismissed, the rest fade. */
  notify: (
    message: string,
    tone?: "info" | "success" | "warning" | "danger",
  ) => void;
  /** Merges and saves Heimdall's preferences on this Mac; false (after its own toast) when it failed. */
  savePreferences: (value: R) => Promise<boolean>;
  /** Link to a page, keeping the selected project. */
  href: (
    page: PageId,
    params?: Record<string, string | null | undefined>,
    sub?: string,
  ) => string;
}

export const HeimdallContext = createContext<Heimdall | null>(null);
export function useHeimdall(): Heimdall {
  const value = useContext(HeimdallContext);
  if (!value) throw Error("useHeimdall outside the app");
  return value;
}
