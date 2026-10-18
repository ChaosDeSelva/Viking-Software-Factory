# API contracts

The contract is the product surface. Change it deliberately and compatibly.

## Always

- Describe every endpoint with a request and response schema (OpenAPI or schema-derived) and keep it in sync with code.
- Use nouns for resources, correct verbs, and precise status codes (201 create, 204 empty, 400/422 invalid, 404, 409 conflict).
- Make unsafe retries safe: idempotency keys for POST that create, idempotent PUT/DELETE.
- Paginate list endpoints with a stable cursor and a bounded page size.
- Add fields as optional; version the path or header for breaking changes.

## Never

- Never remove, rename or retype a field or change a status code in place.
- Never return different shapes for the same status code.
- Never expose internal IDs, stack traces or database errors in responses.

## Verify

- Contract or schema tests pass and a diff of the generated spec shows only intended changes.
- Each new endpoint has a test for success, validation failure and authorization failure.
