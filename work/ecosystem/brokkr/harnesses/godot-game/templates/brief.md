# Brief: {{objective}}

## Objective

{{objective}}

## Acceptance criteria

{{acceptanceCriteria}}

## Context

{{context}}

## Constraints

{{constraints}}

## Harness: godot-game

Skills: gdscript-quality, scene-structure, game-testing, asset-hygiene

Checks that must pass before completion:

- `godot-check`: `godot --headless --check-only --path . --script res://scripts/main.gd` (when fileExists project.godot, scripts/main.gd)

Do not report completion without the exit codes of these checks.
