#!/usr/bin/env bash
# Installs a Mimir release tarball under ~/.mimir/app and puts a `mimir` shim in ~/.local/bin.
# Usage: scripts/install-local.sh [path/to/mimir-<version>-macos-arm64.tar.gz]
# With no argument it installs the tree this script was shipped in.
# Overrides: MIMIR_APP_DIR (default ~/.mimir/app), MIMIR_BIN_DIR (default ~/.local/bin).
set -euo pipefail

app_dir="${MIMIR_APP_DIR:-$HOME/.mimir/app}"
bin_dir="${MIMIR_BIN_DIR:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  echo "install-local: node not found on PATH (Node 25 or newer is required)" >&2
  exit 3
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 25 ]; then
  echo "install-local: Node 25 or newer is required (found $(node -v))" >&2
  exit 3
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

if [ "$#" -ge 1 ]; then
  [ -f "$1" ] || { echo "install-local: no such tarball: $1" >&2; exit 2; }
  tar -xzf "$1" -C "$staging" --strip-components=1
  src="$staging"
elif [ -f "$here/VERSION" ]; then
  src="$here"
else
  echo "install-local: pass the release tarball path" >&2
  exit 2
fi
[ -x "$src/bin/mimir" ] || { echo "install-local: not a Mimir release (bin/mimir missing)" >&2; exit 2; }

# Replace the previous install; the data dir (~/.mimir, except app/) is never touched.
mkdir -p "$(dirname "$app_dir")" "$bin_dir"
rm -rf "$app_dir"
mkdir -p "$app_dir"
cp -R "$src"/. "$app_dir"/

for command in mimir mimir-remote-entrypoint mimir-exe-worker; do
  [ -x "$app_dir/bin/$command" ] || continue
  shim="$bin_dir/$command"
  printf '#!/bin/sh\nexec "%s/bin/%s" "$@"\n' "$app_dir" "$command" > "$shim"
  chmod 755 "$shim"
done

echo "installed Mimir $(cat "$app_dir/VERSION") to $app_dir"
echo "commands: mimir, mimir-remote-entrypoint, mimir-exe-worker in $bin_dir"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: $bin_dir is not on your PATH; add it to your shell profile" ;;
esac
