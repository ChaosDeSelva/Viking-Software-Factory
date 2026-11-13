# Statuses

Every status the four apps show, in plain words. In the apps each status is a pill with a short label; hover or focus it to see the meaning and the raw value. Pills share eight colours across all apps:

| Colour role    | Means                                                        |
| -------------- | ------------------------------------------------------------ |
| Neutral        | exists, nothing happening yet                                |
| In progress    | something is working on it                                   |
| Waiting on you | a human must act                                             |
| Success        | done and good                                                |
| Warning        | degraded or at risk; may need you                            |
| Danger         | failed or refused                                            |
| Ended          | over without a result (cancelled, expired, superseded)       |
| Unknown        | the app does not know this value yet; the raw value is shown |

An unknown value is never an error: the server and the apps are updated separately, so a newer server can send a value an older app has not learned.

## Gates by kind of work

A change's tasks pass the [quality gate](/docs/glossary#quality-gate) on Brokkr's verdict and the product gates. Research and PR review tasks have no Brokkr verdict; their gates read the recorded document instead, and show the same [Passed](/docs/statuses#passed-quality-gate-status) and [Failed](/docs/statuses#failed-quality-gate-status):

| Kind      | Gates                                                                                                            | Explained in                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Research  | `research-document`, `research-sources`, `research-citations`, `research-file-sources`, `research-source-policy` | [The research checks](/docs/research#the-research-checks) |
| PR review | `pr-review-schema`, `pr-review-markdown`                                                                         | [What the run does](/docs/pr-reviews#what-the-run-does)   |

Error codes such as `pr_head_moved` or `post_blocked` are refusals, not statuses; [Troubleshooting](/docs/troubleshooting#pr-review-problems) explains them.

{{status-tables}}
