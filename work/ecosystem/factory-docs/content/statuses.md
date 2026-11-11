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

{{status-tables}}
