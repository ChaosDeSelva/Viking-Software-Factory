# Accessibility

Target WCAG 2.2 AA. Native semantics first, ARIA only to fill gaps.

## Always

- Use native elements (`button`, `a`, `input`, `label`, `dialog`) before custom roles.
- Give every control an accessible name and associate each form input with a visible `label`.
- Make every interaction keyboard operable with a visible focus indicator and logical tab order.
- Manage focus on route changes, dialogs (trap and restore) and inserted errors.
- Provide text alternatives for images; mark decorative ones `alt=""`.
- Make pointer targets at least 24x24 CSS pixels (WCAG 2.2 target size) and keep focused elements from being hidden by sticky headers or overlays.
- Meet contrast of 4.5:1 for body text and 3:1 for large text and UI boundaries.
- Announce async status with `role="status"` or `aria-live` regions.

## Never

- Never put click handlers on non-interactive elements such as `div` or `span`.
- Never convey information by color alone.
- Never remove the focus outline without an equal replacement.
- Never use positive `tabindex` values or `aria-hidden` on focusable elements.

## Verify

- The axe check reports zero serious or critical violations on touched pages.
- Tab through the changed UI: every control is reachable, named and operable by keyboard.
