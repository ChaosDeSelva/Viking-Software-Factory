# Final implementation handoff

October 15, 2026

The supported source release is ready for GitHub repository setup after the security remediation. Public binary distribution and experimental compatibility remain separate. See SOURCE-RELEASE-READY.txt for the current verification and limits.

## Verified

* Mimir: 415 server tests across 54 files pass, with build, type checking, and lint passing. Managed tmux startup uses a plain shell so personal login configuration cannot delay agents.
* Skidbladnir: 20 local tests pass, including ownership refusal, uncertain requests, retained artifacts, API restart, terminal records, and MCP controls. Its production dashboard builds successfully.
* Dashboard browser acceptance covers simulation and AWS fixtures at three widths each, including file collection and download. No horizontal overflow, browser errors, or axe violations were detected. All seven documentation sites pass 21 viewport and accessibility checks.
* AWS live acceptance verified owned EC2 provisioning, SSM commands, independent expiration, verified file transfer, interactive terminal input and output, and reconnect into a fresh shell after forced client death.
* exe.dev acceptance verified real Codex execution, returned changes, SSH recovery, packet loss, and a packet blackhole. The dedicated VM was deleted and confirmed absent.
* The final AWS test worker and isolated stack were deleted. Tagged test volumes and VPCs are absent. Existing live workloads were not modified.
* Extracted Mimir and Heimdall packages boot and serve HTTP. Mimir dependency license checks report zero violations. Source archives retain upstream notices and exclude runtime state and credentials.

## Boundaries retained in the documentation

* Terminal reconnect opens a fresh shell. It does not restore shell variables or foreground processes. Factory missions run separately.
* Collected files are limited to 12 KiB. Mimir AWS inline mission envelopes are limited to 4500 bytes; use SSH for larger workspaces.
* Automatic AWS placement is tested with the real Mimir entrypoint and a synthetic harness. A custom AWS agent image needs Node, Git, the entrypoint, and its own authenticated harness configuration and acceptance.
* Unavailable vendor applications remain experimental, as agreed. cmux security settings were preserved. Zellij acceptance covers an attached client; detached creation remains experimental.
* GitHub publication and Apple distribution signing or notarization are not completed. Hulder retains its upstream license notices and local development signature.

## Evidence

See [Code status](CODE-STATUS.md), [AWS acceptance](../aws-acceptance/extended-result.json), and [exe.dev cleanup](../exe-dev-setup/cleanup.json). Skidbladnir setup and exact limits are in [AWS setup](../skidbladnir/docs/AWS.md).
