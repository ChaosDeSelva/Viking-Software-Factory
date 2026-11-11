# Execution profile

An execution profile tells Sindri how one project's repository is checked and what its tools
need from the environment. It is operator configuration: it is stored with the Sindri project,
set only through the authenticated API, and never read from the repository or a worktree.

Without a profile nothing changes: plans use Brokkr's built-in harnesses, chosen by task type.
Those run `pnpm` scripts, so a repository that is not a Node project needs a profile to pass
verification.

## Fields

Every field is optional. An empty profile (`{}`) is the same as no profile.

| Field                        | Meaning                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `checks[]`                   | The commands that verify a change. At most 20; at least one must be required.                        |
| `checks[].id`                | Lowercase letters, digits, `.`, `_`, `-`. Unique within the profile.                                 |
| `checks[].title`             | A label for people. Not part of the generated harness.                                               |
| `checks[].command`           | The argv array, run without a shell. 1 to 64 non-empty strings.                                      |
| `checks[].cwd`               | Directory to run in, relative to the repository root. It cannot leave the repository.                |
| `checks[].timeoutSeconds`    | Default 600.                                                                                         |
| `checks[].required`          | Default `true`.                                                                                      |
| `network`                    | `deny` (default) or `allow`, for the checks.                                                         |
| `env`                        | Variables the checks and the agents need, as `NAME: value`. At most 64.                              |
| `pathPrepend`                | Absolute directories put first on `PATH`.                                                            |
| `codexSandbox.writableRoots` | Absolute directories a Codex agent may write to besides its worktree.                                |
| `codexSandbox.networkAccess` | Whether a Codex agent's sandbox has network access.                                                  |
| `verificationTimeoutMs`      | Sent to Mimir as the project's `verificationTimeoutMs`. 1000 to 86400000.                            |

Rejected with `422 validation_failed`: unknown keys; a `cwd` that is absolute or contains `..`
leading outside the repository; `env` names that are not `[A-Za-z_][A-Za-z0-9_]*` or are one of
`PATH`, `HOME`, `GIT_*`, `LD_*`, `DYLD_*`, `MIMIR_*`, `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`,
`ENV`, `ZDOTDIR`, `PYTHONSTARTUP`, `PYTHONPATH`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`,
`JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`; paths in `pathPrepend` and `writableRoots` that are not
absolute, are `/`, or contain `:` or `..`.

## API

Both routes need `Authorization: Bearer <token>` (`sindri token show`). The write needs an
`Idempotency-Key` header, like every other write.

| Method | Path                       | Body        | Response                                        |
| ------ | -------------------------- | ----------- | ----------------------------------------------- |
| GET    | `/v1/projects/:id/profile` |             | `{ profile }`                                   |
| PUT    | `/v1/projects/:id/profile` | the profile | `{ profile, harness: { name, version } \| null }` |

`PUT` replaces the whole profile. `harness` is `null` when the profile has no checks.

```sh
SINDRI=http://127.0.0.1:7800        # your Sindri server
TOKEN=$(sindri token show)
PROJECT=<project id from GET /v1/projects>

curl -sS "$SINDRI/v1/projects/$PROJECT/profile" -H "Authorization: Bearer $TOKEN"

