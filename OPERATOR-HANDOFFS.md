# Follow a request through the factory

Start in the selected project's **Pipeline** in Heimdall. Follow the intake to its spec, plan, run, and delivery. A Sindri **run** and its Mimir **mission** describe the same execution. A single mission can have several tasks, attempts, and agent sessions. Use the run to understand the overall outcome and the task to diagnose one attempt.

## Following the greeting bug

In `hello-factory`, `GET /greet` returned `Hello, null!` when the caller omitted a name. Follow the same change from three places.

1. In the project's **Autonomy** screen, the reviewer accepts the default greeting and records why a caller may omit the name. While the worker is building, another accepted choice can still join this delivery.
2. In **Activity**, open **Verification requested project decisions**, then **Project decisions confirmed**. The first event sets the cutoff. If the confirmation is missing, check the coordinator's connection to the mission. Once a test finishes, open its event for the result and the originating task.
3. In **Deliveries**, open the verified patch. It contains the greeting fix and the accepted entries in `SPEC.md`. If a reviewer changes the rule after verification starts, the next change carries the reversal and its rationale. The first delivery still shows exactly what passed.

## Who acts next?

| Interaction | What has happened | Who acts next and where to look |
| --- | --- | --- |
| Install and start | The Mac manager launched the local services. Selecting a worker component also makes its simulator available. | Check service health in the companion. If startup stalls, open the indicated service log. Start workers separately when the run needs them. |
| Select a project and capture work | An intake belongs to the selected repository. A saved intake can exist before a spec or run does. | In Sindri's Inbox, open the item and draft the spec. Check the project and work kind before continuing. |
| Draft and answer questions | The Director has produced a versioned spec. Blocking questions keep it in review. | Open the spec in Sindri. Answer each blocking question, read the resulting version, and approve the version you intend to build. |
| Propose a project decision | A coordinator or operator has recorded a choice and rationale. The proposal is available for review in this project's Autonomy screen. | An operator accepts or rejects it. To change an accepted choice, propose its replacement and link the original. The history retains both decisions. |
| Review a plan | The planner has selected tasks, dependencies, and checks. Approval authorizes the plan. | Inspect the checks and budget, approve, then execute. If the plan already ran, open the existing run to see the outcome. |
| Dispatch and run | Sindri submitted the mission and Mimir assigned tasks to crews. Each writable task works in an isolated checkout. | Open the run, then the task or session in Mimir. A queued dependency can hold a task before an agent starts. |
| Wait for a worker or reconnect | A task can wait for runtime capacity or for an agent to become available. A reconnect can open a new session. | Check the task's recorded reason and worker history before retrying. Fleet distinguishes a successful empty inventory from a lost connection and labels the last successful observation. Open the worker dashboard for the worker and the Mimir task for its recovery. |
| Request permission or exceed budget | Policy paused a specific action, or a crew reached its budget. A retry alone cannot grant permission or raise a limit. | Open the approval or budget record. An operator decides the action or adjusts the budget. Then check the task's current state. |
| Retry, skip, replan or abort | An attempt failed or escalated. Its evidence remains attached to that attempt. | In Needs you, inspect the failure before choosing. Retry starts another attempt. Replan requires a revised, approved plan. Skip and abort affect downstream work. |
| Verify a change | Brokkr checked the worktree. Sindri evaluates the evidence against the plan's gates. A single passing check can coexist with a failed gate. | Open the test result, gate or reviewer finding. Check which requirement it covers and request a repair when it fails. |
| Deliver code | The ordinary change patch contains the verified file changes and eligible project decision entries. | Review the patch and apply it against the recorded base. Compare the resulting files and test output. A later accepted decision is picked up by the next change run. |
| Deliver research or a plan | A document and its evidence are ready for a decision. A revision may supersede an earlier document. | Read the findings in Deliveries and accept, reject or request a revision. Consult the document's decision when interpreting a finished run. |
| Deliver a PR review | The factory prepared a draft against the supplied pull request. | Inspect the draft, edit it, preview the exact review, and use the posting approval when ready. |
| Inspect from the editor | Hulder and Bifrost expose the local source records. Inspection can show a task even when the current editor workspace is elsewhere. | Open the task worktree for files, or open Heimdall for approval, stop and retry controls. |
| Reconstruct an earlier outcome | Activity records what services observed at the time. A later acceptance, retry or rollback may have changed the current state. | Filter Activity by mission or event category. Open an event for its reason, recorded transition and related record. Use the project decision history for long-lived choices. |

## Controls outside a ticket

