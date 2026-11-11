# How the factory works

The factory turns a request ("add CSV export to the reports page") into a verified change you can apply to your repository. Five programs share the work. Everything runs on your machine.

```text
 ticket ──► Sindri ──plan──► Mimir ──task──► agent (in its own worktree)
             ▲  │             │  ▲                 │
             │  │             │  └── Brokkr verifies the result
             │  └─ delivery ◄─┘
             │
  Heimdall watches Sindri and Mimir     Skidbladnir can supply worker machines
  Feedback Graph lessons ──► Sindri     The steward recommends your decisions
```

## Who does what

| Program     | Job                                                                                                               | Default address                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Sindri      | Plans. Inbox, Director, specs, plans, runs, quality gates, deliveries, knowledge, steward.                        | `http://127.0.0.1:4310`         |
| Mimir       | Executes. Runs a mission's tasks with crews of agents, asks for approvals, enforces budgets, records every event. | `http://127.0.0.1:7700`         |
| Brokkr      | Verifies. Runs the harness's checks on a task's result and writes a signed report with a verdict.                 | no UI; used by Sindri and Mimir |
| Heimdall    | Watches. One dashboard over Sindri and Mimir; with the operator code it can act on them.                          | `http://127.0.0.1:4320`         |
| Skidbladnir | Supplies workers. Disposable machines, simulated or in the cloud, that can run agent jobs.                        | `http://127.0.0.1:4380`         |

Two helpers:

- **The steward** lives inside Sindri. Whenever you would have to make a decision (answer a spec question, resolve an escalation, approve a spec or plan, accept a delivery), it recommends one, says why, and records what happened afterwards. You accept, change or reject. See [Steward](/docs/glossary#steward).
- **Feedback Graph** is a separate local tool (`http://127.0.0.1:8787`) that keeps lessons you approved from earlier feedback to agents. Sindri reads them and passes them to the Director, the planner and the steward. It never writes to it. Without it everything still works.

## The flow in one paragraph

A request lands in Sindri's inbox. The **Director** drafts a **spec** from it, citing your repository, and asks blocking questions. You answer and approve the spec. The planner splits it into a **plan**: tasks, dependencies, harnesses, budgets. You approve the plan and start a **run**. Sindri hands it to Mimir as a **mission**. Mimir creates **crews**, gives each task its own **worktree**, and lets an agent work on it. When the agent finishes, **Brokkr** checks the result. Sindri then runs its **quality gates** on the evidence Mimir recorded. If everything passes, the run becomes a **delivery**. You export the patch and apply it yourself. Nothing is merged or deployed for you.

The full walkthrough with screen names is in [From ticket to delivery](/docs/ticket-to-delivery).

## Names for the same thing

| You see   | In                          | Means                                                 |
| --------- | --------------------------- | ----------------------------------------------------- |
| Run       | Sindri, Heimdall            | one execution of an approved plan                     |
| Mission   | Mimir, Heimdall             | the same work as Mimir sees it; one run = one mission |
| Execution | Sindri API, raw ids `exe_…` | the API name for a run                                |
| Task      | everywhere                  | one piece of a plan, done by one agent                |
| Delivery  | Sindri                      | the verified result of a run                          |

## What needs a human

The factory never does these by itself:

- **Approving** a spec, a plan, a local export or a steward mode change. These need the **approval pairing code** printed when Sindri starts.
- **Approving risky agent actions** that Mimir's policy does not allow on its own.
- **Answering escalations** when a task gives up (retry, skip, replan, abort).
- **Raising a budget** that ran out.
- **Applying and merging** the patch.

All of these show up in Sindri's {{screen:sindri.needs-you}} tab, in Heimdall's {{screen:heimdall.quality-approvals}}, or in Mimir's {{screen:mimir.reviews}}. See the [Operator guide](/docs/operator-guide).

## Evidence, not claims

Completion is judged only on evidence Mimir recorded: exit codes, test logs, diffs, Brokkr reports. Text an agent writes ("all tests pass") counts for nothing. Missing evidence fails the gate. This is why a run can finish and still not be deliverable.

## Local only

By default nothing leaves your machine except model calls by the agents you configured. Ticket imports from a tracker and services on other hosts need local-only mode turned off in Sindri's {{screen:sindri.settings}}.
