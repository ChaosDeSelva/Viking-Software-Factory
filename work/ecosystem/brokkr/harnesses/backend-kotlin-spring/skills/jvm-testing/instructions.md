# JVM testing

Use the narrowest test slice that proves the behavior.

## Always

- Unit-test logic with plain JUnit 5 and a mocking library such as MockK for collaborators.
- Use slices (`@WebMvcTest`, `@DataJpaTest`) before full `@SpringBootTest`.
- Run repository and integration tests against real services with Testcontainers.
- Assert behavior and status codes through MockMvc or WebTestClient.

## Never

- Never share mutable state across tests or rely on test order.
- Never use `Thread.sleep` for synchronization; use awaiting utilities.
- Never leave `@Disabled` tests without an issue reference.

## Verify

- `./gradlew test` passes with all new tests included.
- Each new test fails when the behavior it covers is reverted.
