# Responsive design

Design mobile-first and verify at the two reference viewports: 1280x800 and 390x844.

## Always

- Start with the single-column mobile layout and add breakpoints only where content needs it.
- Use flexible units, `min-width`/`max-width`, grid and wrapping instead of fixed widths.
- Keep touch targets at least 44x44 CSS pixels with spacing between them.
- Allow text to reflow and zoom to 200% without horizontal scrolling or clipped content.
- Set the viewport meta tag and use `dvh` or `min-height` for full-height regions.
- Make tables and wide content scroll inside their own container.

## Never

- Never disable user zoom or rely on device-specific breakpoints.
- Never hide essential functionality on small screens.
- Never use hover as the only way to reveal an action.
- Never let the page itself scroll horizontally.

## Verify

- Screenshots at 1280x800 and 390x844 show no overflow, overlap or clipped text.
- `document.documentElement.scrollWidth` does not exceed the viewport width at 390px.
