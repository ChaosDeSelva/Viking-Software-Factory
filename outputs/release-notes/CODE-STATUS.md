# Code status, October 15, 2026

The factory has additional verified implementation and recovery coverage. It is not
accurate to describe the entire ecosystem as 100 percent complete.

## Security remediation

The supported Hulder editor dependency graph now has zero blocking registry advisories. All 113 targeted Rust tests pass after the dependency and authentication fixes. Source publication uses fresh history; public binary signing remains separate. See SOURCE-RELEASE-READY.txt.

## Latest changes and evidence

* Mimir server build and lint pass. All 415 tests across 54 files pass in a sequential run.
* Kimi and Grok have an ACP terminal transport with explicit permission responses,
  bounded messages, session binding and cancellation. Protocol fixtures pass.
* Rovo and AGY lifecycle hooks are wired into terminal launches. Tests cover preserved
  permissions, isolated observations, foreign conversations and safe cleanup.
* Live exe.dev tests pass for remote execution, patch return, cancellation, tmux input,
  duplicate input receipts, forced SSH client termination and VM restart recovery.
* Restart testing found missing disk flushes. Accepted job state now flushes to disk;
  expired jobs report unknown on inspection and replay without launching again.
* The remote test runtime must be flushed after deployment before a host restart.
* Extracted Mimir and Heimdall archives boot, serve HTTP and expose the remote entrypoint.
  Packaging license checks report zero violations. Skidbladnir passes 20 API, provider, recovery, artifact, terminal, and MCP tests.
* Hulder builds with the shared light palette and initial letter panel icons. Its
  development bundle was refreshed and its local signature verified.
* Skidbladnir browser checks pass on desktop and mobile with no reported accessibility
  violations. All seven documentation sites pass 21 viewport and accessibility checks.
* Managed tmux launches now use a plain shell so personal login shell configuration cannot delay agent startup.
* The dedicated exe.dev VM was deleted and a subsequent inventory confirmed it is absent.
* All 25 Mimir screen, keyboard and accessibility checks pass in light and dark modes.
* Sindri's browser flow passes through project creation, planning, execution and delivery
  using its test service configuration.

* Authenticated Codex acceptance now passes on exe.dev: it generated a greeting and
  two tests; the returned patch also passed both tests locally. Other vendors remain unverified.

* Isolated AWS acceptance passes for EC2 launch, SSM execution, independent expiration, and complete stack teardown with no tagged test volumes or VPC remaining.
* Extended live AWS acceptance passes for SHA256 verified file transfer, interactive input and output, and reconnect into a fresh shell after forced client death.
* Real SSH tests pass through 20 percent random packet loss and a complete packet blackhole; reconnection preserves job identity without duplicate execution. The test namespace was removed.
* Skidbladnir simulation and AWS fixture views pass three widths each with no detected overflow, accessibility violations, or browser errors.

## Explicit release boundaries

* Additional vendor applications and Orca ship as experimental. Authenticated live acceptance is deferred by the operator because those accounts are unavailable.
* cmux is installed but denies external control under its current security setting; that setting was preserved.
* Zellij 0.45.1 passes live input, capture, ownership refusal, control keys, and close with a test PTY attached. Detached creation remains experimental.
* Skidbladnir implements native SSM terminal launch and fresh shell reconnect, retained artifacts up to 12 KiB, and Mimir placement with inline mission envelopes up to 4500 bytes. Local placement acceptance runs the real worker entrypoint and returns a changed file. Reconnect does not restore shell variables or foreground processes. Custom AWS agent images still require their own authenticated acceptance; credentials are not copied from this Mac.
* GitHub publication and Apple distribution signing or notarization have not been done.
  Static sites and development bundles are prepared locally.

The final AWS acceptance stack and worker were removed, with no tagged volumes or VPC remaining. The source archives include current working changes. This acceptance pass did not restart the live local factory or Hulder. No public release was made.
