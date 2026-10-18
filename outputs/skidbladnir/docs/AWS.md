# AWS worker setup

AWS mode creates real billable resources. Simulation remains the default. Credentials stay in the AWS profile on the machine running the API; the browser receives no access keys.

## Configuration

Install the official AWS CLI and authenticate an operator profile. Create a dedicated fleet identity, deploy `infra/aws/cleanup.template.json` with that identity, and wait for stack creation to complete. The template creates the SSM instance profile, an expiration Lambda, its minute schedule, logs, and an error alarm. The alarm has no notification destination until you configure one.

Use `infra/aws/acceptance.template.json` for a disposable test environment. It adds its own VPC, private subnet, security groups, and two SSM interface endpoints. It accepts no existing network identifiers and creates no peering, internet gateway, or NAT gateway. Interface endpoints incur charges until the stack is deleted.

Copy `aws.example.json` to a private location and replace the example identifiers with your approved values. Choose an AMI containing SSM Agent and the language runtimes you require; template names do not install software. Private workers need working SSM endpoints or approved outbound connectivity.

```sh
SKIDBLADNIR_AWS_CONFIG=/absolute/path/to/private/aws.json npm start
```

The server uses a separate database for each AWS fleet. It refuses an account mismatch, incompatible image architecture, an unavailable expiration function, a disabled or disconnected expiration schedule, and mutation of instances whose ownership cannot be confirmed. Launches use persistent request identities and EC2 client tokens; uncertain requests are reconciled instead of automatically repeated.

The configured worker limit is enforced by this controller and checked against fleet inventory. It is not an AWS billing cap or a distributed reservation across multiple controllers. Run one controller for a fleet.

## Execution and factory tools

The dashboard supports SSM shell commands, result refresh, and cancellation. Commands run with the privileges of the instance SSM agent. SSM command output is bounded by AWS output limits. The native terminal launcher supports interactive Session Manager sessions and reconnect using a recorded terminal identity. Approved images must be Linux images with `/bin/sh`. The launcher uses Amazon's `AWS-StartInteractiveCommand` document and does not create or change account session preferences. Install the official AWS Session Manager plugin, then run `node scripts/terminal.mjs WORKER_ID` from this project. To reconnect, append the terminal identity printed by the launcher. This closes any remaining connection and opens a fresh shell on the same worker. Shell variables and foreground processes are not restored. Factory missions and recorded SSM commands run separately. The AWS plugin also handles temporary network interruption within a running client. The dashboard records identities and offers a close action; connection tokens are never stored in history.

The dashboard and `skidbladnir_collect_artifact` MCP tool collect individual files up to 12 KiB from `/tmp/skidbladnir-workspace`. Python 3 is required on the worker. Paths must remain inside that directory. Files are verified with SHA256 and retained in the local database for download after worker termination. This is a bounded evidence transfer, not a general directory synchronization service.

The REST API exposes worker lifecycle and command evidence. The stdio MCP server connects to the same local API and can be configured in Hulder, Codex, Claude Code, or another MCP client:

```json
{
  "mcpServers": {
    "skidbladnir": {
      "command": "node",
      "args": ["/absolute/path/to/skidbladnir/packages/integration/mcp.mjs"],
      "env": {"SKIDBLADNIR_URL": "http://127.0.0.1:4380"}
    }
  }
}
```

Inspection is the default. Add `SKIDBLADNIR_ALLOW_CONTROLS` with value `1` only for a trusted client allowed to provision workers, execute commands, and terminate them. Launch and command tools require stable request keys. Retry an uncertain request using the same key and arguments. Do not generate a new key merely because a response was lost.

Mimir fleet configuration accepts `runtime: "skidbladnir"`, a local API `url`, approved `template`, worker lifetime `minutes`, and remote `root`. It allocates one owned worker per job, waits for SSM readiness, invokes `mimir-remote-entrypoint`, stores final job evidence locally, returns the patch through the existing factory runtime contract, and requests worker termination. The approved AMI must already contain Node, Git, the Mimir entrypoint, and the selected authenticated harness. Credentials are not copied from the operator machine.

Inline mission requests are limited to 4500 bytes, and returned evidence must fit SSM output limits. Use the SSH runtime for larger workspaces. Local acceptance exercises the real worker entrypoint with a synthetic harness; authenticated agent placement on a custom AWS AMI is not claimed. Bifröst remains the editor context bridge.

## Expiration and teardown

The cloud schedule terminates expired instances bearing this fleet's exact ownership tag. Root volumes are encrypted and deleted on termination. The cleanup function does not delete the infrastructure stack or interface endpoints.

For test teardown, first terminate and verify every instance belonging to the unique test fleet. Then delete its exact stack ID, wait for `DELETE_COMPLETE`, and verify that its tagged volumes and VPC are absent. Keep the expiration infrastructure until all workers are terminated. Never delete resources by a shared name prefix or account wide inventory.

## Acceptance evidence

On October 15, 2026, the isolated live test launched an EC2 worker, executed a synthetic command through SSM, and observed independent expiration after the controller stopped making requests. The test stack reached deletion completion, and no tagged volumes or VPC remained. Local contract tests also cover ownership refusal, account mismatch, expiration readiness, architecture, launch identity, and uncertain outcomes.

The extended live acceptance also verified file transfer with SHA256, interactive terminal input and output, and reconnection into a fresh shell after the local client was forcibly killed. The session was explicitly terminated. Shell state restoration after client death is not claimed.
