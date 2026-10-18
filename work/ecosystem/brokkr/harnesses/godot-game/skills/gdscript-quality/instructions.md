# GDScript quality

Static typing and signals keep Godot projects maintainable.

## Always

- Use static types for variables, parameters and return values.
- Communicate upward with signals and downward with direct calls or exported references.
- Mark inspector-tunable values with `@export` and document them.
- Use `class_name` for reusable scripts and constants for shared values.
- Free nodes with `queue_free()` and disconnect long-lived signal connections.

## Never

- Never hard-code node paths with long `get_node` chains; use `@onready` typed references or exports.
- Never put game logic in autoloads that belongs to a scene.
- Never leave `print` debugging in committed code.

## Verify

- `godot --headless --check-only` reports no script parse errors.
- The affected scene runs without errors in the debugger output.
