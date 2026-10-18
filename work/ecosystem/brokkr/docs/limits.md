# Known limits

Brokkr 0.1 is an alpha. These limits are deliberate or not yet addressed; each is visible in reports or docs rather than hidden.

## Execution isolation

* **No OS sandbox.** `LocalProcessExecutor` runs checks as ordinary child processes with `shell: false`, a confined working directory, a filtered environment, its own process group, timeouts and bounded output. It does not restrict file access outside the workspace, system calls or resource use. Untrusted harnesses are therefore blocked, not sandboxed (ADR-003, ADR-004).
* **Network deny is best effort.** Under `network: deny`, proxy variables point at an unreachable loopback address (`http://127.0.0.1:9`) and inherited proxies are stripped. A tool that ignores proxy variables can still reach the network. Checks known to need the network (dependency audits) are skipped with `network_denied` unless the project records an approved network exception, which then appears in the report.
* **Process tree kill** combines the process group with descendant tracking and bounded pipe draining. Same user processes that double fork and close inherited descriptors may still escape on macOS; this is not OS isolation. A narrow first sample PID reuse race remains in the tracker.
* **Resource reporting** samples the peak RSS of the check's main process only.
* **Command classification is bounded.** Known inline code channels such as `node -e`, `python -c`, command bearing Git config and shell `-c` are denied. Script files and unmodelled tools remain opaque; the classifier does not establish that arbitrary code is safe.

An orchestrator such as Mimir can inject its own sandbox aware `CheckExecutor` through the SDK.

## Trust

* The SDK defaults to `trust: 'workspace-untrusted'`. The CLI defaults to developer mode; use `--untrusted-workspace` with caller supplied configuration and lock when verifying agent work.
* Evidence is stored outside the workspace and HMAC signed, binding the canonical workspace and run store paths. Earlier manifests without those bindings are rejected. Same user code can still access the signing key by absolute path; use an isolated executor for a stronger trust boundary.
* Untrusted checks receive a scratch home, and changes to the Brokkr home block the run. This detects persistent changes; it does not prevent filesystem access or a change restored before the final snapshot.
* Run directory and bundle checks reduce path swap risks but do not provide atomic filesystem isolation against a concurrent same user attacker.
* Dependency install approvals are not yet bound to individual check IDs. Network approvals are check bound. A missing signing key is regenerated without a dedicated warning about existing runs; those runs then fail integrity verification.
* A missing `pnpm <script>` shorthand may be reported as a failed command rather than `missing_script`, because pnpm can also run binaries by name.

## Platforms

* Developed and tested on macOS (arm64). Linux is expected to work; it is not part of the local gate.
* **Windows is untested.** Process groups and signals behave differently there.
* Tarball harness sources are vetted with bsdtar output; GNU tar is untested.

## Verification semantics

* A required check whose `when` guard is not met is treated as not applicable (ruling for the B2 fix round): it is reported as `skipped` with reason `not_applicable` and does not by itself make the verdict `incomplete`. A run with no required check that actually ran is still `incomplete`, never `passed`.
* `incomplete` and `failed` share CLI exit code 1. Read `verdict` from the report to tell them apart.
* AI review is not part of the verdict.

## Supply chain and release

* Release archives are local only, with a SHA-256 checksum. They are not signed.
* No packages are published to a registry. Consumers install the tarballs from `dist-packages/`.
* **Name and trademark check (manual TODO).** Before any public release, check "Brokkr" for trademark conflicts and existing developer tool projects (spec §21.5). Not done: this project is local only.

## Performance

The spec's targets (CLI startup under 300 ms, resolution under 500 ms for 100 skills) are measured on the development machine only.
