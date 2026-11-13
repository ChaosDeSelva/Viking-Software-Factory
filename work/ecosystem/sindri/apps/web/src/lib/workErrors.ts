import { ApiError } from "../api/client.js";

const MIRROR_REASONS: Record<string, string> = {
  clone_failed: "cloning the repository failed (check your gh login and access to the repository)",
  fetch_failed: "fetching the pull request's commits failed",
  commit_missing: "the pull request's base or head commit could not be found",
  invalid_pr: "the stored pull request is incomplete; import it again",
  no_data_dir: "the server has no data directory for review clones",
};

/** Clear text for errors starting a run of a PR review plan; other errors pass through. */
export function explainStartError(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  if (err.code === "mirror_failed") {
    const reason = (err.details as { reason?: string } | undefined)?.reason ?? "";
    return new Error(
      `Could not prepare Sindri's review clone of the pull request: ${MIRROR_REASONS[reason] ?? (reason || err.message)}.`,
    );
  }
  if (err.code === "local_only")
    return new Error(
      "Local-only mode is on: a pull request review needs GitHub. Turn local-only mode off in Settings to run it.",
    );
  return err;
}
