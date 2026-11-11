# Concepts

**Project.** A local git repository registered by absolute path. Bootstrap indexes its README, docs, ADRs, manifests, build scripts and a depth limited structure listing into chunks that search can cite. Secret files, binaries, files over 1 MiB and symlink escapes are skipped and reported.

**Intake.** A request that enters the system: manual text, or a read only snapshot of a Jira or Linear issue and its comments. Intake text is untrusted data. The UI shows a sanitized `display` view; the raw snapshot is not served.

**Director.** The LLM backed component that classifies a request, retrieves project context and drafts a spec through a provider neutral interface. Output is advisory and validated. It asks only blocking questions. Every call is recorded in `director_runs`.

**Spec.** A versioned document with structured sections whose claims cite sources. Status flows draft, review, approved. Revising creates a new version; approving one supersedes its predecessor. Approval is refused while blocking questions remain. An approved version is immutable.

**Knowledge.** Sourced claims about the project with a confidence. Entries are retracted or superseded, never edited; history is kept.

**Evidence.** Immutable records of what happened in a run (exit codes, test logs, diffs, Brokkr verification reports). Completion is judged on evidence only. See ADR-005 and ADR-006.

**Plan and task DAG.** After approval the planner turns a spec into a dependency aware task graph and selects harnesses. Built as a library (`packages/planner`) and served under `/v1/plans`. Implementation tasks without a dependency between them run in parallel from the same base and cannot see each other's changes. The frontend task therefore depends on the backend task when a frontend acceptance criterion calls a URL path that another, backend criterion names. For example, a gateway test of `GET /api/greeter/farewell` needs the greeter's new `/farewell`. The plan model may add further dependencies between implementation tasks when one needs the other's change. The plan is rejected if they form a cycle. A dependent task starts from its dependency's verified result.

**Budgets.** Each plan task has a token budget. The defaults are per role, in `ROLE_TOKEN_BUDGETS` in `packages/planner`: 1M for an implementer, 400k for a reviewer, security reviewer, lead or investigator, 500k for QA and 300k for docs. Each covers all attempts of the task, and the project's `maxTaskTokens` caps it. Sindri sends Mimir one hard budget per crew: the sum of the budgets of the crew's tasks. Mimir warns at 80% (`budget.warning`). At 100%, Mimir stops dispatching the crew's tasks and parks them `blocked` with `budget_exceeded`. It does the same with `budget_uncertain` when it cannot measure usage. Sindri escalates each parked task to a human as `ask`, whatever the plan's escalation says. The escalation goes to the inbox as a `budget_exceeded` item, and its reason gives the crew budget's numbers (`tokens used/limit`). To resolve it, raise the crew budget in Mimir, which then returns the task to `ready`, and answer `retry`. A retry that comes before Mimir has released the task is refused, and the escalation stays open. If Mimir releases the task first, Sindri closes the escalation itself. A budget retry uses no extra attempt. `skip`, `replan` and `abort` work as for any escalation.

**Harness.** A versioned definition of how a kind of work is done and verified. Owned by Brokkr; Sindri selects by id and exact version. With Brokkr enabled, harnesses are resolved through the Brokkr SDK; otherwise Sindri uses built-in fixtures (ADR-004).

**Execution and delivery.** Sindri submits missions to Mimir through `@mimir/sdk` and reconciles Mimir's events (`packages/mimir-client`, `packages/delivery`). Quality gates, the delivery report and knowledge write back are task S6, in progress.

**Local only mode.** The default. No connector fetches and no remote provider. See ADR-007.
