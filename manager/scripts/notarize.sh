#!/bin/bash
set -euo pipefail
app=${1:?Provide the signed app path}
profile=${2:?Provide the existing notarytool Keychain profile name}
# Verification must confirm a Developer ID identity before submission.
codesign -dv --verbose=2 "$app" 2>&1 | grep 'Authority=Developer ID Application:' >/dev/null
archive="${app%.app}-notarization.zip"
ditto -c -k --keepParent "$app" "$archive"
xcrun notarytool submit "$archive" --keychain-profile "$profile" --wait
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose "$app"
