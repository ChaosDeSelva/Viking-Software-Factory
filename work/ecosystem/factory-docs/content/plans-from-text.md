# Plans from text

Paste a call transcript, meeting notes or a brief, and get back a plan you can hand to people: a readable **proposal** and an **engineering appendix**, researched across every project the text talks about. Nothing in any repository changes: the agents only read.

## Paste the text: {{screen:heimdall.new-work}}

1. Pick the project the plan belongs to, then choose **Plan from text** in _Kind of work_.
2. Paste the text into **Text to plan from** (up to 200,000 characters). The title defaults to its first line.
3. Under **Other projects to read**, check the projects Heimdall found in the text. A project named by its name, its folder or one of its aliases is ticked. One named only by an everyday word ("frontend", "docs") is shown unticked: tick it if the text means that project. **Add another project** lists the rest. Up to 8 other projects; the plan's own project is always read.
4. **Let the research use the web** is off by default and unavailable in local-only mode.
5. **Fact-check the plan** (on by default) adds an agent that checks the appendix against the code, and the proposal against the appendix.
6. Optional: _Notes_ (for example dates or who the plan is for) and _Skills_. Press **Save and draft spec**, then approve the spec and the plan as for any request.

## What the run does

| Task                 | Agent        | Reads                                                            | Writes                          |
| -------------------- | ------------ | ---------------------------------------------------------------- | ------------------------------- |
| `research`           | investigator | the plan's own project (its worktree)                            | `research.md`, `sources.json`   |
| `research-<project>` | investigator | one other project, in a read-only snapshot of its default branch | `research.md`, `sources.json`   |
| `proposal`           | writer       | every project's findings and the pasted text                     | `proposal.md`, `engineering.md` |
| `fact-check`         | reviewer     | both documents and the files they cite                           | `review.json`                   |

The research tasks run in parallel, as many at once as Mimir's fleet allows. The writer runs on the agent that plans and reviews (Claude Code by default), not the one that writes code. Citations of another project's files look like `docs-site/src/app.ts:12`. The pasted text is given to every agent as data, never as instructions.

### The two documents

- **`proposal.md`**, for the people on the call: _Why_, _Goal_, _Out of scope_, _What exists today_, _What we're borrowing_, _Ground rules_, _Decisions to settle_, _Tickets_, _Demo plan_, _Exit criteria_, _Risks_, _Sources_. Ticket 0 is a spike with bullet-point objectives; each later ticket has an outcome, a demo, acceptance criteria and checkbox subtasks sized S, M or L. The demo plan builds week on week, with dummy data (seed, reset and check scripts that refuse anything but a local database) and a rehearsal before each demo. It has at least four diagrams: how the pieces fit, one request through the system, the weeks, and how the tickets depend on each other.
- **`engineering.md`**, for engineers: each project's findings with exact names, routes, tables and file:line detail. Every claim in the proposal must be supported here.

## The plan checks

| Gate                 | Passes when                                                                           |
| -------------------- | ------------------------------------------------------------------------------------- |
| `proposal-findings`  | each project's `research.md` has _Answer_, _Findings_, _Open questions_ and _Sources_ |
| `proposal-documents` | the writer recorded both `proposal.md` and `engineering.md`                           |
| `proposal-sections`  | both documents have their sections, in order                                          |
| `proposal-tickets`   | Ticket 0 is a spike, and tickets carry checkbox subtasks                              |
| `proposal-diagrams`  | at least four ` ```mermaid ` blocks, each starting with a diagram type                |
| `review-verdict`     | the fact-check recorded its verdict                                                   |

## Read, accept, revise

The plan opens in the delivery's drawer with tabs for the **Proposal**, the **Engineering appendix** and each project's **Findings**. Diagrams are drawn; one that does not parse is shown as its source with the reason. Each document has **Copy as Markdown** and **Download**.

- **Accept plan** needs the pairing code and passing checks. **Reject plan** needs a reason.
- **Revise the plan** turns what you write into a new plan over the same projects: the writer gets the earlier proposal, its appendix and the fact-check's findings, and rewrites both documents.
