# ADR-004: Executor abstraction and the local process executor

* Status: accepted
* Date: 2026-10-14

## Context

Spec §8.3 and §12.3 require command allowlists, working directory restrictions, environment filtering, timeouts, output limits, cancellation and artifact capture, behind an injectable `CheckExecutor` so Mimir can run checks inside its own worktrees and security boundaries. The standalone runner cannot claim OS level isolation (§16.3).

## Decision

**Interface** (`@brokkr/runner`): `CheckExecutor.execute(request, signal?) → CheckExecutionResult`. The request carries an argv array, the workspace, a relative `cwd`, the complete environment, a timeout, the log file, output limits, a kill grace period and an optional redactor factory. Policy decisions happen before it is called. The executor adds only `BROKKR_CHECK_TOKEN` (a per check UUID used to find descendants) and `npm_config_verify_deps_before_run=false` / `pnpm_config_verify_deps_before_run=false` (pnpm 10+ would otherwise install dependencies before `pnpm test`/`pnpm run`, bypassing the install dependencies approval and hanging behind the deny proxy).

**LocalProcessExecutor**

* `spawn(argv[0], argv.slice(1), { shell: false })`: shell metacharacters are passed literally.
* The working directory is resolved with `realpath` and must stay inside the workspace realpath; `..` and symlink escapes are rejected before spawning (`cwd_rejected`). The manifest schema already rejects `..` and absolute paths; this is defence in depth.
* Each check runs in its own session and process group (`detached: true`). Timeout sends SIGTERM to the group, then SIGKILL after 5 s (configurable); cancellation (Ctrl C) uses a 1 s grace so the partial report is written promptly. The deadline bounds the main process; once it has exited, post exit cleanup is bounded separately and never turns the result into a timeout.
* **Escaped descendants** (audit I1). A `ProcessTracker` follows the check's descendants while it runs: on Linux by session id and the inherited `BROKKR_CHECK_TOKEN` read from `/proc` (both survive reparenting); on macOS, whose `ps` exposes neither, by sampling the ppid tree at 100 ms, doubling to every 2 s (escapes happen early; each `ps` is a process spawn). A ppid link is followed only while the parent is the exact recorded process (pid and start time), so recycled pids never pull unrelated processes in. After the main process exits the group is killed, every tracked descendant still alive outside the group is SIGKILLed, and the check fails with `orphaned_descendants` (never `passed`). Output pipes still held after a bounded drain are attributed with `lsof` on macOS and their holders killed; if the pipes are still open they are closed and the check fails.
* Residual gap: on macOS a descendant that forks, calls `setsid` and loses its parent between two samples, and that does not hold the output pipes, is not found. Only a sandbox executor (or a separate OS user) closes this.
* Output from stdout and stderr is decoded, passed through a per stream line redactor, streamed to `logs/<checkId>.log` (in the run directory under `~/.brokkr/runs/`, outside the workspace) up to a total cap (default 10 MiB, then a truncation marker), and only the last 64 KiB is kept in memory. The terminal shows output with control characters stripped.
* Peak RSS of the main process is sampled (every 250 ms from `/proc/<pid>/status` VmHWM on Linux; every second with `ps -o rss=` on macOS, since each `ps` is a process spawn). It is reported when available and is a sample, not an exact high water mark of the whole tree.
* States: exit 0 → `passed`; non zero → `failed`; spawn failure, death by a signal Brokkr did not send, or escaped descendants → `errored` (`orphaned_descendants`); deadline → `timed_out`; abort → `cancelled`. Partial output is always kept.

**Environment** (`buildCheckEnv`): an explicit allowlist (`PATH HOME USER LOGNAME LANG LC_ALL LC_CTYPE TERM TZ TMPDIR CI`) plus the keys a check lists in `env`. Names that look like credentials (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `ACCESS_KEY`, `AUTH`, `*_PAT`, `*_KEY`, `*_DSN`, ...) and loader/interpreter injection variables (`NODE_OPTIONS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `GIT_*`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`, ...) are refused even when a harness asks for them, with a warning in the report. Values of secret named caller variables and of URLs with `user:password@` are redacted from output. `HOME` is inherited, so checks can read the user's dotfiles (`~/.npmrc`, `~/.aws`, `~/.brokkr/key`); only a sandbox or separate user prevents that. Brokkr adds `BROKKR_CHECK_ID`, `BROKKR_TEST_RESULTS_DIR` and `BROKKR_SCREENSHOTS_DIR` (per check artifact directories; the run directory itself is not exposed).

**Network** is enforced best effort: inherited proxy variables are always stripped; with `network: deny` every proxy variable points at `http://127.0.0.1:9` and npm, pnpm and yarn are put in offline mode so they fail fast. Tools that ignore proxy variables can still reach the network. Real isolation needs a sandboxed executor (for example one supplied by Mimir).

**Binary identity** (fix round 2, C1): command names are classified case insensitively (`Rm`, `Bash`, `GIT` hit the rules of `rm`, `bash`, `git`, since APFS and Windows file systems are case insensitive). Preflight also identifies the binary a check actually runs: the lower cased basename of its realpath, or, if that is not a classified name, the classified command whose PATH entry has the same device and inode. A check whose binary is an alias of a denied command (symlink, hard link, case variant) is denied (`policy_denied`, destructive commands) and blocks the run.

**Command templates** (`preflightCheck`, spec §5.2) run before execution:

1. `{{harnessDir}}` is replaced with the declaring harness directory; the result must stay inside it lexically and after `realpath`. Other placeholders are rejected (`invalid_command`, errored).
2. The cwd check above.
3. `when` conditions combine with AND: every `fileExists` path, at least one `anyFileExists` path, every `scriptExists` script. Any unmet guard → `skipped/not_applicable` (ADR-005).
4. The executable must be on the filtered `PATH` (or exist, for paths) → otherwise `skipped/missing_tool`.
5. `npm|pnpm|yarn|bun run <s>`, `test`, `start` need the script in `package.json` → `missing_script`.
6. `pnpm exec|npx|yarn exec|bunx <bin>` need the binary in `node_modules/.bin` (cwd up to the workspace root) or on `PATH` → `missing_tool` with an install hint.
7. A package script run in a package that declares dependencies but has no `node_modules` would make the package manager install first: it is denied as `policy_denied` (install dependencies, verdict `blocked`) unless an install dependencies approval applies.

A required check skipped for any reason other than `not_applicable` makes the verdict `incomplete` (ADR-005), never a pass.

**Parallelism**: checks run sequentially in manifest order; consecutive checks marked `parallel: true` run concurrently as one group.

## Consequences

Mimir can inject an executor without changing policy or verdict logic. The local executor is honest about what it cannot guarantee: no filesystem or network sandbox, descendant tracking that is complete on Linux but sampled on macOS, sampled memory. Untrusted harnesses therefore never reach any executor (ADR-003, ADR-006).
