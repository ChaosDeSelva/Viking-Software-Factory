# Feedback Graph

Feedback Graph is a local tool that learns from the operator's feedback to coding agents and keeps
the lessons the operator approved, per project. Sindri reads those lessons and gives them to the
Director (spec drafting), the planner (plan proposals) and the steward ([steward.md](steward.md)),
so new work follows the standards earlier feedback set.

Sindri only reads. It never writes to Feedback Graph, and drafting, planning and the steward work
the same without it: when Feedback Graph is not configured, disabled, unreachable or has no
project for a repository, there are simply no lessons.

## Setup

1. Create an API token in Feedback Graph.
2. Store it in Sindri's SecretStore under a name of your choice, for example
   `feedback-graph.token`:
   - macOS (Keychain): `security add-generic-password -s sindri -a feedback-graph.token -w`
     (it prompts for the token).
   - Elsewhere: start Sindri with `SINDRI_SECRET_STORE=env` and export
     `SINDRI_SECRET_FEEDBACK_GRAPH_TOKEN`.
3. In Settings, under Feedback Graph, set the URL (default `http://127.0.0.1:8787`), the token
   secret name (`feedback-graph.token`, never the token itself) and turn it on. Or send the
   `feedbackGraph` object with `PUT /v1/settings`:
   `{"feedbackGraph": {"url": "http://127.0.0.1:8787", "tokenSecret": "feedback-graph.token", "enabled": true}}`.
4. Check `GET /v1/feedback-graph/status`: `reachable: true` and `error: null` mean the URL answers
   and the token is accepted.

While local-only mode is on (the default), the URL must be a loopback address (`127.0.0.1`,
`localhost`, `[::1]`); settings with another host are refused with 422 `local_only`. Turn
local-only off to use Feedback Graph on another host.

## Which lessons a project gets

A Sindri project is linked to one Feedback Graph project:

- **auto**: Sindri asks Feedback Graph which project tracks the project's `repoPath`
  (`GET /api/agent/project?cwd=<repoPath>`).
- **override**: the operator names the Feedback Graph project key with
  `PUT /v1/projects/:id/feedback-graph` `{"projectKey": "demo-app"}`, for a repository Feedback
  Graph tracks under another path. `{"projectKey": null}` removes the override and goes back to
  auto. The override is stored in the project's settings (`feedbackGraphProject`).
- **none**: no override and Feedback Graph does not track the path.

Only approved lessons are read (`GET /api/lessons?project=<key>&status=approved`), newest decision
first. Links and lessons are cached for 60 seconds per project (failures for 10 seconds); changing
the override drops the project's cached link. `GET /v1/projects/:id/feedback-graph` shows the
link, the lessons and, when there are none, why.

## How lessons are used

Each lesson becomes `{id, title, rule, appliesWhen, paths, status, injectionDetected}`. Lesson text
is untrusted input, handled like ticket text: invisible and control characters are removed,
secrets and sentences that look like prompt injection are redacted, lengths are capped, and
`injectionDetected` records that something was redacted.

The Director and the planner each get up to 10 of the project's lessons as untrusted data blocks
of kind `lesson` with the citation id `fg:<lessonId>`. The model may cite a lesson for a claim
(Director) or list the lessons a task must follow (planner, the task's `lessons` field). A
citation counts only when that lesson was in the prompt: an unknown `fg:` id demotes a spec claim
to a high-risk assumption, and is dropped from a plan task. A lesson in which an injection was
found flags the drafted spec and the proposed plan (`untrustedInstructionDetected`,
`injectionFindings`), like any other untrusted text, even when the lesson itself is left out for
having no rule; a plan's flag carries over to its revisions. An acceptance criterion that cites
only lessons keeps the intake as its spec provenance and is listed, with the lessons it cites, in
the spec's `lessonOnlyAcceptanceCriteria`.

A plan task stores the redacted text of the lessons it cites (`lessonContext`, at most 2000
characters each; revisions keep the planner's text and ignore any sent with the patch). The
agent brief lists them under "Operator lessons", each id with its title and text quoted as data.
