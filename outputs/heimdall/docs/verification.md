# Verification, October 14, 2026

Heimdall 1.0.0-rc.1 was built and tested on this Mac. This record distinguishes real source APIs, deterministic providers, and previously completed real agent work.

## Automated checks

* TypeScript and Vite production build passed.
* Nine Heimdall tests passed: SSE parsing, persisted cursors/deduplication/pagination, loopback restrictions, secret redaction, command allowlisting, authentication, operator unlock, CSRF checks, idempotent replay, source errors/reconnection, Sindri approval ownership, preferences/layout validation, notification revision/read persistence, event filters, connection replacement and restart persistence.
* Playwright passed all eight navigation destinations after Overview, task inspection, graph keyboard movement and saved layout after reload, notification read state, operator unlock, confirmed pause, live event/raw evidence inspection, Escape dismissal, light theme and mobile overflow checks. Automated axe WCAG A/AA checks found no violations on those destinations.
* Mimir: protocol 228 tests, core 2,092 tests, server 332 tests passed. New cases exercise crew pause/version conflict/idempotency, priority scheduling, bounded CLI output reading and verification rechecks without new agent sessions. Lint/typecheck passed.
* Sindri: planner 39 tests, Mimir client 32 tests, server 134 tests passed. One optional client test was skipped. Priority propagation is explicitly tested. Lint/typecheck passed.

## Integration evidence

An isolated real Mimir/Sindri/Heimdall HTTP stack passed project registration, bootstrap, intake, specification drafting/questions/revision/approval, plan proposal/revision/priority/approval and execution dispatch. This test uses deterministic model and agent providers, not a new paid model run. A browser check also edits a plan priority through the inspector and verifies the new source owned revision.

The previously completed real Codex/Claude acceptance mission was reopened through the upgraded APIs. Heimdall displayed all four tasks, Sindri plan/execution mappings, replayed events, task inspection and SHA-256-verified evidence. This check did not launch new agents. Screenshots under `screenshots/` show that completed real mission. Browser test screenshots under ignored `test-results/` use synthetic fixtures.

## Load and recovery

The short stress run inserted 25,000 events, retained exactly 20,000, reopened the SQLite cache and verified the cursor. It completed in approximately 1.5 seconds on this Mac. A 1,002-task fixture snapshot loaded; ten events reached the BFF cache within 13 ms maximum in that run. This measures ingestion, not full browser render latency. Three disconnect/reconnect cycles resumed events and reconciled source snapshots.

## Release limits

These checks are not a multi day soak or a guarantee for arbitrarily large factories. Desktop notification OS delivery depends on browser permission and was not manually certified. A complete manual assistive technology audit and installation on other operating systems have not been performed. Terminal data/model metadata remain limited to what the source runtime exposes. No unsupported source capabilities are simulated as real success.

The standalone runtime archive is built without runtime node_modules; its clean extraction startup is checked separately. No credentials, real databases or agent transcripts are included in the release archive. The project remains local and unpublished.

## Fresh real agent recorded acceptance

A new tiny greeting library idea subsequently passed the completed Heimdall workflow with real Claude Code planning/review, real Codex implementation and Brokkr verification. All four tasks completed. The saved run reopened after a service restart, verification only recheck passed, quality review approved, and a local patch exported through browser confirmations. Applying the downloaded patch passed 15 tests, every project script, and separate behavior assertions; undo restored the baseline checkout. Browser JavaScript error checks were clean.

A 5:39 recording and the delivered project are in the sibling `heimdall-demo` output folder. The recording joins the original execution and resumed delivery segments. Two automation locator mistakes are documented in its Results.txt; they were not concealed or reported as agent failures. The normal factory's authenticated connection check passed after direct launcher startup. A desktop open request alone did not start it, so successful desktop handoff is not claimed.

## UI redesign and code review (2026-10-14)

The redesigned interface was checked against a copy of the real completed greeting run at 390, 768, 1024 and 1600 pixels across all nine pages. There was no document level horizontal overflow; the graph and pipeline retain intentional internal scrolling. Eighteen automated accessibility scans passed across dark and light themes. Motion respects reduced motion preferences.

Review fixes include readable graph cards, dropdown focus trapping, visible history errors, explicit empty search results, preserved separators during plan editing, command identity reuse after a lost response, and bounded negative event limits. A browser test drops a response after source confirmation and verifies that retrying sends only one upstream command. The real source integration test types multiline outputs and dependency separators, then verifies the revised output list in Sindri.

TypeScript/build, server/core, browser, real source integration and short load/recovery checks passed. The sibling `heimdall-ui-review` folder contains screenshots, a short recording of historical run inspection, and the scope/limits report. This review does not certify perfection or constitute a new paid agent acceptance run.
