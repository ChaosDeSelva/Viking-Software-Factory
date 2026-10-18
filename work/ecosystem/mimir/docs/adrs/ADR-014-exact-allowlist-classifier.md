# ADR-014: The exact allowlist is the command gate; the heuristic is defence in depth

Status: Accepted (2026-10-14, controller ruling in T11 fix round 4). Implementation: `packages/core/src/policy/allowlist.ts` and `classifyCommand` in `packages/core/src/policy/classify.ts`.

## Context
`classifyCommand(argv)` decides whether a shell command an agent wants to run is benign (`null`) or a privileged action that needs a policy decision. Rounds 1 to 3 built a fail closed heuristic: option tables per program, path and secret checks, a shell parser that gives up on constructs it does not model. Each review still found null classified routes to code execution or credential reads: Unicode case folding (`.huſky`, `.ßh`), `git --bare`, compilers driven by agent written configs, curl URL globs, merges of fetched refs and protected branch ref moves. The space of shell, tool and filesystem behaviour is too large for a heuristic to be complete. A guard that says "benign" whenever it does not recognise a danger fails open.

## Decision
* Policy mode `exact-allowlist` is the default (`DEFAULT_POLICY_MODE`). In this mode `classifyCommand` returns `null` only when **both** of these hold:
  * `argv` matches an entry of the project configured allowlist (`options.allowlist`, default `defaultAllowlist()`).
  * The heuristic raises nothing about the command. A specific action (`shell.destructive`, `network.external_write`, `secret.read`, `package.install`, `git.*`, `fs.delete_outside_worktree`) always wins. The heuristic's `shell.unclassified` is kept for programs it models; for programs it does not model, a project entry is the operator's statement that the command is fine.
* Everything else is `shell.unclassified`, which requires approval by default.
* An allowlist entry is `{ argv0, args }`. `argv0` is compared exactly, so `./ls` and `/bin/ls` do not match `ls`. `args` is one of:
  * `"none"`: no arguments.
  * `{ exact: [...] }`: exactly these arguments.
  * `{ shape: { prefix?, maxArgs, allowFlags?, numericFlags?, forbidFlags?, forbidChars?, pathArgsMustBeInsideWorktreeAndNonSensitive } }`.
* Path arguments in a shape must resolve inside the worktree with a known cwd, must not be under `.git`, and must not be credential paths or credential basenames (`.npmrc`, `.netrc`, `credentials`, ...). Comparisons use NFKC plus full case folding (`foldPath`).
* A cwd outside the worktree matches nothing.
* `defaultAllowlist()` contains:
  * `pnpm test|lint|typecheck|build|check` and `pnpm run`, `npm run`, `yarn run` of those names, plus `npm test`
  * `git status|log|diff|show` with an allowlist of display flags (no `--ext-diff`, `--textconv`, `--output`, `-c` or `-C`)
  * `ls`, `pwd`, and `cat`/`head`/`tail` on worktree paths
  * `echo` without `$`, backticks, redirect, pipe or separator characters
  * `node --version` and `python3 --version`
* Mode `heuristic` keeps the option table classifier as the only judge. It exists for tests and for operators who opt in explicitly.
* The heuristic keeps being refined. It is defence in depth: it catches specific actions inside allowlisted shapes (`git show HEAD:.env` gives `secret.read`), and it labels non allowlisted commands more precisely for the approver. It will never be complete, and nothing relies on it being complete.

## Consequences
* Anything not on the allowlist needs a human approval or a policy rule, including `bash -c` lines, `git commit`, compilers (`tsc`), and arbitrary tools. Projects extend the list for their own workflow. That is a configuration change the operator reviews, not something an agent can do.
* Residual risk: allowlisted package scripts (`pnpm test`, `pnpm typecheck`) run whatever the project's `package.json`, test files and tool configs say. The operator trusts the project's own scripts. An agent that edits those files, through its own edit tool or through an approved command, can change what an allowlisted script does. The heuristic makes shell writes to `package.json`, tool configs, `tsconfig*.json`, `.husky/`, `.claude/` and `.git/` unclassified, but it cannot see edits made outside the shell.
* Enforcement is in the orchestrator (T12). On `main` nothing outside `packages/core/src/policy` calls `classifyCommand` yet. When T12 wires it in, it must pass `worktree`, `cwd`, `currentBranch` and the project's allowlist.