| When you need to… | Where to look | How to tell what happened |
| --- | --- | --- |
| Sign in or authorize a change | Use the companion's access codes or those from the source launcher. Heimdall operator controls and the Sindri approval session have separate unlock steps. | A locked control explains the missing permission. After pairing, review the pending action and its target before confirming. |
| Understand an operator command | Open the command confirmation for the selected record. It shows the target, request and reason. | A source confirmation means the service accepted the request. The run, mission or worker can still be processing it. Inspect command history and the current record if the reply times out. |
| Find project context or change its checks | Open the project's settings in Sindri for the repository index, execution profile, skills and guidance. | Check the repository path, bootstrap result and configured commands. An approved plan keeps its own task and check configuration. |
| Inspect or steer a live agent | Open the task and its current session in Mimir or Heimdall. A crew groups workers, a session is one launch, and a task can outlive that session. | Use the transcript and session state for the current attempt. Inspect earlier attempts in Activity when a retry or reconnect changes the session. |
| Adjust scheduling or worker availability | A mission pause, crew pause, and fleet drain act on different records. Read the target in the confirmation. | Check the record you changed, followed by the queued task. A paused mission stops new scheduling and may still have an agent already running. |
| Follow alerts and evidence | Open a notification, then the linked task, gate, budget, approval or delivery. Use Activity for the dated observation. | Compare the event time with the current record. Missing evidence, a failed command and a reviewer requesting changes call for different responses. |
| Understand autonomy | The Steward log records individual recommendations, operator changes and later outcomes. The project decision log records design choices and their rationale across tickets. | Open the entry to see its status and history. A proposed replacement becomes effective upon acceptance. |
| Hide or recover records | Use the project archive controls in Heimdall or remove and restore a finished run in the supported bundle. Use Sindri settings for project data export and deletion. | Archiving changes what Heimdall shows. Deleting project data in Sindri is a separate action that removes its stored history. |
| Update or recover the installation | Open the companion's release status for downloadable bundles. Check the release feed result and compatible version. | Use the manager's health check after installation. If an activation was interrupted, use Recover update. Manual rollback restores the earlier code and data backup. |

## What passes into a repository

For a change run, the first writable task that is ready for verification asks Sindri for the project's accepted decisions. You can follow the request and confirmation in Activity. Sindri freezes the choices accepted by that point. Before running the checks, Mimir adds any missing entries to the **Decision log** section of the worktree's `SPEC.md`. The same entries travel through retries, verification, and patch export. Human-written prose and past entries stay in place. Decisions accepted after that verification request are eligible for the next change run. Research, plan documents, and review drafts follow their own delivery paths.

The project log gives the date, decision, and reason. Proposal discussions, internal sources, and approval identities stay in the private project history. A project that uses this factory can describe its decisions entirely in its own terms.

For a hands-on walkthrough use the [hello-factory example](https://github.com/ChaosDeSelva/hello-factory) and the [ticket-to-delivery guide](work/ecosystem/factory-docs/content/ticket-to-delivery.md).

## Interaction audit, 2026-11-18

| Where context was lost | Change and verification |
| --- | --- |
| Startup or update showed the wrong outcome | The companion distinguishes slow sign-in, failed sign-in, unavailable workers, failed release checks and already-installed releases. The manager and launcher tests exercise these states with independent service and authentication responses. |
| A project change could reach a different verification setup after installation | The managed Brokkr CLI now ships the built-in checks. A package test extracts the production ZIP and compares harness names, versions and content digests against the source CLI. |
| An old choice disappeared or stopped receiving outcomes | Sindri pages through the Steward history and rotates its background outcome checks. The project journal shows the owner, source, rationale, disposition and any reversal. A two-delivery test checks that project history survives a retry and remains scoped to its repository. |
| An event showed just a type and an ID | Heimdall's Activity view explains observed results, retries, evidence and approvals. The event inspector opens the related task, run, mission or approval when available. The browser workflow follows an event into its originating task. |
| A reversible decision appeared impossible to undo | Heimdall now offers rollback for reversible operator-accepted, edited and automatically applied decisions. The current decision state and operator permissions determine whether the action is available. |
| Following a link could open the wrong installation | Heimdall's app switcher, project decision journal and review links use its configured service origins. The native editor, worker dashboard and task helper use configured factory ports. The packaged services are exercised on separate, non-default ports. |
| A retry could fail before the agent started | Mimir now registers the worktree before claiming its task branch, so a failed registration leaves the branch available for retry. The Git suite checks concurrent task starts against one repository. |
| Long decision histories could overwhelm the run or dashboard | The mission carries a project-specific reference to the accepted history. Verification follows it to the same entries on each retry. Open the project journal to review the choices behind a patch. |
| A signed bundle could retain build-machine details | The packager drops test logs and package-manager metadata, uses portable dependency paths, and the companion build checks its embedded manager for local paths. The release test extracts and runs the local package. |
