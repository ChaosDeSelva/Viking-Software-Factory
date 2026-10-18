# Spring security

Deny by default; open each route deliberately.

## Always

- Configure a `SecurityFilterChain` that requires authentication by default.
- Use method security (`@PreAuthorize`) for resource-level authorization.
- Keep CSRF on for cookie sessions and restrict CORS to named origins.
- Hash passwords with `DelegatingPasswordEncoder` and load secrets from the environment.

## Never

- Never permit `anyRequest()` without authentication.
- Never disable CSRF or security headers without a documented reason.
- Never log tokens or credentials.

## Verify

- Tests assert 401 and 403 for each protected endpoint.
- Actuator endpoints expose only what is intended.
