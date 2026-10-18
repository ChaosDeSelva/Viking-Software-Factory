<p align="center"><img src="site/assets/skidbladnir-banner.png" alt="Skidbladnir, a Norse longship beneath the northern lights" width="100%"></p>

# Skidbladnir

**A fleet when you need it. Gone when you don’t.**

A local first project for disposable development environments. Use the local simulator or configure an isolated AWS fleet with independent expiration, SSM commands, and optional MCP worker controls.

**Early development with live AWS acceptance evidence.** EC2 provisioning, SSM command execution, and independent expiration have been exercised in an isolated account environment. Native SSM terminals, bounded file artifacts and approved image mission placement have implementation and fixture coverage. Custom agent images and broader account configurations require live acceptance.

## Try it locally

Requires Node.js 24 or newer and npm. From this directory:

```sh
npm ci
npm run build
npm test
npm start
```

Open **http://127.0.0.1:4380**. No AWS account or credentials are needed. The application binds only to loopback.

## What works today

* React and Tailwind dashboard with shared UI components and responsive worker details.
* Create, stop, start, reboot, and terminate simulated workers.
* SQLite state and event history that survive API restarts.
* Server sent events for live updates and automatic connection recovery.
* Validated templates, five worker capacity limit, and explicit maximum lifetimes.
* Local expiration, reconciled on API startup/read; termination preserves history.
* Optional AWS provider with approved images, ownership checks, launch identity, reconciliation, and independent cloud expiration.
* SSM commands and results plus an opt in MCP control bridge; see [AWS setup](docs/AWS.md).
* Same origin mutation checks, session tokens, host validation, and private local data directory.

Simulation is always labeled. Templates are metadata in simulation; no language runtime or virtual machine is started. Local expiry runs only while the API is running and reconciles afterward. It is **not** independent AWS side enforcement. The displayed zero cloud spend means this simulator creates no cloud resources, not that AWS is free.

## Project website

`site/` is a complete static landing page with setup instructions and explicit acceptance limits. It is separate from the local control dashboard and contains no API access or credentials.

```sh
npm run preview:site
```

Open **http://127.0.0.1:4381**. See [GitHub Pages setup](docs/GITHUB-PAGES.md) for publication. No repository or public deployment URL has been assigned yet.

The supplied moonlit Skidbladnir illustration is used in this README and on the site. Its original [art direction prompt](docs/BANNER-PROMPT.md) is retained for reference.

## Architecture

```text
apps/api/              Loopback HTTP API, SQLite, SSE
apps/web/              React + Tailwind dashboard and components
packages/contracts/    Shared request validation
packages/providers/    Local simulator and AWS provider
packages/integration/  Stdio MCP worker tools
site/                  Static GitHub Pages site
infra/aws/             Expiration and isolated acceptance templates
```

The current API uses Node's HTTP and SQLite modules, keeping the simulator dependency footprint small. The API uses the AWS CLI for resource controls and the official AWS SDK for terminal connections. Fastify and a TypeScript migration are not prerequisites for this implementation.

Bifröst remains Hulder's MCP bridge. Skidbladnir is a separate project. REST and MCP worker controls are implemented. Mimir can place bounded missions on approved AWS workers and return results through its existing factory runtime contract. See the setup and limits below.

## Verification

`npm test` covers lifecycle transitions, concurrent capacity enforcement, validation, same origin protections, persistence, expiration, and SSE updates.

For isolated dashboard acceptance, run `node tests/browser-isolated.mjs`; it creates disposable API servers and requires no AWS credentials. To run the separate website and dashboard acceptance, start both local servers above, install the Playwright browser with `npx playwright install chromium`, then run `npm run test:browser`. It exercises the landing page preview and dashboard lifecycle, checks mobile overflow, runs axe accessibility analysis, and saves screenshots in `docs/`. Browser acceptance creates and terminates a labeled simulated worker; it leaves that history available.

## Next milestones

See [PLAN.md](docs/PLAN.md) for the full sequence: AWS lifecycle, independent expiration, SSM execution and artifacts, operator experience, factory APIs/MCP, and release acceptance. See [AWS setup and boundaries](docs/AWS.md) for the implemented behavior and terminal, artifact, and mission size limits.

## Open source

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md). Do not commit `.data/`, credentials, or local logs. The Pages workflow publishes only `site/`.

## Experimental release status

The planned public source tag is `v0.1.0`. See [release scope and setup](RELEASE-v0.1.0.md) for tested behavior and acceptance limits. Manual accessibility testing is pending. Vendor integrations without authenticated live acceptance remain experimental.
