# Policies and exceptions

Policies decide what a verification run may do and what it must prove. They are deterministic: a model can suggest a policy change, but only a person can approve one (spec §9.4).

## Layers

Policies merge in this order; a lower layer may only strengthen what a higher layer decided (ADR-006):

1. **System** (built in): destructive commands denied; dependency installation needs approval; security policies (`untrusted-source`, `destructive-commands`, `secret-exposure`, `filesystem`, `command-allowlist`, `lock-integrity`) are non waivable.
2. **Organization**: `~/.brokkr/org-policy.yaml` (optional).
3. **Project**: `policies` in `.brokkr/config.yaml`.
4. **Harness**: each composed harness's `policies` block.
5. **Task**: `policies` in the task descriptor, and a profile's `overrides.policies`.

An attempt to weaken a higher layer is ignored and recorded in the report's `warnings`.

```yaml
# .brokkr/config.yaml
version: 1
project: ravensight
harnesses:
  - { name: frontend-react, version: ^1.0.0 }
policies:
  network: deny
  allowedCommands: ["pnpm", "node", "npx"]   # argv[0] globs; lists from all layers intersect
  requiredCheckIds: [typecheck, unit]         # must exist and pass
  reviewRequired: false
```

## Categories

| Category | Enforced how |
|---|---|
| Tool execution | `allowedCommands` globs on argv[0]; argv arrays only, never a shell |
| Destructive operations | `rm -rf`, `git push --force`, `git reset --hard`, `git clean -f`, `dd`, `mkfs`, `sudo`, `sh -c`, `env -S`, ... denied after unwrapping `env`, `timeout`, `npx`, `pnpm exec`, ... |
| Network | `deny` points proxy variables at an unreachable loopback; network dependent checks are skipped (`network_denied`) unless approved. Best effort only (see `docs/limits.md`) |
| Dependency installation | `npm/pnpm/yarn install|add` needs an approval exception |
| Secret exposure | logs redacted while streaming; artifacts and generated bundles scanned; any finding blocks the run |
| Filesystem | check `cwd` must resolve inside the workspace (realpath; `..` and symlinks rejected) |
| Minimum tests | `requiredCheckIds` |
| Review | `reviewRequired` |
| Trust and integrity | untrusted harness sources and lock mismatches block the run |

Any denial before execution blocks the whole run: nothing executes and the verdict is `blocked`.

## Approval exceptions

Exceptions are records in `.brokkr/exceptions.yaml`:

```yaml
exceptions:
  - id: exception-001
    policy: check:visual-regression     # waiver of a waivable check
    scope: { project: ravensight, task: UI-142 }
    reason: Existing visual baseline is unavailable. Manual screenshot review completed.
    approvedBy: project-owner
    approvedAt: 2026-10-14T12:00:00Z
    expiresAt: 2026-10-15T12:00:00Z
    evidence: [manual-review-142]
```

Rules:

* Every exception needs an approver, reason, scope, approval time and expiry. Expired, future dated or out of scope records are ignored with a warning.
* A **waiver** (`check:<id>` or `review`) applies only to checks the harness marks `waivable: true` and no layer marks non waivable. The check is reported as `skipped (exception <id>)`, never as `passed`.
* An **approval** (`install-dependencies`, `network-access`) records who allowed a privileged action and until when.
* Security policies can never be waived.
* Every applied exception is copied into the report with the task and the exact harness versions it applied to.

### Dependency audits and the network

`security-baseline`'s `dependency-audit-pnpm` and `dependency-audit-npm` need the network, which harness policy denies. Ruling for this release: they run only with a **project level network exception for those checks (`allowNetworkFor`) that is recorded in the report**. Until the policy engine's fix round lands that key, the recorded approval is a `network-access` exception in `.brokkr/exceptions.yaml`; without it the audits are skipped with `network_denied` (they are advisory, `required: false`).

## Where to see decisions

Every report has `policyDecisions` (policy, stage, outcome, layer, check, message) and `exceptions`. Markdown and HTML reports render both.
