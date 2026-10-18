# SQL testing

Test SQL against a real PostgreSQL, never a mock.

## Always

- Run tests against a disposable PostgreSQL of the production major version.
- Create the schema by running the real migrations from empty.
- Isolate each test with a transaction rollback or a fresh schema.
- Seed minimal fixtures inside the test and assert on rows, constraints and error codes.

## Never

- Never point tests at a shared or production database.
- Never replace the database with an in-memory substitute of a different dialect.
- Never depend on row order without `ORDER BY`.

## Verify

- Migrations apply from scratch and the test suite passes against them.
- Tests fail when a constraint or index from the change is removed.
