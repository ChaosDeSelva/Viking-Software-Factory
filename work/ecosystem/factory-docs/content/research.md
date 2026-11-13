# Research questions

Ask a question about your project and get back a Markdown document with numbered citations, instead of a patch. Nothing in your repository changes: the agent only reads.

## Ask the question: {{screen:sindri.inbox}}

1. Pick the project, then choose **Research** in _Kind of work_ (Heimdall: **New work** → **Research**).
2. Write the **Question** (at most 500 characters; put the rest in _Background_).
3. Choose the **Sources** the agent may use. At least one must be on:
   - **Project code** (on by default): files of the repository at the commit the run starts from.
   - **Lessons from your feedback history** (on by default when the project is linked to a lessons source): approved lessons, cited as private sources.
   - **Web** (off by default): lets the agent search and fetch public web pages. Unavailable while local-only mode is on: the checkbox is disabled with _Local-only mode is on_, Sindri refuses such a question with `local_only`, and **Execute plan** refuses a plan that needs the web until you turn local-only mode off in {{screen:sindri.settings}}.
4. **Fact-check the document** (on by default) adds a second agent that spot-checks claims against their sources.
5. Optional: _Notes_ and _Skills_ for this question only (see [Skills and guidance](/docs/research#skills-and-guidance)). Press **Ask**.

The question becomes an inbox item marked **Research**. From there it follows the usual path: **Draft spec from this**, approve the spec, propose and approve the plan, **Execute plan**. See [From ticket to delivery](/docs/ticket-to-delivery).

## What the run does

The plan has one `research` task for the investigator and, unless you turned fact-checking off, a `fact-check` task for a reviewer. Both are **document tasks** in Mimir: read-only, no diff, no Brokkr verification. The investigator writes `research.md` (sections _Answer_, _Findings_, _Open questions_, _Sources_) and `sources.json`, the numbered list its `[n]` citations point to. The fact-check reads that document as an input and writes its findings.

If the agent finishes without writing a document, Mimir fails the attempt with `document_missing` and retries while attempts are left.

## The research checks

Sindri checks the recorded files, never the agent's chat:

| Gate                     | Passes when                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `research-document`      | `research.md` exists with all four sections                                                      |
| `research-sources`       | `sources.json` is valid, ids are unique, and there is at least one source                        |
| `research-citations`     | the document cites at least once, and every `[n]` points to a listed source                      |
| `research-file-sources`  | every cited `path:line` exists at the run's base commit, with the lines inside the file          |
| `research-source-policy` | only the sources you allowed are cited: web links only with Web on, lessons only with lessons on |

A failing check sends the task back for a repair, like any gate. Reasons you may see are explained in [Research checks fail](/docs/troubleshooting#research-checks-fail).

## Read and decide: {{screen:sindri.delivery-detail}}

A research delivery has no patch and no export. Its tabs:

- _Document_: the answer with its numbered sources. **Copy as Markdown** copies it. A **Contains private lessons** badge means it cites lessons from your feedback history; copying removes those citations so they do not leave your machine.
- _Checks_: the research gates and the fact-check's verdict and findings.
- _Guidance_: the skills and notes the agents were given, with a digest of the exact text.

Then decide (pairing code):

- **Accept** keeps the document as the answer. The delivery shows [Accepted](/docs/statuses#accepted-research-decision-status).
- **Reject…** needs a reason. The delivery shows [Rejected](/docs/statuses#rejected-research-decision-status).
- **Ask a follow-up…** adds a new research question to the inbox, linked to this delivery. Its agent gets this document as context.

A decision is made once. Accept is refused until the checks passed; reject and follow-up work either way. In Heimdall the same document opens in the record's inspector with **Accept document**, **Reject document** and _Ask a follow-up question_, and {{screen:heimdall.quality-approvals}} lists it under _Documents and reviews_ until you decide.

## Skills and guidance

Every research and review brief can carry operator guidance:

- **Skills**: `SKILL.md` folders imported into Sindri's library under {{screen:sindri.settings}} → _Skills_. Import a folder (or a parent folder with several skills), preview one, re-import it when the file on disk changed (_Changed on disk_ badge), or delete it. The file on disk is never changed.
- **Project guidance**: {{screen:sindri.project-settings}} → _Guidance_ holds standing notes for the project (at most 16 KB) and default skills. Both go into every research and review brief of the project; the PR review form also shows the default skills pre-selected.
- **Request notes and skills**: chosen on the form, for this one request.

The plan records each skill and note with a digest, so a delivery shows exactly what the agents read. The whole guidance block is capped at 48 KB; a skill that does not fit is listed as omitted, never cut. Saved guidance applies to plans proposed afterwards.
