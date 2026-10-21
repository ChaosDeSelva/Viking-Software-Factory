#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$root/dist"}
if [ "$(uname -m)" != arm64 ]; then
 printf 'Build this Apple silicon distribution on an arm64 Mac.\n' >&2
 exit 1
fi
mkdir -p "$out"
if [ -f "$root/update-public-key.txt" ] && [ -z "${VIKING_UPDATE_PUBLIC_KEY:-}" ]; then
 export VIKING_UPDATE_PUBLIC_KEY="$(cat "$root/update-public-key.txt")"
fi
cargo build --locked --release --manifest-path "$root/Cargo.toml"
app="$out/Viking Factory.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
xcrun swiftc -module-cache-path "$out/swift-cache" -O -parse-as-library -target arm64-apple-macosx13.0 "$root/macos/main.swift" -framework AppKit -framework ServiceManagement -o "$app/Contents/MacOS/VikingFactory"
cp "$root/target/release/viking" "$app/Contents/Resources/viking"
cp "$root/../LICENSE" "$root/../NOTICE" "$app/Contents/Resources/"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.viking.factory.companion</string>
<key>CFBundleName</key><string>Viking Factory</string>
<key>CFBundleExecutable</key><string>VikingFactory</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
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
