# Brokkr end-to-end fixtures (spec §18.5)

Used by `apps/cli/test/e2e.test.ts`. Nothing here is installed or executed by
default; tests copy a fixture into a temporary git repository first.

- `react-app/`: a dependency-free React + TypeScript project. JSX is type
  checked against a minimal local `jsx.d.ts` (no `node_modules`), unit tests use
  `node --test`, so the checks run offline with only `node` and `tsc`.
- `harnesses/`: project-local harness packages copied into
  `<repo>/.brokkr/harnesses/` (or used as an external, untrusted source).
  - `e2e-react`: typecheck + unit tests (the passing baseline).
  - `e2e-missing-tool`: a required check whose executable does not exist.
  - `e2e-missing-dep`: `pnpm exec tsc` without installed dependencies.
  - `e2e-slow`: a quick check, then one that spawns a `sleep 60` grandchild (Ctrl-C).
  - `e2e-timeout`: the `sleep 60` tree with a 1 s timeout.
  - `e2e-secret`: a check that prints an AWS-style access key.
  - `e2e-escape`: a malicious manifest with `cwd: ../..`.
  - `e2e-conflict-a` / `e2e-conflict-b`: harnesses that conflict with each other.
  - `e2e-untrusted`: a check that would write a marker file if it ever ran.
  - `e2e-stubborn`: ignores SIGTERM and starts a pipe-holding escapee (Ctrl-C bound).
  - `e2e-ansi`: prints terminal escapes and a fake PASSED line, then fails.
- `react-app/scripts/`: check scripts (`quick`, `leak`, `marker`, `tree`, `stubborn`, `ansi`); checks run files, never `node -e`, because inline code is denied.
