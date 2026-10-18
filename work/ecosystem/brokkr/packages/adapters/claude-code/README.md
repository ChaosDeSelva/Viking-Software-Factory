# @brokkr/adapter-claude-code

Converts Brokkr's resolved skills and harness contract into a Claude Code bundle.

## Output

Default (isolated), under `<repo>/.brokkr/generated/task-context/<taskId>/claude/`:

- `CLAUDE.md`: task brief, harness execution contract (stages, argv checks, policies, evidence), and the selected skills with the reason each was chosen.
- `.claude/skills/<skill>/SKILL.md`: one per selected skill.
- `.brokkr-ledger.json`: what was written, with SHA-256 digests. `cleanup` removes only these files and skips anything modified since.

Use the bundle by starting Claude Code in that directory, or with `claude --add-dir <bundle>` (Claude Code loads `.claude/skills/` from added directories).

The repository's own `CLAUDE.md` and `.claude/` are written only when `AdapterContext.modifyProjectInstructions === true`. In that mode the contract is inserted as a marked block (`<!-- brokkr:begin claude-code -->` … `<!-- brokkr:end claude-code -->`) and skills go to `<repo>/.claude/skills/`. Existing files Brokkr did not write are never overwritten.

## SKILL.md format and where it comes from

```markdown
---
name: react-architecture
description: Component boundaries ... Selected by Brokkr for task UI-142: required by frontend-react@1.0.0.
---

<skill body markdown>
```

Sources, both checked on 2026-10-14:

1. **Claude Code skills documentation** (`https://code.claude.com/docs/en/skills`). A skill is a directory holding `SKILL.md`. The file opens with YAML frontmatter between `---` lines, and `---` must be the first line. `name` defaults to the directory name and has to match it. The names `synced` and `anthropic-skills` are reserved. `description` is what Claude uses to decide when to invoke the skill. It must not contain XML tags, and the skill listing truncates it at 1,536 characters. Unknown frontmatter fields are ignored.
2. **Skills installed on this machine**, read-only: `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/*/SKILL.md`. Every one uses exactly `name` + `description` frontmatter, followed by a Markdown body.

The adapter adds these rules (`validateSkillFrontmatter`):

- `name` must be kebab-case, at most 64 characters, equal to the directory name, and not reserved.
- `description` must be non-empty, at most **1024** characters, and free of angle brackets. 1024 is the stricter Agent Skills limit; Claude Code's own cap is 1,536.
