# Implementation plan

## Current status

The local simulator, React/Tailwind dashboard, SQLite history, SSE, static project site, Pages workflow, and automated local acceptance checks are implemented. The API currently uses Node HTTP rather than Fastify; source is JavaScript rather than TypeScript. AWS lifecycle, independent expiration, SSM commands, REST controls, and an opt in MCP bridge are implemented. Live acceptance verified a synthetic SSM command and cloud expiration. Interactive SSM sessions, reconnect records, bounded file artifacts, and automatic Mimir placement are implemented. Artifact files are limited to 12 KiB and inline Mimir requests to 4500 bytes. Mimir placement requires an approved image containing the remote runtime and authenticated harness; local acceptance uses a synthetic harness. See AWS.md for precise acceptance boundaries.

## 1. Local foundation

Create the TypeScript workspace, validated API contracts, SQLite migrations, authenticated loopback API, React/Tailwind component library, and a deterministic fake provider. Bind locally, validate browser origins, and keep credentials out of browser code and logs.

Acceptance: create, inspect, stop, and terminate simulated workers through the dashboard; recover state after restarting the local API. Clearly label simulation mode.

## 2. AWS worker lifecycle

Implement profile/SSO credential resolution, account and region inspection, approved instance/image templates, ownership tags, idempotent creation, and reconciliation with EC2. Support start, stop, reboot, and terminate. Validate image architecture against the selected instance type. Refuse mutations on resources outside this project's ownership boundary.

Acceptance: SDK contract tests cover retries, duplicate requests, partial creation, expired credentials, and cleanup failures. A separate opt in live acceptance run validates actual AWS behavior.

## 3. Independent expiration and resource accounting

Build deployable AWS side expiration and cleanup infrastructure. Configure disposable volumes deliberately, inventory dependent resources, record cleanup evidence, and surface any leftovers. Enforce limits before provisioning; treat cost estimates and budget notifications as estimates and alerts, not guaranteed spending caps.

Acceptance: prove expiration works without the local application running, and that cleanup cannot delete unrelated resources. Test cloud enforcement in a live account before claiming this safeguard works end to end.

## 4. Execution, sessions, and evidence

Add SSM readiness, commands, cancellation, terminal sessions, reconnect behavior, logs, and artifact export. Separate command state from instance state. Preserve task evidence before terminating disposable workers; report ambiguous outcomes rather than replaying commands blindly.

Acceptance: exercise disconnects, controller restarts, failed commands, output limits, unavailable SSM agents, and artifact collection failures.

## 5. Operator experience

Build worker detail pages, template management, lifecycle history, resource and spending estimates, actionable errors, and explicit termination controls. Add accessible keyboard navigation, readable typography, responsive layouts, and reduced motion support.

Acceptance: browser tests cover primary flows, loading/error/empty states, small screens, and accessibility. Show telemetry availability honestly instead of filling gaps with sample values.

## 6. Factory interfaces

Expose bounded REST and MCP tools for provisioning, inspection, execution, artifact collection, and termination. Add a Mimir integration without making the standalone app depend on the factory. Link worker evidence into Heimdall and task/delivery records into Sindri using their existing contracts.

Acceptance: run a small factory task against the fake provider, then repeat against an explicitly configured AWS environment. Keep Hulder's Bifröst name and responsibility unchanged.

## 7. Open source release

Add the selected project license, dependency notices, contribution and security documentation, reproducible builds, CI, clean machine setup instructions, and a credential free example configuration. Review image and dependency redistribution rights before packaging.

Acceptance: a new user can run simulation mode without AWS, follow documented AWS setup, and understand which provider features have live acceptance evidence. Publish no unverified parity or cost claims.

## Later scope

Resize and clone workflows, Spot recovery, additional providers, richer telemetry, and reusable prebuilt images follow the initial lifecycle and safety foundation. The architecture should allow them without claiming they already exist.
