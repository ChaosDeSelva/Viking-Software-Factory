# @brokkr/sdk

Public integration SDK for Brokkr: resolve harnesses and skills for a task, prepare agent instructions, verify a workspace through an injected `CheckExecutor` with streaming `verification.*` events, and read stored evidence.

```ts
import { Brokkr } from "@brokkr/sdk";
import { MockExecutor } from "@brokkr/sdk/testing";
```

Ships the built-in harness library (`harnesses/`) and versioned JSON Schemas (`schemas/verification-report.v1.json`, `verification-event.v1.json`, `selection.v1.json`). Imports nothing from Mimir, Sindri or HerdR.

Documentation: `docs/sdk.md` in the Brokkr repository. License: Apache-2.0.
