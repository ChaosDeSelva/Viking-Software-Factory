# Finding your way

All four apps share one layout.

## Top bar: this project

The top bar holds the app switcher, the **project picker** and the tabs for the selected project. Every top-bar page shows only the selected project's data, or says **All projects** in its header when it shows everything. The app switcher keeps the selected project when you jump between Sindri, Mimir, Heimdall and Skidbladnir. On global pages the picker is disabled, because they cover every project.

| App         | Top bar                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sindri      | Overview; **Intake**: Inbox, Director; **Define**: Specs, Plans; **Execute**: Runs, Needs you; **Ship & learn**: Deliveries, Knowledge, Autonomy; the Project settings gear |
| Mimir       | Overview, Missions, Crews, Reviews, Activity                                                                                                                                |
| Heimdall    | **Watch**: Overview, Pipeline, Crews & agents, Execution graph, Activity; **Decide**: Quality & approvals, Autonomy; the **New work** button                                |
| Skidbladnir | Worker fleet, Launch, Event history                                                                                                                                         |

## Bottom bar: everything global

The fixed bar at the bottom holds what is not about one project, left to right:

1. **Connection status**: _Live_, _Reconnecting · data may be delayed_ or _Offline · showing the last snapshot_, with a **Reconnect** button when not live. See [Reconnecting](/docs/troubleshooting#reconnecting).
2. **Session state**: _Read-only_ or _Operator unlocked_. Click it to see what you may do and to unlock. In Sindri, unlocking means entering the approval pairing code; in Heimdall, the operator code (and pairing Sindri). Mimir always shows _Operator unlocked_, because its token allows every action. Skidbladnir has no session.
3. **Global pages**: Sindri: Projects, Harnesses, Autonomy (all), Settings. Mimir: Projects, Settings. Heimdall: Notifications, Projects, Connections, Fleet, Autonomy (all). Skidbladnir: Setup guide.
4. **App extras**: Mimir's **?** help button; Skidbladnir's simulation or cloud mode badge.
5. **Help**: Docs and Ask.
6. **Account**: the theme menu (light, dark, system; shared by the apps in this browser) and Sign out (not in Skidbladnir).

On a narrow screen the bar keeps the status, the session icon and Docs, and a **More** button opens a sheet with the global pages, Ask, Shortcuts, the theme and Sign out.

## Every screen

{{nav-map}}

## Docs

Opens these pages. It keeps the app around them, so you can read next to your work. Every page header has a small **?** that explains the page and links here. Every status pill has a tooltip with its meaning and raw value; the full list is in [Statuses](/docs/statuses).

## Ask

Opens the **Guide**: a chat that explains what you are looking at and what to do next. The Overview in Sindri and in Heimdall also shows it inline as _Ask the factory_. Skidbladnir cannot ask it directly and links to Sindri's instead. It answers from these docs and a short summary of the selected project's state (counts and statuses of specs, plans, runs, deliveries, waiting decisions). It never performs actions or approvals; it tells you which screen to use. It is not the Director, which writes specs.

Good questions:

- "Why is this run waiting?"
- "What does the steward want me to decide?"
- "Why can't I export this delivery?"

## Keyboard shortcuts

Press `?` in Sindri, Mimir or Heimdall to see the shortcuts (on a narrow screen also under **More** → Shortcuts). Today:

| App      | Keys                    | Does                                                    |
| -------- | ----------------------- | ------------------------------------------------------- |
| Sindri   | `Alt+1` … `Alt+0`       | switch between the first ten tabs (outside text fields) |
| Mimir    | `g o`, `g m`, `g r`     | go to Overview, Missions, Reviews                       |
| Mimir    | `?`, `Esc`              | show help, close dialogs                                |
| Heimdall | `⌘K` / `Ctrl+K`         | jump to a page or record                                |
| Heimdall | `Alt` + arrows, `Enter` | move a node in the execution graph, open its details    |
