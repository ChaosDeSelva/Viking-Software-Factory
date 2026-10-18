# M01: Scaffold and CI

Status: **done**
Phase and gate: Phase 1 / G1
Owning task(s): T2
Last updated: 2026-10-14 (T15d)

## Done so far
Status refresh 2026-10-14 (from the ledger): T2 merged.

pnpm workspace, Turborepo, strict TS, ESLint, Prettier, Vitest, Fastify server (`/v1/health`, loopback), Vite React Tailwind shell, local CI workflow `.github/workflows/ci.yml`, one command `pnpm dev`. 13 tests at completion.

## Remaining
Fresh clone `pnpm install --frozen-lockfile` was not run (T2 concern 8). Eight review minors deferred (`.sdd/reviews/T2-review.md`).

## Acceptance tests
* [ ] `pnpm check` (lint, typecheck, test) exits 0 on macOS and Linux.
* [ ] `pnpm build` exits 0 for all packages.
* [ ] `pnpm dev` serves `GET /v1/health` on 127.0.0.1:7700 and the web shell on 5173.

## Commits (local repository, no remote)
dee79a4, 20d976f, 8db0a9c, 5b0c437, cd3b85f
