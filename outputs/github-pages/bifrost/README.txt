# Bifrost

A local MCP bridge connecting AI agents to the Hulder IDE.

Bifrost gives terminal agents access to the project open in Hulder, editor context, diagnostics, Saga notes, clippings and selected local tools. Requests travel through a local Unix socket. Bifrost does not provide a hosted service or require a cloud account.

## Project layout

| Directory | Responsibility |
| --- | --- |
| `src` | Independently buildable MCP relay, socket transport, protocol and path guards |
| `integrations/hulder` | Native editor integration and compatibility wrapper for `hulder mcp` |
| `scripts` | Reproducible source snapshot installation and verification |

The transport builds on its own. The native integration requires Hulder's editor crates and builds within the Hulder workspace. Separating the repository does not turn the native integration into an editor independent plugin.

## Build and test

Use Rust 1.98.1 on macOS or Linux.

```sh
cargo build --locked
cargo test --locked
python3 -m unittest discover -s tests
```

## Connect an agent

The existing `hulder mcp` command continues to work and selects the configured Hulder socket automatically.

For the standalone relay, start Hulder, open your project, then run Bifrost from that project directory with the absolute socket path:

```sh
bifrost --socket /absolute/path/to/hulder.sock
```

Configure an MCP client with the executable path as `command` and the socket argument in `args`. Use the actual socket in your Hulder configuration directory. The explicit path avoids guessing when Hulder uses a custom configuration directory. The agent's working directory must belong to an open Hulder project.

```json
{
  "mcpServers": {
    "hulder": {
      "command": "/absolute/path/to/bifrost",
      "args": ["--socket", "/absolute/path/to/hulder.sock"]
    }
  }
}
```

The relay serves MCP over stdin and stdout. Logs and startup errors go to stderr. Windows transport support is not implemented.

## Hulder integration

This repository owns the bridge implementation and the native adapter. Hulder embeds a source snapshot so a normal Hulder clone builds without a sibling checkout, submodule setup or runtime downloads.

After editing Bifrost, update and verify a local Hulder checkout:

```sh
python3 scripts/sync-hulder.py /path/to/Hulder --write
python3 scripts/sync-hulder.py /path/to/Hulder
cd /path/to/Hulder
cargo check -p bifrost -p cli
cargo test -p bifrost
```

The sync command manages `crates/bifrost-core`, `crates/bifrost`, the CLI MCP wrapper and the required Cargo dependency entries. `bifrost-source.json` records hashes of the embedded files. Review the Hulder diff before committing it. Edit the canonical files here rather than modifying the embedded snapshot directly.

## Security and scope

Socket access is restricted to the local owner. Request size and call duration are bounded. Project paths are checked for traversal and escaping symlinks. This is an agent control interface for a trusted local session, not a security boundary against other processes running as your user. Tools can change project content when called; inspect the tool catalog before granting an agent access.

## License and attribution

Bifrost retains its existing GPL version 3 or later license. See [LICENSE](LICENSE) and [NOTICE](NOTICE). It was extracted from Hulder, which is derived from Zed. Existing upstream attribution and license obligations remain intact. Rust dependencies retain their respective licenses.

## Experimental release status

The planned public source tag is `v0.1.0`. See [release scope and setup](RELEASE-v0.1.0.md) for tested behavior and acceptance limits. Manual accessibility testing is pending. Vendor integrations without authenticated live acceptance remain experimental.
