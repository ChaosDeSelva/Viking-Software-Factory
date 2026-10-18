# Insecure configuration

Configuration weakens security more often than code does.

## Always

- Run the bundled scanner (`scan.mjs --kind config`) and review each result.
- Keep TLS certificate verification on and restrict CORS to named origins.
- Set secure cookie and security header defaults (HSTS, CSP, `X-Content-Type-Options`).
- Run containers as a non-root user and bind services to the narrowest interface.
- Keep debug modes and verbose error output off outside development.

## Never

- Never set `NODE_TLS_REJECT_UNAUTHORIZED=0` or `rejectUnauthorized: false`.
- Never open `0.0.0.0/0` ingress or wildcard CORS with credentials.
- Never commit real environment files.

## Verify

- The config scan reports no `finding`; each `heuristic` has a reviewed reason.
- Production configuration sets the secure value explicitly.
