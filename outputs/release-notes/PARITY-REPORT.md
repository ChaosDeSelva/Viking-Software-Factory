# Factory implementation and acceptance

The latest evidence and remaining work are maintained in [Code status](CODE-STATUS.md).

Implemented factory capabilities include fleet placement, durable supervision,
SSH execution, interactive terminal control, task inspection, human approvals,
returned changes and native Hulder integration. Fifteen interactive profiles are
available, with observation coverage reported individually. Kimi and Grok use ACP;
Rovo and AGY now have lifecycle hook wiring. Vendor authentication and application
compatibility remain separate from fixture coverage.

Live exe.dev acceptance now covers a dedicated test VM, including restart recovery.
A restart exposed missing disk flushes; those are fixed and the repeated test passes.
Recovery checks use a deterministic agent. A separate authenticated Codex coding run
also passes, including local verification of the returned tests.

All seven static project sites have initial letter branding, supplied artwork and
responsive light styling. Publication is pending. Hulder preserves required upstream
license attribution and remains a locally signed development build.

Skidbladnir now implements AWS provisioning, SSM shell commands, independent expiration, and REST/MCP worker tools. Isolated live acceptance and complete teardown passed. Native terminals, fresh shell reconnect records, retained artifacts up to 12 KiB, and Mimir placement for inline mission envelopes up to 4500 bytes are implemented. The placement contract is tested with a real remote entrypoint and synthetic agent. Custom AWS agent images need separate authenticated acceptance. Vendor adapters ship as experimental without claiming authenticated acceptance.
