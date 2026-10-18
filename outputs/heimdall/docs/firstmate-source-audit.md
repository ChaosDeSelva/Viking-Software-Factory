# Firstmate source audit and adaptation record

Reference revision: `a24f4cb873d87295dddbc521599c21ea86d6dc00`, retrieved 2026-10-14 from https://github.com/kunchenguid/firstmate. This is a targeted source audit of execution and supervision boundaries, not an exhaustive audit of every upstream script or a live verification of all supported harnesses.

## How the system works

Firstmate combines agent instructions with executable helpers. Its supervisor delegates work into isolated worktrees and terminal endpoints. Metadata records task identity and backend selection; shell helpers inspect those endpoints, interpret events, and coordinate recovery. Some behavior belongs to the supervising model and some is deterministic shell code. Copying instructions alone would not recreate the runtime behavior.

| Boundary | Source inspected | Behavior relevant to this factory |
| --- | --- | --- |
| Harness identity | `bin/fm-harness.sh` | Environment markers are hints; process ancestry resolves conflicts. A child can inherit another agent's markers. |
| Backend selection | `bin/fm-backend.sh` | Agent harness and terminal backend are separate. Explicit selection and recorded task metadata take precedence over guessing. |
| Terminal lifecycle | `bin/backends/tmux.sh` | Stable window IDs, bounded capture, explicit input and submission. Inventory errors must not be mistaken for an absent agent. |
| Remote routing | `bin/fm-on.sh` | Configured SSH aliases, fixed entrypoint, structured arguments, no transport level automatic resend. Exit 255 leaves completion unknown. |
| Remote execution | `bin/fm-remote-entrypoint.sh` | Protocol validation, bounded staging, worker readiness and disconnect handling belong to the remote boundary. SSH alone is not a durable job system. |
| Human hold reasons | `bin/fm-hold-reason-lib.sh` | Human explanations must round trip without lossy punctuation restrictions. Encoding is limited to the specific field. |
| Supervision policy | `bin/fm-watch.sh` header and wake classification contract | Quiet output is not proof of failure. Working, blocked, externally waiting, and unobservable states need distinct evidence. |
| Trace continuity | `docs/trace-context.md` | Propagated identity must survive recovery and remain separate from arbitrary environment/credential forwarding. |

## What we adopted now

Mimir's new `apps/server/src/ssh-runtime/transport.ts` adapts the SSH policy from `fm-on.sh`, with the upstream MIT license and attribution retained under `third_party/firstmate`. The release packager now includes that directory. Mimir uses a bounded JSON request on stdin and expects a protocol envelope. It does not accept a remote shell command from task text, forward the SSH agent, retry a mutation automatically, or substitute local execution for an unreachable host.

Five transport tests cover argument policy, hostile text remaining data, unknown completion, output/deadline bounds, and unavailable local SSH. These use executable fixtures, not a real SSH host. The transport is now wired into the selectable SSH runtime. Its remote entrypoint, durable jobs, tracked source transfer, patch retrieval and restart reconciliation have local integration tests. A real external SSH host remains an uncompleted acceptance check.

The identity review also found and fixed a local Mimir defect: changed requests sharing a launch key are now rejected, and a second key cannot overwrite an existing session ID. Nine local CLI runtime tests pass, including the new conflicting replay test.

## What requires translation rather than direct copying

Firstmate's interactive composer handling is not applicable to a noninteractive CLI process. Its hooks, account selection, trust configuration, and model specific flags are coupled to individual harnesses. Its terminal polling must map to Mimir's typed session events; task completion must still flow through Brokkr verification and Sindri delivery. Its remote home registry does not replace workspace synchronization for our local first projects.

Do not market a copied harness name as support. Each adapter needs launch, output, stop, failure, permission, restart and evidence tests. Keep unverified integrations visibly experimental.

## The intended improvement

Heimdall should expose the facts behind every status: task and attempt identity, source and last observation, host/backend/harness, current output, reason for waiting, changed files, verification result, and available human actions. Unknown observations should remain visible. The Viking design should make those facts easier to navigate, with accessible type, strong contrast and reduced motion support.

The full implementation sequence and outstanding acceptance gates are in [the release plan](factory-release-plan.md).
