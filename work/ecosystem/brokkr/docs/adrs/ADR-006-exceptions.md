# ADR-006: Policy precedence, approval exceptions and secret handling

* Status: accepted
* Date: 2026-10-14

## Context

Spec §9 requires layered policy (system → organization → project → harness → per task) where lower layers may only strengthen, three evaluation stages, and auditable approval exceptions that may waive only explicitly waivable requirements (§9.3). §16.4 forbids secrets in bundles and evidence.

## Decision

**Layers** (`mergePolicies`, `@brokkr/policy`):

1. system (built in): `destructiveCommands: deny`, approval required for `install-dependencies`, and the security policies `untrusted-source`, `destructive-commands`, `secret-exposure`, `filesystem`, `command-allowlist`, `lock-integrity` marked non waivable;
2. organization: `~/.brokkr/org-policy.yaml` (optional);
3. project: `policies` in the project config, or a `--policy` file (in `workspace-untrusted` mode only from outside the workspace);
4. harness: the composed harness `policies` plus `check:<id>` for checks marked `waivable: true`;
5. task: `policies` in the task descriptor, and `overrides.policies` of a selected profile.

Only the organization, project and harness layers may mark ids `waivable`; a task layer (task file or profile overrides, supplied by the planner) that tries is ignored with a warning, because making something waivable weakens policy. In `workspace-untrusted` mode harness declared `waivable` flags are ignored as well, so only organization or project policy supplied from outside the workspace can make a check waivable (audit C2).

**Network allowances** (controller ruling b): `allowNetworkFor: [checkId]` in the organization or project layer lets exactly those checks use the network even when a harness says `network: deny`. It is ignored with a warning when set by the harness or task layer, when the organization layer itself sets `network: deny`, or when any layer marks `network-access` non waivable. Each allowance is a `network-access` / `approved` policy decision with its layer and check id, and Markdown and HTML reports show a "Network allowed for" line. Ids that match no check produce a warning.

Merging: `deny` beats `allow` for `network` and `destructiveCommands`; `reviewRequired` is OR ed; `requireApprovalFor`, `requiredCheckIds` and `nonWaivable` are unioned; every `allowedCommands` list must match `argv[0]` (lists intersect). A lower layer that tries to weaken a higher layer is ignored and recorded as a warning in the report. Network is the one deliberate exception: a harness `network: deny` stays in force for every check except those an organization or project lists in `allowNetworkFor` (above) or that carry a check bound `network-access` approval (below); `allowNetworkFor` is itself ignored when the organization requires approval for `network-access`.

**Waiver precedence** (fix round 2, I2): a layer may make waivable only checks required at its own or a lower precedence layer (`requiredCheckIds`; harness required checks count as the harness layer). A project or harness marking an organization required check waivable is a policy conflict: the waiver is not granted and the run is `blocked` with `policy_conflict` and the reason.

**Command analysis** (`analyzeCommand`, fail closed; review C1, audit I5):