curl -sS -X PUT "$SINDRI/v1/projects/$PROJECT/profile" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data @profile.json
```

## What Sindri does with it

**Checks become a Brokkr harness.** A profile with checks is written as a harness to
`~/.brokkr/harnesses/<name>/harness.json`, Brokkr's directory for user harnesses, which both
Sindri's and Mimir's Brokkr load as trusted. The harness holds the checks (command, `cwd`,
timeout, required), the network policy and the _names_ of the `env` variables; values are not
written there. Listing a name lets Brokkr pass that variable to a check; the value comes from
the environment Mimir gives the verification run, which Sindri configures through the Mimir
project settings described below. `pathPrepend` reaches the checks the same way.

The name is `sindri-<project name as a slug>-<8 hex digits of a hash of the harness content>`,
version `1.0.0`. A different set of checks is therefore a different harness in a new directory.
Sindri never rewrites or deletes a generated harness directory: a plan is locked to the digest
of the harness it was approved with, and that content has to stay available for it. Directories
you no longer need can be removed by hand once no unfinished plan uses them.

**Plans use that harness.** With `brokkrEnabled` on, every task of a plan for the project
(implementation, review, security, docs, QA) is resolved against the generated harness instead
of the built-in ones. Plans proposed before the profile was saved keep the harness they were
approved with; propose a new plan to use the new checks. With `brokkrEnabled` off, Sindri uses
its fixture harnesses and the profile's checks have no effect on plans.

**Mimir gets the environment.** When an execution starts, Sindri creates the Mimir project
with these settings, or updates an existing Mimir project whose values differ
(`PATCH /v1/projects/:id`):

```json
{
  "agent": { "env": {}, "pathPrepend": [], "codexSandbox": {} },
  "verificationTimeoutMs": 0
}
```

Only the fields the profile sets are sent; other settings of the Mimir project are kept. A
Mimir build without the `PATCH` route answers 404 or 405; Sindri logs a warning and continues
with the Mimir project unchanged.

## Things to know about how Brokkr runs the checks

- Commands are argv arrays, not shell lines. Brokkr refuses to run commands it classifies as
  destructive, which includes inline code such as `sh -c '...'` or `node -e '...'`. Put the
  logic in a script or a Makefile target and call that.
- A check gets a small fixed set of variables (`PATH`, `LANG`, `TMPDIR` and a few others) plus
  the names listed in the profile's `env`. Brokkr does not pass names that look like
  credentials (for example names containing `TOKEN`, `SECRET`, `PRIVATE` or ending in `_KEY`),
  even when listed.
- `HOME` and the `XDG_*` directories of a check point at an empty temporary directory. A tool
  that keeps caches under the home directory needs them pointed elsewhere through `env`.
- `network: deny` points the proxy variables at an unreachable address. It is not a sandbox.
- While Brokkr verifies a task it blocks the run (`home_tampered`) if anything under `~/.brokkr`
  other than its `runs` directory changes. Saving a profile with new checks writes a new
  directory there, so do not change a profile's checks while a verification is running.

## Example: a Go monorepo

The code lives in `services/api` and is checked there with `make lint` and `make test`. Go
is provided by a tool-shim directory, and the Go build and module caches live outside the
repository. The paths below are examples; use the ones on your machine.

```json
{
  "checks": [
    {
      "id": "lint",
      "title": "make lint",
      "command": ["make", "lint"],
      "cwd": "services/api",
      "timeoutSeconds": 900
    },
    {
      "id": "test",
      "title": "make test",
      "command": ["make", "test"],
      "cwd": "services/api",
      "timeoutSeconds": 1800
    }
  ],
  "network": "deny",
  "env": {
    "GOCACHE": "/Users/me/factory-cache/go-build",
    "GOMODCACHE": "/Users/me/factory-cache/go-mod"
  },
  "pathPrepend": ["/Users/me/.local/share/mise/shims"],
  "codexSandbox": {
    "writableRoots": ["/Users/me/factory-cache/go-build", "/Users/me/factory-cache/go-mod"],
    "networkAccess": false
  },
  "verificationTimeoutMs": 2700000
}
```

Notes for this example:

- `GOCACHE` and `GOMODCACHE` are set because a check's `HOME` is an empty temporary directory,
  where Go would otherwise start with empty caches.
- `codexSandbox.writableRoots` lists the same two cache directories so a Codex agent can build
  and fetch modules into them.
- `make lint` may need the network if the Makefile downloads its lint tools or modules on first
  use. Either warm the caches beforehand, or set `"network": "allow"`.
- The response to the `PUT` names the generated harness, for example
  `{ "name": "sindri-services-api-1a2b3c4d", "version": "1.0.0" }`.
