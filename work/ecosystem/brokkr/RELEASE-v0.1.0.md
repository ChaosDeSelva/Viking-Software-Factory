# Brokkr v0.1.0

Experimental source release candidate. This file prepares the release; no tag or public release has been created. Existing internal package versions may differ from the collection release tag.

## Tested scope

Included in the October 17 passing package run and the October 18 counter execution. Verification reports remain separate from model review decisions.

## Acceptance limits

Experimental v0.1.0 source release. Manual accessibility testing is pending. Vendor applications without authenticated live acceptance remain experimental, including Grok, Kimi, Cursor, Muse, Rovo, AGY, Devin, Command Code and Orca. Zellij and cmux compatibility also require dedicated live acceptance. Fixtures and bridge tests are not authenticated vendor tests. No universal production readiness claim is made.

The local counter report is built with all gates passed. Historical failed reviews remain intact. Manual screen reader testing is deferred to the operator. Public desktop binaries require their own build, signing and notarization checks.

## Setup

Node.js 25 or newer, pnpm and Git.

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/bin.js --help
```

Read README.md for configuration and SECURITY.md before connecting tools. Agent credentials and runtime data stay outside Git. Start with a disposable repository and inspect the plan and evidence before accepting delivery.

## Publish

Review the publication manifest and scan report for this exact candidate. Create the repository, push the reviewed source, then create the v0.1.0 tag and describe the release as experimental. For Pages, select GitHub Actions in repository settings and run Project Pages manually. Pages deploys documentation only.

Preserve the project license, dependency licenses and all upstream notices. No public binaries are attached by this preparation.
