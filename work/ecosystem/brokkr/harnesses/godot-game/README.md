# godot-game

Godot 4 project validation: script parsing, scene and resource references, optional headless checks.

- Version: 1.0.0
- Task types: game, godot
- Required skills: gdscript-quality, scene-structure, game-testing, asset-hygiene
- Optional skills: none

## Checks

| Id | Command | Required | Runs when |
|---|---|---|---|
| `godot-check` | `godot --headless --check-only --path . --script res://scripts/main.gd` | yes | fileExists: project.godot, scripts/main.gd |

A check whose `when` conditions are not all met is skipped, not failed.

## Policies

Network: deny. Destructive commands: deny. Approval required for: install-dependencies, modify-ci.

## Layout

- `harness.yaml`: manifest
- `skills/<name>/skill.yaml` and `instructions.md`: skills (Always / Never / Verify)
- `roles/`: implementer and reviewer role definitions
- `templates/brief.md`: task brief template with `{{objective}}`, `{{acceptanceCriteria}}`, `{{context}}`, `{{constraints}}`

Validate with `brokkr harness validate harnesses/godot-game`.

## Entry script convention

Godot 4 `--check-only` parses only the script passed with `--script`; it does not validate the whole project. The check therefore targets the conventional entry script `scripts/main.gd` and runs only when both `project.godot` and `scripts/main.gd` exist (all `when` conditions must hold). Without that script the check is skipped: script parsing and scene/resource references are then not machine-verified and need human review. Run `godot --headless --check-only --path . --script res://<file>.gd` manually for other scripts.
