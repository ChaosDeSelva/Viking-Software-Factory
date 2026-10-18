# Dangerous code patterns

Some APIs turn data into code. Use them only with a proven safe alternative absent.

## Always

- Run the bundled scanner (`scan.mjs --kind code`) and review each hit in context.
- Run commands with `execFile`/`spawn` and an argument array, never a shell string.
- Render text with the framework's escaping; sanitize HTML with a vetted library when markup is required.
- Use SHA-256 or stronger and a CSPRNG (`crypto.randomBytes`) for security purposes.
- Parse data formats with safe parsers; never deserialize untrusted data into objects with behavior.

## Never

- Never call `eval`, `new Function` or `vm` on untrusted input.
- Never set `innerHTML` or `dangerouslySetInnerHTML` from unsanitized data.
- Never use MD5 or SHA-1 for passwords or signatures; never `Math.random` for tokens.

## Verify

- Each code hit is removed or justified in a comment and task note.
- Tests cover the safe path with hostile input.
