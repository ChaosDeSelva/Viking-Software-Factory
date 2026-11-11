# Skidbladnir screens

Skidbladnir supplies disposable worker machines. In **simulation** (the default) nothing real is created and nothing costs money. In **cloud** mode workers are real machines that cost money until they are terminated. The mode is always shown as a badge in the bottom bar: _Simulation_, or the cloud badge with its region (hover it for the account).

The top bar has three tabs: **Worker fleet**, **Launch** and **Event history**. The bottom bar shows the connection to the local API, the mode badge, **Setup guide**, **Docs**, **Ask** and the theme menu. There is no sign-in and no session, so there is no Sign out.

## Projects

A worker can carry a factory project (for example `demo-app`). The project picker lists the projects your workers carry, plus the one you arrived with (the other apps' app switcher keeps `?project=`). With a project picked, the tabs show only that project's workers and their history; pick **All projects** for every worker. The worker limit is shared by every project.

## {{label:skidbladnir.fleet}}

Your workers and their state. The summary shows active workers out of the limit (five by default, across all projects), how many are running, and cloud spend (_$0_ in simulation; _Not measured_ in cloud mode, which does not mean free). Each worker in the list shows its template, its project (or _No project_) and when it ends. Open one for {{screen:skidbladnir.worker-detail}}.

With a project picked and no workers for it, the page says how many workers belong to other projects and offers **Launch a worker for** that project or **Show all projects**.

## {{label:skidbladnir.worker-detail}}

One worker, next to the list: its id, project, template, lifetime, creation time, expiry, provider and lifecycle buttons: **Stop**, **Start**, **Reboot**, **Terminate** (asks to confirm). In cloud mode a worker also has:

- _Remote execution_: run a shell command through the cloud's remote command service. It runs with the machine agent's privileges. **Refresh result**, **Cancel command**.
- _Terminal and files_: the command to open an interactive terminal from this machine, and **Collect artifact** for a file up to 12 KiB from `/tmp/skidbladnir-workspace`. Collected files stay downloadable after the worker is gone.

A worker in [Unknown](/docs/statuses#unknown-worker-status) keeps its slot until the cloud confirms it is gone. Check the cloud console if it stays that way.

## {{label:skidbladnir.launch}}

Start a worker: a name, an optional **Project**, an environment template, and a maximum lifetime in minutes. The project starts as the one picked in the top bar; change it or clear it (blank means no project). In cloud mode you must also confirm that real resources will be created. The worker is terminated automatically when its lifetime ends.

## {{label:skidbladnir.history}}

Everything that happened to your workers, newest first: launches, stops, expirations, commands. Follows the project picker. Select a worker to see only its history. History stays after a worker is terminated.

## {{label:skidbladnir.setup-guide}}

The bottom-bar **Setup guide** opens the setup guide page that ships with Skidbladnir (served by its local API under `/site/`): requirements, getting the source, building and running, the first session and the operating boundaries.

## Ask in Skidbladnir

Skidbladnir has no Sindri token, so it cannot ask the Guide itself. **Ask** opens a panel with questions to try and **Open the Guide in Sindri**, which opens Sindri's Overview (keeping the project) where _Ask the factory_ runs. It also links to the docs for the current screen.
