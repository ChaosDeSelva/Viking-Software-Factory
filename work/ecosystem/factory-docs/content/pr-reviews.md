# PR reviews

Give the factory a GitHub pull request and get back a review you can edit. Nothing leaves your machine until you press **Post review to GitHub** with the pairing code, and then it is posted once, from your own `gh` login.

## Before you start

- Install the GitHub CLI and sign in: `gh auth login`. Sindri stores no GitHub token; it uses yours for reading the PR, cloning it and posting.
- Turn local-only mode off in {{screen:sindri.settings}}. A PR review needs GitHub.
- Register the repository as a project. Sindri matches the PR to the project whose git remote names the same repository.

## Import the pull request: {{screen:sindri.inbox}}

1. Choose **Review a PR** in _Kind of work_ (Heimdall: **New work** → **Review a PR**). It is disabled, with the reason, while `gh` is missing, GitHub pull requests are turned off in {{screen:sindri.settings}}, or local-only mode is on.
2. Paste the **Pull request URL** (`https://github.com/<owner>/<repo>/pull/<n>`).
3. Optional: _Notes_ (what to look for, kept local) and _Skills_, pre-selected with the project's default review skills. See [Skills and guidance](/docs/research#skills-and-guidance).
4. Press **Import pull request**. If no single project matches the repository, you are asked which project it is for.

The inbox item shows the PR's author, branches and size. Its title and body are untrusted text: shown sanitized, never followed as instructions. Importing the same URL again refreshes it (new head, title, files).

Then the usual path: **Draft spec from this**, approve the spec, propose and approve the plan, **Execute plan**.

## What the run does

- Sindri prepares its own **review mirror** of the repository in its data folder and fetches the PR's base and head commits there. Your own checkouts are never touched.
- The plan has a `pr-review` task for the reviewer, plus a `security-review` task when a changed path looks security-related (authentication, sessions, tokens, secrets, permissions). Both are read-only document tasks without network.
- Each reviewer writes `review.json` (verdict, summary, findings with file and line) and `review.md`. The gates `pr-review-schema` and `pr-review-markdown` check that both are there and valid.
- Each finding is placed **inline** when its lines sit inside a changed hunk of the PR (compared with the merge base, as GitHub shows it), otherwise in the **general** comments with the reason. No finding is dropped.

## Edit the review: {{screen:sindri.delivery-detail}}

A PR review delivery has no patch. Its tabs:

- _Review_: the **Verdict** (Comment by default, or Approve, Request changes), the **Summary**, and the **Findings**. Untick a finding to leave it out; **Edit** rewords it. **Save edits** stores a new draft version; the agents' own review stays as recorded.
- _Preview and post_: exactly what GitHub will receive, as plain text, with the result of the **leak check**. **Refresh preview** after saving edits.
- _Reviewers_: each reviewer's verdict, summary, full `review.md` and checks.
- _Guidance_: the skills and notes the reviewers were given, with digests.

## Post to GitHub

**Post review to GitHub** (pairing code) is refused while any of these holds; the preview lists the blockers:

- a reviewer's checks did not pass;
- the leak check found text that must stay local: anything naming private local tooling, citing a private lesson, or shaped like a secret. Exclude or reword the finding it names;
- local-only mode is on;
- the PR's head moved since the review ran (`pr_head_moved`). Import the PR again and run a new review.

A review is posted once. A hidden marker in its body lets Sindri recognise it, so a retried or doubled click records the existing review instead of posting a second one. Once posted, the delivery shows **Posted** with a link, and edits are closed.

Heimdall shows the same review read-only in the record's inspector, with **Edit and post in Sindri**. {{screen:heimdall.quality-approvals}} lists it under _Documents and reviews_ until it is posted.

If something goes wrong, see [PR review problems](/docs/troubleshooting#pr-review-problems).
