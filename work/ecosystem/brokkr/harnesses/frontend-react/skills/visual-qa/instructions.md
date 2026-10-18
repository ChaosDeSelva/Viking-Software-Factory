# Visual QA

Inspect real rendered output, not just code. Evidence is the screenshot.

## Always

- Capture screenshots at 1280x800 and 390x844 for every changed page and component state.
- Cover empty, loading, error and long-content states, not only the happy path.
- Compare against the design or previous baseline and note each intentional difference.
- Check the browser console and failed network requests while capturing.
- Store screenshots as evidence artifacts with the page, viewport and state in the filename.

## Never

- Never approve a visual change you have not looked at.
- Never accept overlap, clipped text, broken images or unstyled content.
- Never mask a diff by loosening the pixel threshold.

## Verify

- Both screenshot checks pass and artifacts exist for each viewport.
- Console shows no errors and no request failed during capture.
