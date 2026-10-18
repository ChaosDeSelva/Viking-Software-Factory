# Runnable examples

An example is a test the reader runs. Run it first.

## Always

- Execute every new or changed example in a clean environment and paste the real output.
- Include imports, setup and the exact command so the example works verbatim.
- Keep examples minimal and focused on one concept; mark placeholders obviously.
- Extract examples into tested files or doc tests so CI can run them.
- Pin versions where behavior differs between releases.

## Never

- Never ship an example you have not run.
- Never include real credentials, hostnames or personal data.
- Never show pseudo-code unlabeled inside a code block that looks runnable.

## Verify

- The examples check or a manual run exits 0 and its output matches the docs.
- Placeholder values are the only text a reader must change.
