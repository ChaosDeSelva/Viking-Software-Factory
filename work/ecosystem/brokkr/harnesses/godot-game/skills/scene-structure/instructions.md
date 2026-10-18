# Scene structure

Scenes are the unit of reuse; broken resource paths are silent failures.

## Always

- Build features as self-contained scenes with a single root and a clear public interface.
- Reference resources by `res://` paths and move or rename files inside the editor.
- Keep scenes, scripts and assets together by feature.
- Use `.uid` files and keep them under version control.

## Never

- Never hand-edit `.tscn` files in ways that break node paths or ext_resource IDs.
- Never leave scenes pointing at missing scripts or textures.
- Never commit the `.godot/` cache directory.

## Verify

- A headless project load reports no missing resources or dependency errors.
- Every `res://` path in changed files exists.
