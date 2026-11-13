# How the factory works

The factory turns a request ("add CSV export to the reports page") into a verified change you can apply to your repository. It can also answer a question with a cited research document, or review a GitHub pull request for you. Five programs share the work. Everything runs on your machine.

```factory-architecture

```

## Who does what

| Program     | Job                                                                                                               | Open it                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Sindri      | Plans. Inbox, Director, specs, plans, runs, quality gates, deliveries, knowledge, steward.                        | [127.0.0.1:4310](http://127.0.0.1:4310/) |
| Mimir       | Executes. Runs a mission's tasks with crews of agents, asks for approvals, enforces budgets, records every event. | [127.0.0.1:7700](http://127.0.0.1:7700/) |
| Heimdall    | Watches. One dashboard over Sindri and Mimir; with the operator code it can act on them.                          | [127.0.0.1:4320](http://127.0.0.1:4320/) |
| Skidbladnir | Supplies workers. Disposable machines, simulated or in the cloud, that can run agent jobs.                        | [127.0.0.1:4380](http://127.0.0.1:4380/) |
| Brokkr      | Verifies. Runs the harness's checks on a task's result and writes a signed report with a verdict.                 | no UI; Mimir and Sindri call it          |

Two helpers:

- **The steward** lives inside Sindri. Whenever you would have to make a decision (answer a spec question, resolve an escalation, approve a spec or plan, accept a delivery), it recommends one, says why, and records what happened afterwards. You accept, change or reject. See [Steward](/docs/glossary#steward).
- **Feedback Graph** is a separate local tool (`http://127.0.0.1:8787`) that keeps lessons you approved from earlier feedback to agents. Sindri reads them and passes them to the Director, the planner and the steward. It never writes to it. Without it everything still works.

## Local addresses

Everything listens on `127.0.0.1` only. The launcher (_Start Factory.command_) starts Sindri, Mimir and Heimdall together and prints each one's access token; Skidbladnir and Feedback Graph start separately.

| Address                                  | What                            | Sign in with                                 |
| ---------------------------------------- | ------------------------------- | -------------------------------------------- |
| [127.0.0.1:4320](http://127.0.0.1:4320/) | Heimdall, the command center    | Heimdall access token; operator code to act  |
| [127.0.0.1:4310](http://127.0.0.1:4310/) | Sindri, planning and approvals  | Sindri access token; pairing code to approve |
| [127.0.0.1:7700](http://127.0.0.1:7700/) | Mimir, execution                | Mimir access token                           |
| [127.0.0.1:4380](http://127.0.0.1:4380/) | Skidbladnir, worker machines    | none (local only)                            |
| [127.0.0.1:8787](http://127.0.0.1:8787/) | Feedback Graph inbox (optional) | its own                                      |

Each restart prints new codes, except Sindri's and Mimir's access tokens, which stay until you rotate them.

## What talks to what

| From     | To              | How                                                      | Carries                                                  |
| -------- | --------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Browser  | Sindri          | HTTP API; live stream `GET /v1/changes`                  | your requests and approvals; pages refresh on any change |
| Browser  | Mimir           | HTTP API; live event stream                              | missions, crews, approvals, budgets                      |
| Browser  | Heimdall        | its own API; live stream `/api/stream`                   | one snapshot of Sindri and Mimir, pushed as it changes   |
| Heimdall | Sindri, Mimir   | their HTTP APIs, every 3 seconds; your actions on demand | everything it shows; operator actions                    |
| Sindri   | Mimir           | Mimir SDK over HTTP, plus Mimir's event stream           | the approved plan as a mission; events and evidence back |
| Sindri   | Claude Code     | the local CLI                                            | spec and plan drafting (Director and planner)            |
| Sindri   | Feedback Graph  | HTTP, read only                                          | approved lessons for the Director, planner and steward   |
| Sindri   | GitHub          | your own `gh` login (PR reviews only)                    | the PR and its commits in; a review you approved out     |
| Mimir    | Agents          | Codex or Claude Code in a git worktree per task          | the task; the agent's changes and transcript             |
| Mimir    | Brokkr          | library call after each task                             | a signed verification report and verdict                 |
| Mimir    | Skidbladnir     | its API, when a task runs on a worker machine (optional) | worker lifecycle and command evidence                    |
| You      | Your repository | `git apply` of an exported delivery                      | the verified change; nothing is merged for you           |

For AI tools, Skidbladnir ships an MCP server (read only unless controls are enabled). Sindri, Mimir and Heimdall expose HTTP APIs; the factory's own agents run with MCP turned off.

## The flow in one paragraph

A request lands in Sindri's inbox. The **Director** drafts a **spec** from it, citing your repository, and asks blocking questions. You answer and approve the spec. The planner splits it into a **plan**: tasks, dependencies, harnesses, budgets. You approve the plan and start a **run**. Sindri hands it to Mimir as a **mission**. Mimir creates **crews**, gives each task its own **worktree**, and lets an agent work on it. When the agent finishes, **Brokkr** checks the result. Sindri then runs its **quality gates** on the evidence Mimir recorded. If everything passes, the run becomes a **delivery**. You export the patch and apply it yourself. Nothing is merged or deployed for you.

The full walkthrough with screen names is in [From ticket to delivery](/docs/ticket-to-delivery).

## Three kinds of work

You choose the kind when you add a request. All three go through the same spec, plan and run; they differ in what the agents may do and what you get back.

| Kind      | The agents                                                     | You get                                                      | It ends when                      |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------- |
| Change    | write code in their worktrees                                  | a verified patch                                             | you export and apply it           |
| Research  | only read: the project's code, lessons, and the web if allowed | a Markdown document whose claims cite numbered sources       | you accept or reject it           |
| PR review | only read a copy of the pull request Sindri keeps for itself   | a review draft you edit, preview and post to GitHub yourself | you post it, or leave it unposted |

See [Research questions](/docs/research) and [PR reviews](/docs/pr-reviews). Research and reviews can use **skills** and **notes** you give them; see [Skills and guidance](/docs/research#skills-and-guidance).

## Names for the same thing

| You see   | In                          | Means                                                 |
| --------- | --------------------------- | ----------------------------------------------------- |
| Run       | Sindri, Heimdall            | one execution of an approved plan                     |
| Mission   | Mimir, Heimdall             | the same work as Mimir sees it; one run = one mission |
| Execution | Sindri API, raw ids `exe_…` | the API name for a run                                |
| Task      | everywhere                  | one piece of a plan, done by one agent                |
| Delivery  | Sindri                      | the verified result of a run                          |
| Work kind | Sindri, Heimdall            | change, research or PR review; a badge on each item   |

## What needs a human

The factory never does these by itself:

- **Approving** a spec, a plan, a local export or a steward mode change, **accepting or rejecting** a research document, and **posting** a PR review to GitHub. These need the **approval pairing code** printed when Sindri starts.
- **Approving risky agent actions** that Mimir's policy does not allow on its own.
- **Answering escalations** when a task gives up (retry, skip, replan, abort).
- **Raising a budget** that ran out.
- **Applying and merging** the patch.

All of these show up in Sindri's {{screen:sindri.needs-you}} tab, in Heimdall's {{screen:heimdall.quality-approvals}}, or in Mimir's {{screen:mimir.reviews}}. See the [Operator guide](/docs/operator-guide).

## Evidence, not claims

Completion is judged only on evidence Mimir recorded: exit codes, test logs, diffs, Brokkr reports. Text an agent writes ("all tests pass") counts for nothing. Missing evidence fails the gate. This is why a run can finish and still not be deliverable.

## Local only

By default nothing leaves your machine except model calls by the agents you configured. Ticket imports from a tracker, PR reviews and services on other hosts need local-only mode turned off in Sindri's {{screen:sindri.settings}}. A research agent reaches the web only when you tick **Web** for that question, and web research is unavailable while local-only mode is on.
