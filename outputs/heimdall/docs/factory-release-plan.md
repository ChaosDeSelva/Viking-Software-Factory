# Viking factory: implementation and release plan

This is a working plan, not a claim of completion. Target: a local first factory with inspectable execution and optional remote workers. GitHub is not required for use. No public release until the acceptance gates below pass.

## Architecture and ownership

Sindri owns specifications, plans, dependencies, and delivery. Mimir owns missions, crews, execution, supervision, and control. Brokkr owns verification evidence. Heimdall presents these sources without inventing success. Herdr supplies an interactive terminal backend; Hulder supplies the native IDE. Agent harness, session backend, and execution host are independent choices.

## Work sequence

| Stage | Work | Acceptance gate | Current status |
| --- | --- | --- | --- |
| 1. Source audit | Pin the upstream terminal reference source; inspect harness, backend, supervision, remote, and recovery implementations; record reuse provenance | Every adopted behavior has a source or explicit original design; reused code retains license | Pinned source audit and MIT-attributed SSH adaptation complete |
| 2. Interface foundation | React/Vite/Tailwind library, accessible dialogs and selectors, command palette, graph worker, Viking visual identity | Keyboard, contrast, overflow and real history checks; no stale worker updates | Implemented; baseline/component browser tests and fresh 36-viewport, 18-accessibility real history review passed |
| 3. Explainable operations | Show execution identity, live output, blockers, worktree/diff, verification evidence, approvals and consequences | A small real mission can be understood and controlled entirely from Heimdall | Existing details/control flows validated through source API and browser integration; remote uncertainty uses source session states |
| 4. Harness coverage | Explicit profiles with executable/version checks, launch arguments, output parsing, stop and permission behavior | Per profile contract tests; real installed agent tests separately identified | Codex/Claude baseline; OpenCode/Gemini/Pi profiles and settings added, fixture tested, experimental until authenticated vendor runs |
| 5. Session backends | Keep direct CLI and Herdr; add tmux; assess Zellij/cmux/Orca behind explicit capability flags | Launch, capture, input where supported, stop, identity and restart reconciliation | CLI/Herdr retained; managed and interactive tmux implemented, including real binary restart/input test; Zellij/cmux/Orca bridges implemented and experimental |
| 6. Remote workers | SSH transport, fixed structured entrypoint, durable job identity, workspace transfer, evidence return, disconnect reconciliation | Local transport/protocol tests; real SSH mission, disconnect and restart test on supplied host | Durable SSH jobs and capacity aware multi worker fleet implemented; source transfer, patch return, cancellation, uncertain placement and restart tested locally; external host deferred |
| 7. exe.dev | Optional SSH host recipe, preflight, private preview guidance; later explicit provisioning | Same remote contract as other SSH hosts; no hidden provisioning or spending | SSH recipe and optional provisioning client implemented with fixture tests; no VM created or external acceptance run |
| 8. Hulder | Inspect existing Herd/Bifrost integration; add usable factory entry points; update README and supplied banner | Local IDE to factory workflow demonstrated; existing upstream licenses preserved | Banner, README, factory tasks, fleet deep link and read only MCP context bridge installed; helper and MCP contracts checked; native GPUI unchanged |
| 9. Open source | License inventory, attribution, dependency notices, contributor/security docs, honest READMEs, banner prompts, clean release archives | Secret and machine path audit; clean install from archive; licenses included | Apache licenses retained, the upstream terminal reference MIT attribution included, frontend notices generated, contributor/security docs and banner prompts added; source snapshot clean build passed; runtime archives boot tested; license notices and source scan included |
| 10. Release rehearsal | Tiny end to end idea, human gate, failure/retry, restart, evidence/diff inspection; record fixed size video | Reproducible commands, report, screenshots/video, known limitations | Fresh real history UI review and real source workflow test passed; remote worker tested with tiny fixture agent; extracted runtime boot/remote-entrypoint/license smoke passed; final UI walkthrough recorded |

## Release truth rules

* Fixture tests prove contracts, not live agent/vendor compatibility.
* Unknown transport completion is neither success nor failure. Reconcile the same job on the same host before deciding whether to retry.
* A successful process exit is not a verified delivery. Brokkr evidence and delivery state remain separate.
* Never claim broad backend parity based only on configuration entries or copied scripts.
* The real SSH acceptance gate stays pending until the operator supplies a host. Local use must remain independent of it.
* Public claims should name measured improvements (inspection depth, recovery behavior, setup, accessibility), not claim blanket superiority over the upstream terminal reference.

## Source provenance

See the retained third party source notice for authorship, license and adaptation details.

## Subsequent parity pass

Implemented fleet scheduling and drain controls, durable parent/child supervisors
with bounded Codex/Claude decisions and fenced action enqueue, local native
terminal bridges, SSH interactive tmux sessions, 15 interactive launch profiles,
seven automatic lifecycle/notification integrations, exe.dev provisioning
receipts, Hulder context tools, and six Pages sites using the supplied artwork.

See `../../open-source-release/PARITY-REPORT.md` in this workspace for current
evidence and compatibility limits. Eight additional launch profiles expose
process/terminal state without automatic semantic hooks; those adapters remain
experimental. Real remote host and native/vendor application acceptance is
separate from local protocol and fixture testing. Public release remains gated
on those applicable acceptance checks; this is not a blanket claim of equivalence
to every behavior in the upstream terminal reference.
