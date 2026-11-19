#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$root/dist"}
if [ "$(uname -m)" != arm64 ]; then
 printf 'Build this Apple silicon distribution on an arm64 Mac.\n' >&2
 exit 1
fi
if [ -n "${VIKING_DEBUG:-}" ] && [ -n "${VIKING_SIGN_IDENTITY:-}" ]; then
 printf 'VIKING_DEBUG builds enable the Web Inspector and must not be signed for distribution. Unset VIKING_DEBUG or VIKING_SIGN_IDENTITY.\n' >&2
 exit 1
fi
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
swift=(xcrun swiftc -module-cache-path "$out/swift-cache" -parse-as-library -target arm64-apple-macosx13.5)
# VIKING_DEBUG=1 builds without optimisation and lets Safari's Web Inspector attach to the factory window.
if [ -n "${VIKING_DEBUG:-}" ]; then swift+=(-Onone -g -D DEBUG); else swift+=(-O); fi
# Compiler output, tests and debug symbols stay outside the app bundle.
build="$out/swift-build"
mkdir -p "$build"
"${swift[@]}" "$root/macos/FactoryLinks.swift" "$root/macos/tests/FactoryLinksTests.swift" -o "$build/factory-links-tests"
"$build/factory-links-tests"
if [ -f "$root/update-public-key.txt" ] && [ -z "${VIKING_UPDATE_PUBLIC_KEY:-}" ]; then
 export VIKING_UPDATE_PUBLIC_KEY="$(cat "$root/update-public-key.txt")"
fi
# A dependency's panic location can otherwise include the build account's Cargo registry path.
# Wrap rustc so target-specific flags, encoded arguments and compiler caches keep their settings.
cat > "$build/remap-rustc" <<'SH'
#!/bin/bash
set -eu
compiler=$1
shift
maps=()
for directory in "$HOME" "${CARGO_HOME:-$HOME/.cargo}" "${RUSTUP_HOME:-$HOME/.rustup}" "$VIKING_MANAGER_ROOT" "$VIKING_MANAGER_TARGET"; do
  maps+=("--remap-path-prefix=$directory=/build")
  if [[ -d "$directory" ]]; then
    maps+=("--remap-path-prefix=$(cd "$directory" && pwd -P)=/build")
  fi
done
if [[ -n "${VIKING_UPSTREAM_WRAPPER:-}" ]]; then
  exec "$VIKING_UPSTREAM_WRAPPER" "$compiler" "$@" "${maps[@]}"
fi
exec "$compiler" "$@" "${maps[@]}"
SH
chmod +x "$build/remap-rustc"
VIKING_UPSTREAM_WRAPPER="${RUSTC_WRAPPER:-}" VIKING_MANAGER_ROOT="$root" VIKING_MANAGER_TARGET="$build/rust" \
  RUSTC_WRAPPER="$build/remap-rustc" cargo build --locked --release --manifest-path "$root/Cargo.toml" --target-dir "$build/rust"
app="$out/Viking Factory.app"
# The companion carries the manager it embeds, so it reports that manager's version.
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$root/Cargo.toml" | head -n 1)
: "${version:?Cargo.toml has no package version}"
# CFBundleVersion takes only dot-separated integers, so drop any pre-release or build suffix.
build_number=${version%%[-+]*}
# Start from an empty bundle so nothing from an earlier build (such as a dSYM) is signed into it.
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
"${swift[@]}" "$root/macos/main.swift" "$root/macos/FactoryLinks.swift" "$root/macos/FactoryWindow.swift" -framework AppKit -framework ServiceManagement -framework WebKit -o "$build/VikingFactory"
cp "$build/VikingFactory" "$app/Contents/MacOS/VikingFactory"
# Native dependencies also carry linker debug-map paths, which rustc cannot rewrite.
xcrun strip -S -o "$app/Contents/Resources/viking" "$build/rust/release/viking"
python3 - "$app/Contents/Resources/viking" "$HOME" "${CARGO_HOME:-$HOME/.cargo}" "${RUSTUP_HOME:-$HOME/.rustup}" "$root" "$build" <<'PY'
import os
from pathlib import Path
import sys

binary = Path(sys.argv[1]).read_bytes()
paths = {os.fsencode(candidate) for path in sys.argv[2:] for candidate in (path, os.path.realpath(path))}
if any(path and path != b'/' and path in binary for path in paths):
    sys.exit("The embedded manager contains a host build path.")
PY
cp "$root/../LICENSE" "$root/../NOTICE" "$app/Contents/Resources/"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.viking.factory.companion</string>
<key>CFBundleName</key><string>Viking Factory</string>
<key>CFBundleExecutable</key><string>VikingFactory</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$build_number</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSDownloadsFolderUsageDescription</key><string>Files you download from the factory window are saved to Downloads.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
if [ -n "${VIKING_BUNDLE_DIR:-}" ]; then
 mkdir -p "$app/Contents/Resources/bundle"
 cp "$VIKING_BUNDLE_DIR"/*.zip "$VIKING_BUNDLE_DIR/factory-manifest.json" "$app/Contents/Resources/bundle/"
fi
if [ -n "${VIKING_SIGN_IDENTITY:-}" ]; then
 codesign --force --options runtime --timestamp --sign "$VIKING_SIGN_IDENTITY" "$app/Contents/Resources/viking"
 codesign --force --options runtime --timestamp --sign "$VIKING_SIGN_IDENTITY" "$app"
else
 codesign --force --sign - "$app/Contents/Resources/viking"
 codesign --force --sign - "$app"
 printf 'Local ad hoc build only. Not signed for public distribution.\n'
fi
codesign --verify --strict "$app"
printf '%s\n' "$app"
