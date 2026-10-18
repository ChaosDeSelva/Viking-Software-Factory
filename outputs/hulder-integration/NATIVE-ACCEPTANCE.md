# Hulder native Factory acceptance

The native read-only integration passed live macOS acceptance on October 14, 2026.

## Use it

Start the local factory, then double-click `../Launch Hulder Factory.command`. This uses the rebuilt `../Hulder Factory Preview.app` and a separate editor profile. Choose **View → Factory**. The launcher supplies the daily controller credential-file path without embedding its contents. Set `FACTORY_DATA_DIR` for another factory data directory. Quit the preview before changing its launch environment.

When opening the app directly, use **Choose credentials** and select Mimir's `auth-token` file. The default controller is localhost port 7700. Existing older Hulder binaries do not contain this native view. Normal editor settings and the original downloaded binary were not replaced.

## Fixed

- The real task-detail endpoint now returns the task specification, including its brief.
- The native view reads the actual `task.acceptance` field rather than a nonexistent `acceptanceCriteria` array.
- Switching credential files clears prior source data before fetching the new controller.
- Added a convenience launcher with Hulder's existing accessibility option enabled. The earlier failed Factory-tab attempt was not reproduced: native menu activation worked in repeated live runs. No speculative command-routing patch was applied.

## Evidence

- Full Hulder build with pinned Rust 1.98.1, embedded assets: passed. Existing debug linker/unwind and upstream `block` future-compatibility warnings remain.
- Mimir server suite: 392 tests passed across 48 files. An initial sandboxed run could not bind local sockets/access tmux; rerunning with local integration permissions passed.
- Exact native client: three unit tests passed; live reads verified snapshot, task ID, brief and acceptance criteria against actual Mimir.
- Actual app: View → Factory opened; selecting a real task showed the correct brief and criteria.
- Disconnect removed the task list; native file-picker credential selection reconnected.
- Stopping the isolated controller displayed an explicit outage message and retained the last successful observation. Restarting it restored polling with the same persisted task.
- Inspect source record showed the complete JSON, including the specification and worktree.
- Open task worktree opened a real disposable Git worktree in another Hulder workspace. It remained in restricted mode. The worktree was created by the acceptance harness and registered as a fixture; this was not an autonomous agent delivery run.
- Open Heimdall opened the local fleet page in Chrome and showed its authentication screen. No credentials were sent in the URL.

See `native-factory.jpg` for a screenshot and `hulder-native.patch` for portable native source changes. Full source changes are also in the local Hulder checkout.

## Boundaries

The native inspector is read-only: approvals, stop and retry controls remain in Heimdall. No remote SSH/exe.dev or additional vendor acceptance is claimed. This is a local development app, not a signed/notarized distribution. Existing release runtime archives are not rebuilt by this native acceptance task; use the current local source launcher and rebuilt app.

## October 15 task handoff

The selected task is now retained when opening Heimdall. Native client URL tests,
real loopback Mimir task inspection, and the authenticated browser deep-link test pass.
The full Hulder development binary rebuilt successfully. This is still an ad-hoc
signed development bundle, with public signing/notarization deferred.
