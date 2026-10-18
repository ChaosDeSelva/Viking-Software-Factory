# Authentication and authorization review

Authenticate who is calling, then authorize this action on this resource, on every request.

## Always

- Enforce authentication in middleware that defaults to deny; opt public routes out explicitly.
- Check authorization per resource (ownership, tenant, role) in the service layer, not only the route.
- Hash passwords with argon2id, bcrypt or scrypt; compare secrets in constant time.
- Set session cookies `HttpOnly`, `Secure`, `SameSite`; expire and rotate tokens, and verify signature, issuer, audience and expiry.
- Rate-limit login and token endpoints and log auth failures without logging credentials.

## Never

- Never authorize from client-provided role, user ID or tenant values.
- Never put secrets or tokens in URLs, logs or error messages.
- Never leave a state-changing route without an explicit authorization check.

## Verify

- Tests show an unauthenticated call gets 401 and a wrong-user or wrong-role call gets 403 or 404 on every changed route.
- Review lists each changed route with its auth rule.