* Known wrappers are unwrapped with their exact option grammar: `env` (`-i -0 -v -u NAME -C DIR -P PATH`, `NAME=VALUE`; `-S`/`--split-string` denied), `timeout` (`-s/--signal`, `-k/--kill-after`, `--preserve-status`, `--foreground`, `-v`, then a duration), `nice` (`-n/--adjustment`), `nohup`, `time`, `xargs` (its full option table), `command`, `stdbuf`, `npx`/`bunx` (`-p/--package`; `-c/--call` denied), `<pm> exec|dlx` (`--`, `-r`; shell mode denied) and package manager global flags before the subcommand (`pnpm --dir/-C/--filter/-r/-w`, `npm --prefix/-w`, `yarn --cwd`, `bun --cwd`), so those flags cannot hide installs, audits or wrapped commands.
* Fail closed: an unknown wrapper flag, a missing option value, an implausible head after unwrapping (empty, numeric, a duration, `{}`, an upper case token such as a signal name, `NAME=VALUE`) and any unmodelled wrapper (`setsid`, `exec`, `ionice`, `chrt`, `taskset`, `flock`, `busybox`, `script`, `watch`, `su`, `caffeinate`, ...) are denied as `unanalyzable_wrapper`.
* Inline code is denied as `inline_code` (every string evaluation channel, fix round 2, I1): `node|bun -e/-p/--eval/--print` and `--import/--require/--loader` with `data:` or `http(s):` modules, `deno eval`, `python* -c`, `perl -e/-E`, `ruby -e`, `php -r/-B/-R/-E/-F`, `pwsh -c/-Command/-EncodedCommand`, `osascript -e`, `awk` programs, `npx -c`, `git -c`/`--config-env` with command bearing keys (`core.*`, `alias.*`, `diff.*.textconv`, `diff.external`, `filter.*`, `credential.*`, `sequence.editor`, `gpg.*`, `pager.*`, ...), `sed` scripts with the `e` command or `s///e`, `tar --to-command/--checkpoint-action/-I/-F`, `make --eval` and `vim|nvim|vi|ex -c|--cmd|+`. Heads are matched case insensitively. Shells with any option cluster containing `c`/`C` are denied as `shell -c`. A harness that needs a script ships it as a file under `{{harnessDir}}`.
* Destructive operations: `rm` with any recursive flag, `git push --force|-f|--force-with-lease|+ref|--mirror|--delete|-d|:ref`, `git reset --hard`, `git clean -f`, `git branch -D`, `git update-ref -d`, `find -delete` and `find -exec <destructive>`, `dd`, `mkfs*`, `sudo`/`doas`/`pkexec`, `rimraf`-style deletion tools, and `npm|pnpm publish` (denied as `publish`).
* This is a denylist over a modelled grammar, not a sandbox: arbitrary code in a script file or build tool runs. Not covered: sed/awk/make program files (`-f`), tools that read commands from config files in the workspace (e.g. `.npmrc` scripts, Makefiles, `git` hooks via repo config, which Brokkr's own git calls disable), and any interpreter not listed above. Untrusted harnesses never run, and `allowedCommands` remains available for stricter projects.

**Stages**

* Before: untrusted sources, cwd safety, destructive commands, allowlists, approvals, waivers and network dependent commands are decided for the whole plan. Any denial blocks the run and nothing executes.
* Runtime: network proxy variables (ADR-004) and streaming secret redaction.
* After: secret findings in logs, check artifacts and generated bundles; `requiredCheckIds`; `reviewRequired`; the verdict (ADR-005).

**Exceptions** use the file shape `{ exceptions: [ApprovedException] }` with `id, policy, scope { project?, task?, checkId? }, reason, approvedBy, approvedAt, expiresAt, evidence[]`.

Where they come from (audit C2, review I5):
* `developer` mode: `--exceptions <file>`, else `<workspace>/.brokkr/exceptions.yaml`. A file inside the workspace is recorded as a `workspace_supplied` policy source (with a warn decision), and applied exceptions carry `origin`.
* `workspace-untrusted` mode: only `--exceptions <file>` from outside the workspace or `~/.brokkr/exceptions.yaml`; and an exception counts only when its `approvedBy` is one of the caller supplied approver identities (`--approver`, repeatable). `approvedBy` is otherwise an unauthenticated string; it is not proof of approval. Signed approvals are a future step.

Rules:

* Expired, future dated or out of scope records are ignored with a warning. A scope field that is set must match the run's project (`project` in config) and task id.
* Waivers: an exception for `check:<id>` (or `review`) applies only if that id is waivable and not marked non waivable by any layer. The check is skipped and reported as `skipped (exception <id>)`, never `passed`.
* Approvals: `install-dependencies` and `network-access` are approval policies. A valid exception for them is the recorded approval (approver, reason, expiry). Without one, a dependency install blocks the run, and a network dependent check (`pnpm|npm|yarn audit`) under `network: deny` is `skipped` with reason `network_denied`. A `network-access` approval must be bound to one check, either as `policy: network-access:<checkId>` or with `scope.checkId`; an unbound one is ignored with a warning.
* Every applied exception is copied into the report with `appliedTo { task, harnesses[name@version], checkId }`.
* Security policies cannot be waived by any exception.

**Secrets**: logs are redacted line by line while streaming (cloud keys, GitHub, Anthropic, OpenAI, Slack, Stripe and npm tokens, private keys, `password=`-style assignments, and the literal values of secret named variables in the caller's environment), so raw secrets never reach disk. Text artifacts under `test-results/` and `screenshots/` are scanned and redacted at rest, and generated bundles under `.brokkr/generated` are scanned. Any finding blocks the run (`secret_exposure`). Redaction is a safety net; it does not make running a malicious command safe.

## Consequences

Policy evaluation is deterministic and fully recorded in `policyDecisions`. Exceptions are visible in every report format. The approval route for network dependent audits is explicit and expiring rather than a silent project level override.
