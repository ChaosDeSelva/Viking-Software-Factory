# Compatibility

| Sindri | Mimir SDK | Mimir protocol package | Wire protocol | Brokkr SDK |
| --- | --- | --- | --- | --- |
| Current source checkout | 0.5.1 | 0.5.1 | 1 | 0.1.0 |
| Earlier local recovery build | 0.2.0 | 0.2.0 | 1 | 0.1.0 |

For change runs, pair this Sindri checkout with a Mimir server that supports the verification-time project decision log. The first writable task waits for Sindri to confirm the accepted choices. Install or build the matching server and coordinator together.

Dependencies are local release tarballs under `vendor/`; no source imports cross repositories.
The protocol includes `tasks.requestPr` and optional task verification contracts. Approved
plans retain the full Brokkr selection and lock. Mimir stores each task's verification contract
in its event log and Brokkr checks the pinned content independently of agent controlled files.

The factory acceptance suite uses a real Mimir process and real Brokkr checks with deterministic
agent/reviewer fixtures. The separate live check used Codex through HerdR 0.9.2 (protocol 22).

## Reproduce the decision-log acceptance run

Build this checkout and the matching Mimir server, then run this command from the Sindri repository. Set both paths to existing local checkouts. The test uses temporary Git clones of the [hello-factory example](https://github.com/ChaosDeSelva/hello-factory).

```sh
SINDRI_ACCEPTANCE_HELLO_REPO=/absolute/path/to/hello-factory \
SINDRI_ACCEPTANCE_MIMIR_MAIN=/absolute/path/to/mimir/apps/server/dist/main.js \
pnpm --filter @sindri/server test:acceptance hello-decisions.test.ts
```

The test changes an approved choice during a build and again during verification, applies the full and follow-up patches, and runs the greeting tests. It also checks a later planning prompt and a second project's delivery.
