# @brokkr/adapter-codex

Writes a Codex instruction bundle under `<repo>/.brokkr/generated/task-context/<taskId>/codex/`:

- `AGENTS.md`: task brief, harness execution contract, and links to each skill file. Codex reads plain-Markdown `AGENTS.md` files.
- `instructions/<skill>.md`: one per selected skill. The first line is the comment `<!-- skill: name@version -->`, followed by the skill body.

The project's own `AGENTS.md` is changed only when `modifyProjectInstructions === true`, and only as a marked block that `cleanup` removes again. `cleanup` deletes only files listed in the ledger whose digests still match.
