# Contributing

Use Node.js 24 or newer. Run `npm ci`, `npm test`, and `npm run build` before proposing changes. UI changes should also pass the documented browser acceptance flow.

Keep provider behavior behind an explicit interface. Never represent simulated events as cloud acceptance. Never add implicit provisioning, auto approved agent permissions, credentials in browser code, or globally modified cloud configuration.

Cloud work must include ownership validation, bounded retries, idempotency, reconciliation, and cleanup evidence before it is exposed as available. Add tests for failures and ambiguous outcomes, not only successful requests.

Changes are contributed under Apache-2.0. Preserve third party licenses and document new distributed assets. Do not include account identifiers, tokens, or private logs in public issues.
