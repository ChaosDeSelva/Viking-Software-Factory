# Protocol and SDK compatibility

`@mimir/protocol` and `@mimir/sdk` are versioned on their own (semver), separately from the Mimir
app. Two numbers matter:

| Number | Where | Changes when |
|---|---|---|
| Wire protocol version | `PROTOCOL_VERSION` (`1`), `GET /v1/capabilities` `protocolVersion`, event `schemaVersion` | A breaking change to envelopes, schemas or endpoints. |
| Package version | `@mimir/protocol` and `@mimir/sdk` `package.json`, `PROTOCOL_PACKAGE_VERSION`, OpenAPI `info.version` | Any published change; additive changes bump the minor. |

## 0.2.0 (wire protocol 1)

Additive only. A 0.1.0 client keeps working against a 0.2.0 server, and a 0.2.0 client against a
0.1.0 server except for the new method.

* New operation `POST /v1/tasks/{id}/pr` (it existed on the server since T12 but was not in the
  contract). Request body: empty object, may be omitted. Reply 202:
  `{operationId, commandId, status: "approval_required", approvalId}` or
  `{operationId, commandId, status: "delivered", prUrl?}`. Errors: 404 unknown task,
  409 `invalid_transition` when the task is not `completed`, 409 `conflict` when it has no
  worktree, 403 `policy_denied`. With the default policy the reply is `approval_required`;
  approving runs the delivery and consumes the approval, so a later request asks again.
  `delivered` is the reply when a (project scoped) policy rule allows `pr.create`. Mimir never
  pushes or merges.
* SDK: `tasks.requestPr(taskId, { idempotencyKey })`.
* The SDK tarball ships `contracts/`: `index.json`, `errors.json` and one fixture per OpenAPI
  operation (`<method>-<path>.json`) with a recorded request and response and the JSON Schemas of
  both, generated from the protocol schemas. Ids and timestamps are stable placeholders. Use them
  to run contract tests offline (validate your fakes' replies against `schemas.response`, and
  decode `response.body` with your client).
* OpenAPI `info.version` now carries the package version (`0.2.0`) instead of `1.0.0`.
* `jsonSchemaOf(schema, io)` exported from `@mimir/protocol`.

Consumers on 0.1.0 (Sindri's vendored tarballs) should re vendor to get `tasks.requestPr` and the
fixtures; nothing they use changed shape.
