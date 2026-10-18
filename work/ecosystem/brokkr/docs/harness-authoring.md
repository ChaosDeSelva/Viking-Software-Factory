# Authoring a harness

A harness is a versioned package of engineering standards for one kind of work: the skills an agent should follow, the deterministic checks that prove the work, and the policies those checks run under. This guide builds one from scratch. The built in `harnesses/qa-regression` is a complete, small example.

## 1. Layout

```
my-harness/
  harness.yaml            # manifest (required)
  README.md               # what it is for, its checks and policies
  skills/<name>/skill.yaml
  skills/<name>/instructions.md
  roles/<role>.yaml       # optional role definitions (implementer, reviewer, qa, ...)
  templates/brief.md      # optional task brief template
```

Every regular file in the directory is part of the harness digest. Symlinks, FIFOs and other special files are rejected.

## 2. Manifest

```yaml
apiVersion: brokkr.dev/v1alpha1
kind: Harness
metadata:
  name: my-harness            # kebab-case, max 64 chars
  version: 1.0.0              # semver; bump on every content change
  description: "One line: what this harness standardises"
compatibility:
  platforms: [darwin, linux, win32]
  taskTypes: [backend, api]   # used for recommendation and auto-selection
  brokkr: ">=0.1.0"           # optional
dependsOn:                    # optional: other harnesses pulled in automatically
  - { name: security-baseline, version: "^1.0.0" }
conflictsWith: []             # harness names that cannot be composed with this one
skills:
  required: [api-contracts, input-validation]
  optional: [structured-logging]
workflow:
  stages: [inspect, implement, test, review]
checks:
  - id: test
    command: [pnpm, test, --run]     # argv array, never a shell string
    required: true
    timeoutSeconds: 600
    when:
      scriptExists: [test]           # all keys must hold (AND)
policies:
  network: deny
  destructiveCommands: deny
  requireApprovalFor: [install-dependencies, modify-ci]
evidence:
  captureLogs: true
  captureTestResults: true
  captureScreenshots: false
aiReview:
  criteria:
    - "Every endpoint validates its input at the boundary"
```

### Checks

* `command` is an argv array run without a shell. Pipes, `&&`, globbing and `$VAR` expansion do not exist. Wrap complex logic in a package script or a script shipped in the harness and referenced as `{{harnessDir}}/scripts/x.mjs` (the only template placeholder; it must stay inside the harness directory).
* `cwd` is relative to the workspace and must stay inside it.
* `when` guards a check on the repository: `fileExists` (all must exist), `anyFileExists` (at least one), `scriptExists` (package scripts). Detect the project's real scripts instead of assuming a tool. A guard that does not hold marks the check `skipped` (not applicable).
* `required: true` means the verdict cannot be `passed` unless the check ran and passed. Optional checks are recorded but never decide the verdict.
* `env` lists extra variable names the check may receive; secret looking names are refused.
* `waivable` (default false) allows an approved exception to waive the check; the waiver stays visible in the report.
* `parallel: true` lets consecutive parallel checks run concurrently.
* Do not make a required check depend on the network while `network: deny`; it will be skipped with `network_denied`.

### Policies

Harness policies can only strengthen the system, organisation and project layers; a weaker value is ignored and reported. Destructive commands (`rm -rf`, `git push --force`, `git reset --hard`, `dd`, `mkfs`, `sudo`, `sh -c`, ...) are always denied.

## 3. Skills

See `docs/skills.md`. Keep each body at most 300 words with `Always`, `Never` and `Verify` sections. A skill name must be unique across every harness that may be composed with yours, unless the content is byte identical.

## 4. Roles and templates

`roles/<name>.yaml`:

```yaml
name: reviewer
description: "Reviews API changes for contract and validation issues"
skills: [api-contracts, input-validation]   # skills this harness ships
responsibilities:
  - Check the diff against each aiReview criterion
  - Never override a failed deterministic check
```

`templates/brief.md` may use only `{{objective}}`, `{{acceptanceCriteria}}`, `{{context}}` and `{{constraints}}`.

## 5. Validate, try, lock

```sh
brokkr harness validate ./my-harness       # schema, skill bodies, roles, templates, digest
mkdir -p .brokkr/harnesses && cp -R my-harness .brokkr/harnesses/   # project-local source (trusted)
brokkr harness add my-harness
brokkr harness lock                        # pin name, version and digest of every file
brokkr verify
```

From the SDK:

```ts
const brokkr = new Brokkr({ cwd: repo });
const selection = await brokkr.resolve({ task, harnesses: [{ name: "my-harness", version: "^1.0.0" }] });
```

## 6. Distributing

Share a harness as a directory or a `.tgz` with a single top level directory. Consumers pin it in `.brokkr/config.yaml` with its digest:

```yaml
sources:
  - tarball: vendor/my-harness-1.0.0.tgz
    digest: "sha256:..."
    trusted: false
```

An external source is untrusted until `brokkr trust add <source> --digest <sha256>` records it as trusted after review. Untrusted harnesses can be listed and inspected, but are never prepared or executed (ADR-003).

## 7. Checklist before release

* `brokkr harness validate` prints `is valid`.
* Every required check detects the repository's actual tooling with `when`.
* No required check needs the network under `network: deny`.
* README lists checks, policies and skills.
* Version bumped; consumers re run `brokkr harness lock`.
