# Sindri screens

Sindri plans the work and prepares the delivery. Top-bar tabs show the selected project, grouped **Intake**, **Define**, **Execute** and **Ship & learn**, with **Project settings** as the gear at the right end (in the page menu on a phone). Bottom-bar pages are global: Projects, Harnesses, Autonomy (all) and Settings. `Alt+1` … `Alt+0` switch between the first ten tabs.

## {{label:sindri.sign-in}}

Paste the access token. Get it with `sindri token show`, or from the terminal that started the factory (_Access token_). If the server says the token was rejected, see [Token rejected](/docs/troubleshooting#token-rejected).

## {{label:sindri.overview}}

The project at a glance. Start here after picking a project.

- Counts that link to their tab: _Inbox_, _Specs in review_, _Plans to approve_, _Active runs_, _Deliveries_.
- _Needs you_: what waits on you right now, each linked to where you act. The full list is in {{screen:sindri.needs-you}}.
- _Recent runs_ of the project.
- _Ask the factory_: the Guide, with suggested questions for the project's state. It answers in plain words and links to the screen where you act; it never acts itself. The same Guide opens from **Ask** in the bottom bar.
- **New idea or ticket** opens {{screen:sindri.inbox}}.

## {{label:sindri.inbox}}

Where requests land. Group: Intake.

- _Kind of work_: **Change** (the default), **Research** or **Review a PR**. Research asks for a question, its sources (project code, lessons from your feedback history, web) and whether to fact-check; Review a PR asks for a GitHub pull request URL and is disabled, with the reason, while `gh` is missing, GitHub pull requests are turned off in {{screen:sindri.settings}}, or local-only mode is on. The **Web** source is disabled while local-only mode is on. Both take optional notes and skills. See [Research questions](/docs/research) and [PR reviews](/docs/pr-reviews).
- _New idea or ticket_: type a request. It becomes an intake.
- _Import a ticket_: paste a tracker URL. Needs a tracker connector on the Sindri server and local-only mode off in {{screen:sindri.settings}}. Nothing is written back to the tracker.
- _Inbox items_: the list, each with a kind badge. Open one for its detail, its _Work details_ (sources, fact-check, skills, the delivery it follows up on) or _Pull request_ (author, branches, size), and comments.
- **Draft spec from this** hands it to the Director.

An imported item can show [Update available](/docs/statuses#update-available-intake-sync-status) or [Conflict](/docs/statuses#conflict-intake-sync-status) when the issue changed in the tracker. Pick which copy to keep.

## {{label:sindri.director}}

The Director drafts a spec. Group: Intake.

- _Ask the Director_: pick an inbox item (or none, to record a new request) and press **Draft spec**. It reads the project index and cites sources. It can take a few minutes.
- _Draft specification_: the result.
- _Open questions_: answer blocking ones here. A recommended answer may be offered.

The Director only drafts. It does not approve anything. For questions about the factory, use **Ask** instead.

## {{label:sindri.specs}}

All specs of the project with their versions. Group: Define.

- Open a spec for its sections, versions, _Compare versions_, open questions and _Review and approval_.
- _Edit specification_ saves a new draft version.
- **Submit for review**, then **Approve** (pairing code). Approval is refused while blocking questions remain.
- _Untrusted instructions detected_ means text in a source looked like instructions to the model. Read it and acknowledge before approving.

Statuses: [Draft](/docs/statuses#draft-spec-status), [In review](/docs/statuses#in-review-spec-status), [Approved](/docs/statuses#approved-spec-status), [Superseded](/docs/statuses#superseded-spec-status).

## {{label:sindri.plans}}

Turn an approved spec into tasks. Group: Define.

- _Propose a plan_: pick the approved spec and press **Propose plan**.
- _Plan detail_: versions, _Dry-run order_, _Tasks_ (objective, role, dependencies, harness and why it was chosen) and _Task budgets_.
- **Submit for review**, **Approve plan** (pairing code), then **Execute plan** to start a run.

A plan is locked to the exact harness versions it was approved with. To use new checks from the execution profile, propose a new plan.

## {{label:sindri.runs}}

Every run of the project. Group: Execute. Each row shows the plan and the run's status. Open one for {{screen:sindri.run-detail}}.

## {{label:sindri.run-detail}}

One run, live.

- Header: the plan, the status, a link to the mission in Mimir, and **Open delivery** once verified. **Cancel run** stops it (Mimir's mission is cancelled too).
- _Approvals awaiting you_: approvals for this run.
- _Tasks_: each task's status, failed attempts, quality gate and a link to the agent session.
- _Events_: what Mimir reported, newest last.
- Notes appear when the run failed, was cancelled, asks for a replan, has escalated tasks, or lost its live connection (_Live updates disconnected — retrying_).

See [run statuses](/docs/statuses#run-status).

## {{label:sindri.needs-you}}

Everything across the project's runs that waits on you. Group: Execute. It replaces the old _Reviews_ tab. The tab shows a count of approvals, escalations and budget alerts.

- _Approvals awaiting you_: approve or reject agent actions (pairing code), or open the run.
- _Escalations_: tasks that gave up. Answer retry, skip, replan or abort with a reason.
- Budget alerts, under the escalations: a task parked on its crew's budget, with used and limit numbers. Sindri cannot raise a budget itself: **Raise it in Mimir** opens the crew in Mimir, **See it in Heimdall** opens the project in Heimdall. Both have a **Raise budget** button. See [Budget blocked](/docs/troubleshooting#budget-blocked).
- _Gate failures_: why a task's quality gate failed.
- _Reviewer findings_: what the independent reviewer reported, by severity.

Gates are checked when a run is verified: Brokkr's verdict first, which is never overridden, then the product gates.

## {{label:sindri.deliveries}}

Verified results of this project's runs. Group: Ship & learn. Each shows its kind: a change, a research document or a PR review. Open one for {{screen:sindri.delivery-detail}}.

## {{label:sindri.delivery-detail}}

One delivery.

- _Report_: requirements with evidence, tasks and gates, summary, tests, changed files, review findings, limitations, rollback.
- _Local delivery_: the delivery summary (copy it), **Export local result**, **Approve local export**, **Re-run quality checks**, then the patch with _apply_ and _undo_ commands. A **follow-up patch** appears after a change request.
- _Request changes_: describe what should change; Sindri drafts a new spec that continues from this result. _Earlier change requests_ links their specs.
- _Trace_: ticket → spec → plan → mission → tasks → events and artifacts.

See [Export a delivery](/docs/operator-guide#export-a-delivery).

A **research** delivery has no patch. Its tabs are _Document_ (the answer with numbered sources, **Copy as Markdown**), _Checks_ (research gates and the fact-check) and _Guidance_; **Accept**, **Reject…** and **Ask a follow-up…** sit in its header. See [Research questions](/docs/research).

A **PR review** delivery has _Review_ (verdict, summary, findings to include, exclude or edit; **Save edits**), _Preview and post_ (exactly what GitHub receives, the leak check, **Post review to GitHub**), _Reviewers_ and _Guidance_. See [PR reviews](/docs/pr-reviews).

## {{label:sindri.knowledge}}

What the project has learned. Group: Ship & learn.

- _Delivery knowledge proposals_: facts suggested from an exported delivery's evidence. Generate, then accept or reject (pairing code).
- _Valid knowledge_: entries in use, with their sources and history. Retract or supersede; entries are never edited.
- _Add knowledge_: add a fact with a source.

## {{label:sindri.autonomy}}

What the steward did for this project. Group: Ship & learn.

- _Decision log_: each recommendation, its status, confidence and outcome. Open one for its inputs and reasoning; accept, change, reject or roll back.
- _Notes for the steward_: plain-language guidance for this project.
- Proposed **guidance** rules learned from your corrections.

Modes and pause live in {{screen:sindri.autonomy-all}}.

## {{label:sindri.project-settings}}

Settings for the selected project: the gear at the right end of the top bar. Five tabs:

- _Execution profile_: checks, check network, environment variables, PATH additions, agent sandbox and verification timeout. See [Execution profile](/docs/glossary#execution-profile).
- _Feedback Graph_: whether lessons are linked (automatically, by you, or not), the lessons in use, and an override of the Feedback Graph project key.
- _Guidance_: standing notes for this project's research and review agents (at most 16 KB) and its default skills. **Save guidance** applies to plans proposed afterwards.
- _Repository & index_: **Bootstrap** the project and search its index (docs, ADRs, manifests); _Repository signals_, what Sindri noticed about the repository; and _Why this harness?_, which explains which harness and skills a plan would pick for a task you describe.
- _Danger zone_: **Delete project data** (index, inbox, specs, knowledge; the repository is not touched). Type the project name to confirm. A project with recorded evidence can only be deleted by also erasing it: tick the box, type `ERASE EVIDENCE` and unlock with the pairing code.

## {{label:sindri.projects}}

Every registered project (global; the project picker is disabled here). Filter the list, **Select** a project to work on it, **Bootstrap** one, or _Create project_ from a name and a local repository path. Open the project picker's _Manage projects…_ to get here. Searching the index and deleting a project's data are in {{screen:sindri.project-settings}}.

## {{label:sindri.harnesses}}

Installed harnesses (global): each one's manifest (task types, required and optional skills) and checks. A banner says whether Brokkr resolved them or Sindri's built-in fixture harnesses are used. Installing, pinning and verifying harnesses is done with the Brokkr command line; those buttons stay disabled here. Why a harness fits a project is in {{screen:sindri.project-settings}} → _Repository & index_.

## {{label:sindri.autonomy-all}}

The steward for every project (global).

- _Steward_: running or paused, and the Feedback Graph connection. **Pause** stops new recommendations; your own decisions still work. Heimdall's {{screen:heimdall.autonomy-all}} has the same pause and resume.
- _Decision types_: the mode per type (Off, Recommend, Automatic) with decided, accuracy, accepted, changed, rejected and rolled-back counts. Changing a mode needs the pairing code. Approvals can never be Automatic.

## {{label:sindri.settings}}

Machine-wide settings (global), in two tabs: _General_ and _Skills_.

- _Model provider_: provider and model, the API key's secret **name** (never the secret), and _Offline mode_ (local-only mode).
- _Agents_: the implementation agent and the review and QA agent.
- _Mimir and Brokkr_: Mimir URL and token secret name, and whether Brokkr selects harnesses. _Mimir connection_ checks it live.
- _Feedback Graph_: URL (usually `http://127.0.0.1:8787`), token secret name, on or off.
- _Export_: a zip of Sindri's database and settings, without secrets.
- _Project data_: points to {{screen:sindri.project-settings}}, where a project's data is deleted.
- _Skills_ tab: the skills library. **Import** a folder with a `SKILL.md` (or a parent folder of several), preview one, **Re-import** it when it shows _Changed on disk_, or delete it. The library keeps a copy with its digest; the file on disk is never changed.
