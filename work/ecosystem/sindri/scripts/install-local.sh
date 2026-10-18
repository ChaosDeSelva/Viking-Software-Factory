#!/bin/sh
# Installs a Sindri release tarball for the current user (no root, no network):
#   sh scripts/install-local.sh dist/sindri-<version>-<os>-<arch>.tar.gz
# Unpacks to ${SINDRI_INSTALL_ROOT:-~/.local/share/sindri}/<name> and writes the `sindri` shim to
# ${SINDRI_BIN_DIR:-~/.local/bin}. Re-running with the same version replaces it in place.
set -eu

tarball=${1:-}
if [ -z "$tarball" ] || [ ! -f "$tarball" ]; then
  echo "usage: install-local.sh <sindri-<version>-<os>-<arch>.tar.gz>" >&2
  exit 2
fi
name=$(basename "$tarball" .tar.gz)
case "$name" in
  sindri-*) ;;
  *) echo "install-local.sh: $tarball is not a Sindri release tarball" >&2; exit 2 ;;
esac
if ! command -v node >/dev/null 2>&1; then
  echo "install-local.sh: node not found on PATH; Sindri needs Node 25 or newer" >&2
  exit 3
fi

root=${SINDRI_INSTALL_ROOT:-$HOME/.local/share/sindri}
bin=${SINDRI_BIN_DIR:-$HOME/.local/bin}
mkdir -p "$root" "$bin"
tmp=$(mktemp -d "$root/.install-XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$tarball" -C "$tmp"
if [ ! -x "$tmp/$name/bin/sindri" ]; then
  echo "install-local.sh: unexpected tarball layout (no $name/bin/sindri)" >&2
  exit 2
fi
rm -rf "${root:?}/$name"
mv "$tmp/$name" "$root/$name"

shim="$bin/sindri"
cat > "$shim" <<SHIM
#!/bin/sh
exec "$root/$name/bin/sindri" "\$@"
SHIM
chmod 755 "$shim"

echo "installed $name to $root/$name"
echo "shim: $shim"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "note: $bin is not on PATH; add it to use \`sindri\`" ;;
esac
echo "next: sindri init && sindri doctor"
