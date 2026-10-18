# ADR-001: TypeScript end to end

Status: Accepted (2026-10-14). Source: D-001.

## Context
Mimir has a protocol, an SDK, a server, a web UI and an adapter that speaks newline delimited JSON to HerdR. HerdR itself is Rust, which raised the question of a Rust core. Mimir only talks to HerdR over a Unix socket, so the implementation language of HerdR does not constrain ours.

## Decision
All code in Mimir (and Sindri) is strict TypeScript. No Rust. The stack is pnpm workspaces, Turborepo, Fastify, better sqlite3, Zod (schemas, generated OpenAPI and JSON Schema), React, Vite, Tailwind and Vitest. TypeScript is pinned to `~6.0.3` because typescript eslint 8.71.2 does not yet support 7.x (T2 report).

## Consequences
* One language and one set of schemas for protocol, SDK, server, UI and tests; Zod types are the source of truth (`packages/protocol/src`).
* Single binary packaging is a later question (Node SEA or Bun compile), not a language question. Until then installs are from source and run with `node`.
* Native dependency (better sqlite3) needs build approval in pnpm (`allowBuilds` in `pnpm-workspace.yaml`).
