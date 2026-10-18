# Getting started

Brokkr defines how software must be built (harnesses and skills) and proves it was built that way (deterministic verification with evidence). It runs locally, needs no account and sends nothing anywhere.

## Install

Requirements: Node.js >= 25 on `PATH`, git, and pnpm or npm for your project's scripts.

From a local release archive:

```sh
scripts/install-local.sh dist/brokkr-0.1.0-macos-arm64.tar.gz   # verifies the .sha256, writes ~/.local/bin/brokkr
brokkr doctor
```

From source:

```sh
pnpm install && pnpm build
alias brokkr="node $PWD/apps/cli/dist/bin.js"
```

To build the archive yourself: `pnpm release:local` (see `docs/compatibility.md` for what it contains).

## Configure a repository

```sh
cd my-app
brokkr init            # inspects the repo, recommends harnesses, explains their checks, asks before writing
brokkr harness list    # everything available: built-in, user (~/.brokkr/harnesses), project (.brokkr/harnesses)
brokkr harness add security-baseline
brokkr harness lock    # pins name, version and digest of every harness and skill
```

`init` writes `.brokkr/config.yaml` and `.brokkr/harness.lock.json`. Commit both. Add `.brokkr/generated/`, `.brokkr/runs/` and `.brokkr/cache/` to `.gitignore`.

## Give an agent its instructions

Describe the task in a JSON or YAML file:

```json
{
  "id": "UI-142",
  "title": "Build analytics dashboard",
  "description": "Create a responsive analytics UI",
  "taskTypes": ["frontend"],
  "tags": ["react"]
}
```

```sh
brokkr skills resolve --task task.json              # which skills apply, and why
brokkr prepare --provider claude-code --task task.json
```

`prepare` writes an isolated bundle under `.brokkr/generated/task-context/` (Claude Code `SKILL.md` files, Codex `AGENTS.md`, or a generic bundle). It never touches your own `CLAUDE.md`/`AGENTS.md` unless you pass `--modify-project-instructions`. `prepare --cleanup` removes exactly what it wrote.

## Verify

```sh
brokkr verify                          # or: brokkr verify --profile frontend-strict --task task.json
brokkr report --latest --format html > report.html
```

Each check runs as an argv array (no shell) in its own process group with a filtered environment and a timeout. The result is one of four verdicts:

| Verdict | Meaning | Exit |
|---|---|---|
| `passed` | every required check ran and passed | 0 |
| `failed` | a required check ran and failed | 1 |
| `incomplete` | a required check could not produce a result (missing tool, timeout, error, cancelled) | 1 |
| `blocked` | policy denied the run: untrusted harness, tampered lock, destructive command, secret in output | 4 |

Evidence (report JSON/Markdown, logs, screenshots, test results and a SHA-256 manifest) is stored in `.brokkr/runs/run_<id>/`. `brokkr report` re hashes it and refuses tampered evidence. Ctrl C cancels the running check, keeps the partial report and exits 130.

## Next steps

* `docs/verification-and-reports.md`: states, verdicts, report schema.
* `docs/policies-and-exceptions.md`: what is allowed and how to approve exceptions.
* `docs/harness-authoring.md` and `docs/skills.md`: write your own harness.
* `docs/sdk.md`: use Brokkr from an application (`@brokkr/sdk`).
* `docs/security.md` and `docs/limits.md`: what Brokkr protects against and what it does not.
