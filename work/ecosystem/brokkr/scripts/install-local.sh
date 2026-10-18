#!/bin/sh
# Install a local Brokkr release archive and put a `brokkr` shim on PATH.
#
#   scripts/install-local.sh [--no-verify] [path/to/brokkr-<version>-<os>-<arch>.tar.gz]
#
# Defaults: the newest archive in ./dist. Installs into
#   ${BROKKR_PREFIX:-$HOME/.local/share/brokkr}/<release>
# and writes the shim
#   ${BROKKR_BIN_DIR:-$HOME/.local/bin}/brokkr
# The checksum in <archive>.sha256 is verified first; a missing checksum file
# is an error unless --no-verify is given. Nothing is downloaded; nothing
# outside those two directories is touched.
set -eu

VERIFY=1
if [ "${1:-}" = "--no-verify" ]; then VERIFY=0; shift; fi
ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ]; then
  HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  for dir in "$HERE/../dist" "$HERE" "./dist"; do
    found=$(ls -t "$dir"/brokkr-*.tar.gz 2>/dev/null | head -n 1 || true)
    if [ -n "$found" ]; then ARCHIVE="$found"; break; fi
  done
fi
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "install-local: no release archive found; run 'pnpm release:local' or pass its path" >&2
  exit 2
fi

if [ "$VERIFY" = 1 ]; then
  if [ ! -f "$ARCHIVE.sha256" ]; then
    echo "install-local: $ARCHIVE.sha256 not found; refusing to install unverified (use --no-verify to override)" >&2
    exit 1
  fi
  expected=$(cut -d ' ' -f 1 < "$ARCHIVE.sha256")
  actual=$(shasum -a 256 "$ARCHIVE" | cut -d ' ' -f 1)
  if [ "$expected" != "$actual" ]; then
    echo "install-local: checksum mismatch for $ARCHIVE" >&2
    exit 1
  fi
  echo "checksum ok: $actual"
else
  echo "install-local: --no-verify: installing without checksum verification" >&2
fi

PREFIX="${BROKKR_PREFIX:-$HOME/.local/share/brokkr}"
BIN_DIR="${BROKKR_BIN_DIR:-$HOME/.local/bin}"
NAME=$(basename "$ARCHIVE" .tar.gz)
case "$NAME" in
  brokkr-*) ;;
  *) echo "install-local: unexpected archive name $NAME" >&2; exit 2 ;;
esac

mkdir -p "$PREFIX" "$BIN_DIR"
rm -rf "${PREFIX:?}/$NAME"
tar -xzf "$ARCHIVE" -C "$PREFIX"
if [ ! -x "$PREFIX/$NAME/bin/brokkr" ]; then
  echo "install-local: $ARCHIVE does not contain $NAME/bin/brokkr" >&2
  exit 2
fi

SHIM="$BIN_DIR/brokkr"
cat > "$SHIM" <<SHIM
#!/bin/sh
exec "$PREFIX/$NAME/bin/brokkr" "\$@"
SHIM
chmod 755 "$SHIM"
echo "installed $NAME into $PREFIX/$NAME"
echo "shim: $SHIM"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: add $BIN_DIR to PATH" ;;
esac
