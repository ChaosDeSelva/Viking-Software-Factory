# Sindri architecture decision records

| ADR                                                  | Decision                                                 |
| ---------------------------------------------------- | -------------------------------------------------------- |
| [ADR-001](ADR-001-separate-repository.md)            | Sindri is a separate repository from Mimir and Brokkr    |
| [ADR-002](ADR-002-sdk-only-mimir-dependency.md)      | Sindri reaches Mimir only through `@mimir/sdk`           |
| [ADR-003](ADR-003-provider-neutral-director.md)      | The director is provider neutral and advisory            |
| [ADR-004](ADR-004-harnesses-owned-by-brokkr.md)      | Harnesses are owned by Brokkr and consumed through SDK   |
| [ADR-005](ADR-005-evidence-only-completion.md)       | Work is complete on evidence, never on agent self report |
| [ADR-006](ADR-006-knowledge-evidence-split.md)       | Knowledge and evidence are separate stores               |
| [ADR-007](ADR-007-local-only-mode.md)                | Local only mode blocks all network egress by Sindri      |
| [ADR-008](ADR-008-no-auto-merge.md)                  | Sindri never merges or deploys on its own                |
| [ADR-009](ADR-009-mpl-test-only-dependencies.md)     | MPL-2.0 dependencies are accepted for test/build only    |

Format: Status, Context, Decision, Consequences. An ADR is changed only by a new ADR that supersedes it.
Mimir's repository records the cross boundary decisions from its side in `mimir/docs/adrs/`.
