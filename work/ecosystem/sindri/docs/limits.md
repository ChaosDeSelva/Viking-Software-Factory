# Limits and known gaps

State after the local recovery integration. See `gates/g4-g7.md` for the acceptance run these gaps come from.

## Limits enforced today

* Bootstrap skips files over 1 MiB (`MAX_FILE_BYTES`), binaries, secret looking files (`.env`, `.netrc`, `.pgpass`, key and service account files), and anything reached through a symlink that leaves the repo. It always lists files with its own gitignore aware walker; git runs only to audit the repo's config for code executing keys. Skips are reported, not silent.
* Structure listing depth is 3.
* Director output budget defaults to 16000 tokens per drafting call.
* One local user, one bearer token; the server listens on loopback by default. Approvals need the pairing code printed by `sindri start` (it changes on every start; five wrong codes lock approvals until restart).
* After a restart Sindri resumes unfinished executions on its own. While the configured Mimir is unreachable it retries every 5 seconds until Mimir answers.
* Changing the Mimir URL or token in Settings stops runs attached to the old Mimir and resumes only when the target serves the same missions.

## Gaps in the full factory run

* **Quality gates fail closed.** Missing or mismatched task, commit, lock, verification or review evidence blocks delivery. The deterministic acceptance run passes all six gates.
* **PR requests** require passing gates and human approval. Knowledge proposals stay blocked until Mimir records that delivery approval was consumed.
* **Knowledge write back** is available through delivery proposal routes and the Knowledge screen, with the approval factor required for generation and decisions.
* **Brokkr** selection and verification are wired through local release SDKs. Harness install and pin operations remain CLI responsibilities.
* With Mimir's fake runtime, agents do not change code. `sindri demo --with-failing-test` plants a test that fails once, so this demonstrates the retry path, not an agent repair. A separate live Codex test repaired actual code and passed independent Brokkr checks.
* Mimir budgets have no wall clock limit; Sindri records `budget_not_forwarded` for plan wall clock budgets.

## Other gaps

* The Sindri server does not refuse to start against an incompatible Mimir; `sindri doctor` and `/v1/mimir/status` report it.
* Release tarballs (`pnpm release:local`) are built for the machine that builds them (native SQLite module); there is no cross build.
* Web UI: no Markdown renderer (specs render as plain text).

Not planned: multi user auth, hosted mode, auto merge or deploy (ADR-008), telemetry.

Known detector gaps in injection handling: named HTML entities such as `&shy;` and `&zwnj;`, combining grapheme joiners, deeply nested entities, and homoglyphs. Per request random delimiters still hold. See `security.md`.
