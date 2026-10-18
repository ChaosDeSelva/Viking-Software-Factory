# Structured logging

Logs are machine-read events. One JSON object per line, stable fields.

## Always

- Use one logger (such as Pino) to stdout or stderr with level, time, message and context fields.
- Attach a request or correlation ID to every line via child loggers.
- Redact secrets, tokens, passwords, authorization headers and personal data by configured paths.
- Log errors as objects (`err`) so the stack and cause survive.
- Choose levels deliberately: error for failures needing action, info for lifecycle, debug for detail.

## Never

- Never use `console.log` in service code or log request bodies wholesale.
- Never interpolate data into the message; put it in fields.
- Never log inside tight loops at info level.

## Verify

- A test captures log output and asserts required fields and that a sample secret is redacted.
- A grep of the diff finds no `console.*` calls in production code.
