# @brokkr/adapter-generic

Provider-neutral output, always isolated under `<repo>/.brokkr/generated/task-context/<taskId>/generic/`:

- `INSTRUCTIONS.md`: task brief, execution contract, and every selected skill inlined with the reason it was chosen.
- `manifest.json`: machine-readable skills, checks (argv arrays), policies, workflow, and the `executionAllowed` flag. It is validated by `GenericManifestSchema` (`schemaVersion: 1`).
