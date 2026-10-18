# Concepts

**Project.** A local git repository registered by absolute path. Bootstrap indexes its README, docs, ADRs, manifests, build scripts and a depth limited structure listing into chunks that search can cite. Secret files, binaries, files over 1 MiB and symlink escapes are skipped and reported.

**Intake.** A request that enters the system: manual text, or a read only snapshot of a Jira or Linear issue and its comments. Intake text is untrusted data. The UI shows a sanitized `display` view; the raw snapshot is not served.

**Director.** The LLM backed component that classifies a request, retrieves project context and drafts a spec through a provider neutral interface. Output is advisory and validated. It asks only blocking questions. Every call is recorded in `director_runs`.

**Spec.** A versioned document with structured sections whose claims cite sources. Status flows draft, review, approved. Revising creates a new version; approving one supersedes its predecessor. Approval is refused while blocking questions remain. An approved version is immutable.

**Knowledge.** Sourced claims about the project with a confidence. Entries are retracted or superseded, never edited; history is kept.

**Evidence.** Immutable records of what happened in a run (exit codes, test logs, diffs, Brokkr verification reports). Completion is judged on evidence only. See ADR-005 and ADR-006.

**Plan and task DAG.** After approval the planner turns a spec into a dependency aware task graph and selects harnesses. Built as a library (`packages/planner`); not yet exposed by the server.

**Harness.** A versioned definition of how a kind of work is done and verified. Owned by Brokkr; Sindri selects by id and exact version. The Brokkr SDK is not wired yet (ADR-004).

**Execution and delivery.** Sindri submits missions to Mimir through `@mimir/sdk` and reconciles Mimir's events (`packages/mimir-client`, `packages/delivery`). Quality gates, the delivery report and knowledge write back are task S6, in progress.

**Local only mode.** The default. No connector fetches and no remote provider. See ADR-007.
