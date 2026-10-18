# Skills

A skill is a short Markdown document of engineering rules plus a manifest that says when it applies. Harnesses ship skills; the resolver selects the ones relevant to a task; provider adapters turn the selection into the format an agent reads (Claude Code `SKILL.md`, Codex `AGENTS.md`, or a generic bundle).

## Layout

```
harnesses/<harness>/skills/<skill>/
  skill.yaml        # manifest
  instructions.md   # body (the file named by `body`)
```

## Manifest (`brokkr.dev/v1alpha1`, kind `Skill`)

```yaml
apiVersion: brokkr.dev/v1alpha1
kind: Skill
metadata:
  name: regression-test-plan          # kebab-case, unique within the composed set
  version: 1.0.0
  description: "Plan regression tests from acceptance criteria"   # <= 1024 chars, no < or >
  tags: [qa, testing]                 # matched against repository frameworks (1 point)
selectors:
  taskTypes: [qa, test]               # matched against task.taskTypes and task.tags (3 points)
  keywords: [regression, test plan]   # whole-word match in title, description, tags (2 points)
  pathGlobs: ["src/**/*.test.ts"]     # matched against task.paths (2 points)
dependsOn: []                         # skills in the same harness package
conflictsWith: []
body: instructions.md
estimatedTokens: 240                  # used by the context budget
```

## How selection works (deterministic)

1. Every skill in a selected harness's `skills.required` list is selected (`required by <harness>@<version>`).
2. Each optional skill is scored by its selectors. It is selected when the score reaches the threshold of 2, so repository signals alone (1 point) never select a skill.
3. `dependsOn` is closed transitively. Two selected skills that conflict, or two harnesses shipping different content under one skill name, are an error.
4. With a token budget (`budgetTokens` in the SDK, `--budget` in the CLI) optional skills are dropped lowest score first; required skills are never dropped and an exceeded budget is reported.

Every selected and rejected skill carries a reason, returned as `Selection.rationale` by the SDK and printed by `brokkr skills resolve`.

## Writing the body

Built in skills follow one shape, enforced by `tests/harness-library.test.ts`:

* at most 300 words;
* an `## Always` section, a `## Never` section and a `## Verify` section;
* rules that are concrete and checkable ("Locate elements by role or label"), not slogans ("write good tests");
* a Verify section that names an observable result an agent or reviewer can check.

Never put secrets, URLs to fetch, or instructions to disable checks in a skill body. Skill text is untrusted input for agents and is scanned for secrets before verification completes.
