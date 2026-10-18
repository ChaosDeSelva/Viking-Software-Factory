# Spring architecture

Keep controllers thin, services transactional and configuration externalized.

## Always

- Use constructor injection with `val` parameters; keep beans stateless.
- Keep controllers for HTTP mapping, services for logic and repositories for data access.
- Bind configuration with `@ConfigurationProperties` and validate it with `@Validated`.
- Put `@Transactional` on service methods with the narrowest scope; mark reads `readOnly`.
- Use DTOs at the API boundary and map to domain types explicitly.

## Never

- Never expose JPA entities from controllers.
- Never use field injection or `lateinit` for dependencies.
- Never catch `Exception` broadly to hide failures; use `@ControllerAdvice` mappings.

## Verify

- `./gradlew test` passes.
- Application context starts in a test with the production configuration shape.
