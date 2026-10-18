# Veil: temporary privacy screen

- Both status and locked-overlay icons now use eye/eye-off; the overlay no longer draws the old hood on top of the status button.
- Every lock asks for a new password and confirmation. Unlocking discards the password.
- The unlock card has readable labels and a password visibility button. Its isolated text cache does not change the runic editor text.
- Password records stay in memory during normal use. Quitting/reopening Hulder resets the veil; Cmd-Q remains available. Legacy veil.json files are left untouched and ignored by normal startup.
- This is a playful privacy screen, not an operating-system security boundary. Use the macOS lock screen when leaving the laptop. Hulder never asks for the Mac account password.

Validation: 37 native Veil tests passed, including two complete per-lock password cycles, wrong-password rejection, session reset, readable-control isolation, input interception and existing compatibility tests. File-backed legacy-store tests still intentionally cover persistence; normal startup uses the session store.

The changes are in the source checkout and refreshed Hulder Dev development bundle. Apple Developer ID signing/notarization remains a separate release step.
