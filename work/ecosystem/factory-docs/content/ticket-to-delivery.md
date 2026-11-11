# From ticket to delivery

This is the whole path of one piece of work, with the screen you use at each step. Screen names follow the redesigned layout: project tabs in the top bar (in Sindri grouped **Intake**, **Define**, **Execute**, **Ship & learn**; in Heimdall **Watch** and **Decide**), global things in the fixed bottom bar.

> Screen names in this page come from one table in the docs package (`src/navigation.ts`). When a screen is renamed or moved, change it there and this page follows.

Before you start, you need three things from the terminal that started the factory: the **access token** (to sign in), the **approval pairing code** (to approve in Sindri), and for Heimdall its own **access token** and **operator code**. See [Sign in and unlock](/docs/operator-guide#sign-in-and-unlock).

## 0. Pick or add the project

1. In the top bar, pick the project in the project picker. Every top-bar tab now shows only this project.
2. New repository? Open {{screen:sindri.projects}}, create the project with the repository's absolute path, then **Bootstrap** it so the Director can cite its README, docs and build files. To check what was indexed, search it in {{screenlink:sindri.project-settings}} → _Repository & index_.
3. Not a Node project, or your checks are not `pnpm` scripts? Set the checks in {{screenlink:sindri.project-settings}} → _Execution profile_ before you plan. Plans use the checks that existed when they were proposed.

## 1. Capture the request: {{screen:sindri.inbox}}

- Type the idea under _New idea or ticket_, or import a tracker issue under _Import a ticket_ (needs local-only mode off).
- Open the item and choose **Draft spec from this**.

Status: the intake is **Up to date**. If the tracker issue changes later it shows [Update available](/docs/statuses#update-available-intake-sync-status) and you choose which copy to keep.

## 2. Draft the spec: {{screen:sindri.director}}

- The Director reads the request and the project index and writes a draft spec. Drafting can take a few minutes.
- It lists **open questions**. Answer every **blocking** one. Each answer makes a new draft version.
- The steward may already have a recommended answer; you can use it or write your own.

Status: spec [Draft](/docs/statuses#draft-spec-status).

## 3. Review and approve the spec: {{screen:sindri.specs}}

- Read the problem, goals, constraints, acceptance criteria and risks. Fix anything with _Edit specification_ (saves a new version).
- **Submit for review**, then **Approve**. Approving asks for the pairing code once per session.
- If the spec says _Untrusted instructions detected_, read what was flagged and tick the acknowledgement before approving.

Status: Draft → [In review](/docs/statuses#in-review-spec-status) → [Approved](/docs/statuses#approved-spec-status). Approved versions never change.

## 4. Plan the work: {{screen:sindri.plans}}

- **Propose plan** from the approved spec. Sindri picks harnesses (frontend, backend, QA, docs) and shows the _Dry-run order_, the _Tasks_ and the _Task budgets_.
- Adjust budgets if needed (_Save budgets as new draft_).
- **Submit for review**, then **Approve plan** (pairing code).
- Press **Execute plan**. This creates the run and sends a mission to Mimir.

Status: plan Draft → In review → [Approved](/docs/statuses#approved-plan-status).

## 5. Watch the run: {{screen:sindri.runs}}

- The run list shows each run of this project. Open one for {{screen:sindri.run-detail}}: tasks, live events, gates, and a link to the mission in Mimir.
- Normal path: [Starting](/docs/statuses#starting-run-status) → [Running](/docs/statuses#running-run-status) → [Verified, awaiting review](/docs/statuses#verified-awaiting-review-run-status).
- Want more detail? Mimir's {{screen:mimir.mission-detail}} shows the task graph, each agent, files, tests and costs. Heimdall's {{screen:heimdall.pipeline}} and {{screen:heimdall.execution-graph}} show the same work across projects.

## 6. Answer what the run asks: {{screen:sindri.needs-you}}

A run stops at [Needs you](/docs/statuses#needs-you-run-status) when something waits on a human:

| You see                              | What to do                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Approvals awaiting you_             | An agent wants to run something policy does not allow on its own. **Approve** or **Reject** (pairing code).                                                                                       |
| _Escalations_                        | A task gave up. Choose **retry**, **skip**, **replan** or **abort** and give a reason. See [Escalations](/docs/operator-guide#escalations).                                                       |
| _Budget used up_                     | A crew ran out of tokens. Press **Raise budget** in Mimir or Heimdall (the alert links to both), then answer **retry** if still open. See [Budget blocked](/docs/troubleshooting#budget-blocked). |
| _Gate failures_, _Reviewer findings_ | Why a task's quality gate failed. Usually fixed by a retry or by requesting changes later.                                                                                                        |

The run continues by itself once nothing is open. If you choose replan, the run shows [Replan requested](/docs/statuses#replan-requested-run-status): revise the plan in {{screen:sindri.plans}}, approve it and execute it; the old run closes as cancelled.

## 7. Review the delivery: {{screen:sindri.deliveries}}

When the run is verified, a delivery appears. Open it for {{screen:sindri.delivery-detail}}:

- **Requirements**: each acceptance criterion as Satisfied, Not satisfied or Unverified, with evidence.
- **Tasks and quality gates**, **Tests**, **Changed files**, **Review findings**, **Limitations**, **Rollback**.
- **Trace**: ticket → spec version → plan version → mission → tasks → events and artifacts.

Status: delivery [Ready to export](/docs/statuses#ready-to-export-delivery-status).

## 8. Export and apply

- On the delivery, press **Export local result**. It needs passing gates and your approval (pairing code); if asked, press **Approve local export** for each task.
- Copy or download the **patch** and run the shown _apply_ command in your project folder. The _undo_ command reverses it.
- Merging and pushing is up to you. Nothing is merged or deployed automatically.

Status: [Exported, not merged](/docs/statuses#exported-not-merged-delivery-status).

## 9. Not right? Request changes

On the delivery, describe what should change under **Request changes**. Sindri drafts a new spec that continues from this delivery's verified result. Approve it and its plan, execute, and you get a new delivery with a **follow-up patch** containing only the new changes. See [Request changes](/docs/operator-guide#request-changes).

## 10. Learn: {{screen:sindri.knowledge}} and {{screen:sindri.autonomy}}

- After export, generate **knowledge proposals** from the delivery's evidence and accept the ones that are true. Later drafts and plans use them.
- {{screen:sindri.autonomy}} shows what the steward recommended along the way and how often you agreed. Add notes to steer it.

## Where else this shows up

| Step | Heimdall                                                                                                                          | Mimir                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1-4  | {{screen:heimdall.new-work}} walks the same steps                                                                                 | –                                                                                  |
| 5    | {{screen:heimdall.overview}}, {{screen:heimdall.pipeline}}, {{screen:heimdall.crews-agents}}, {{screen:heimdall.execution-graph}} | {{screen:mimir.missions}}, {{screen:mimir.mission-detail}}, {{screen:mimir.crews}} |
| 6    | {{screen:heimdall.overview}} → _Needs you_, {{screen:heimdall.quality-approvals}} (both with **Raise budget**)                    | {{screen:mimir.reviews}}; **Raise budget** on {{screen:mimir.mission-detail}}      |
| 7-8  | {{screen:heimdall.quality-approvals}} (exports, patch download)                                                                   | –                                                                                  |
| 10   | {{screen:heimdall.autonomy}}                                                                                                      | –                                                                                  |
