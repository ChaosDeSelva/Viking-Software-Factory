# Manual accessibility acceptance

Status: awaiting operator observations. Automated browser checks do not establish spoken output or manual screen reader acceptance.

## Counter demo

Open the local counter in Safari at http://127.0.0.1:4385/ and enable VoiceOver. Navigate using Control Option Right Arrow and activate controls using Control Option Space.

1. Confirm the Counter heading and current count can be discovered.
2. Confirm Increment, Decrement and Reset are announced as buttons with distinct names.
3. Activate Increment twice, Decrement once, then Reset. Confirm counts 1, 2, 1 and 0 are announced without navigating away and back.
4. Confirm navigation can leave the controls without a trap.
5. Record the browser, macOS version, actual announcements and any failures. Restore your usual VoiceOver setting afterward.

A successful counter check establishes acceptance of that page only.

## Heimdall

Use a disposable project. Do not activate cancellation, deletion or remote operations on real work during this check.

1. Navigate the sidebar, project selector and page headings. Confirm names, selected state and reading order.
2. Open and close a task detail dialog. Confirm its title is announced, focus enters it, Escape closes it and focus returns to the trigger.
3. Navigate a horizontally overflowing pipeline table. Confirm headers identify cells and hidden columns can be reached.
4. Open Settings and its Access, display and audit sections. Confirm form labels, disabled states and pagination are understandable.
5. Trigger a harmless validation error in a disposable form. Confirm the error is announced and associated with its field.
6. Observe a disposable task status update. Confirm the change is discoverable without excessive repeated announcements.
7. Repeat navigation in a narrow viewport. Confirm the mobile menu can be opened, navigated and closed without losing focus.

Record pass, fail or untested for each step. Include actual speech for failures. Do not mark this complete based only on Axe results or an accessibility tree.
