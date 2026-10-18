# Harnesses used by Sindri

Enable `brokkrEnabled` in Settings to resolve installed harnesses through `@brokkr/sdk`.
Keep harness definitions in Brokkr's library or operator managed harness directories. A harness
names its version, compatible task types, required and optional checks, skills and policies.
Use Brokkr's CLI to author, validate and install packages; Sindri's install/pin/verify endpoints
remain unsupported. Sindri plans select harnesses; Mimir executes verification.

An approved plan retains its full selection and lock, including content digests. Each Mimir
task receives this operator controlled contract. Changing harness content requires resolving and
approving a new plan; changing an agent worktree cannot replace the contract. Older plans without
a full selection must be re proposed to use task bound Brokkr verification.

A required check skipped as `not_applicable` follows Brokkr's conditional check semantics.
Missing tools, missing scripts without a matching condition, failures and unexplained required
skips remain blockers. Sindri cannot convert a failed Brokkr verdict into a pass.

Keep credentials outside harnesses, plans and repository text. Run `pnpm test:acceptance` to
exercise selection, restart/resume, signed verification evidence, review, approval and proposals.
