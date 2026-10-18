# Viking software factory

A collection of independent local tools for turning an idea into a plan, agent execution, verification evidence and delivery you can inspect.

| Project | Responsibility | License |
| --- | --- | --- |
| Sindri | Specifications, plans, dependencies and delivery | Apache 2.0 |
| Mimir | Crews, scheduling, execution, controls and event history | Apache 2.0, with attributed MIT adaptation |
| Brokkr | Engineering harnesses and deterministic verification | Apache 2.0 |
| Heimdall | Operator interface and live source visibility | Apache 2.0 |
| Skidbladnir | Local simulation and owned AWS workers with SSM and expiration | Apache 2.0 |
| Bifrost | Local MCP bridge and Hulder native integration | GPL 3.0 or later |
| Hulder | Independent native editor with optional factory inspection | GPL 3.0 or later, with component licenses retained |

This is a source preview with working changes listed in SOURCE-MANIFEST.json. No GitHub account is required to run locally. Agent providers require their own installed and authenticated tools. Model requests can use the network.

## Build and run

Install Node 25 or newer and pnpm 12.11.2. On macOS, run `./build.sh`, then `./outputs/local-factory/Start\ Factory.command`. The launcher uses Codex execution and Claude Code planning and review by default. Read each project README for its setup and API configuration.

The operator interface is at http://127.0.0.1:4320. Keep terminal access and approval codes private. Stop the launcher with Control+C. State is stored under `work/local-factory/daily` by default. Set FACTORY_DATA_DIR to choose another private directory. Never commit runtime state.

Skidbladnir is in `outputs/skidbladnir`. AWS setup is documented there in `docs/AWS.md`; it requires an explicit account, region and isolated fleet configuration. Do not point acceptance tests at existing workloads.

## Verification and limits

Real Codex execution and SSH recovery were verified on exe.dev, including packet loss and a network blackhole. AWS acceptance verified provisioning, SSM, independent expiration, artifacts and terminal reconnection. Disposable test resources were removed. These are recorded acceptance results, not a promise of compatibility with every future provider version.

Read `work/ecosystem/mimir/docs/runtime-support.md` for supported and experimental agent profiles. Vendors without authenticated acceptance remain experimental. SSM terminal reconnect starts a fresh shell. Collected AWS artifacts are limited to 12 KiB, and inline Mimir AWS mission envelopes to 4500 bytes. Use SSH for larger workspaces.

Hulder and Bifrost have separate source repositories. The `outputs/hulder-integration` directory contains factory integration helpers, not an embedded copy of the IDE. Its supported target is Apple silicon macOS. Preserve its upstream licenses and attribution, and follow its SECURITY.md and RELEASE.md. Public Mac binaries are a separate signing and notarization step.

## Contributing and publishing

Read the individual CONTRIBUTING.md and SECURITY.md files. Preserve service ownership checks, explicit human approvals and verification evidence. See `outputs/release-notes` for the release status and documented boundaries.

Eight project websites are included in `outputs/github-pages`. The manual Pages workflow publishes that complete directory. Independent projects also contain their own site directories. GitHub repositories and Pages deployments are created by the operator.

The root Apache license covers this collection's original integration files. Each included project and dependency retains its own license; the root license does not replace Hulder's GPL or any upstream notices.

## Experimental release status

The planned public source tag is `v0.1.0`. See [release scope and setup](RELEASE-v0.1.0.md) for tested behavior and acceptance limits. Manual accessibility testing is pending. Vendor integrations without authenticated live acceptance remain experimental.
