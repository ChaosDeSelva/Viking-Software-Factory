# Schema design

Let the database enforce invariants; the application is not the last line of defense.

## Always

- Declare primary keys, foreign keys, `NOT NULL`, `UNIQUE` and `CHECK` constraints for every invariant.
- Use precise types: `timestamptz`, `numeric` for money, `uuid`, `text` with checks, enums or lookup tables.
- Index foreign keys and the columns used in frequent filters and sorts.
- Name objects consistently in `snake_case` and keep tables in an explicit schema.

## Never

- Never store money in floats or timestamps without time zone.
- Never use nullable columns to encode state that needs a constraint.
- Never add indexes without a query that needs them.

## Verify

- Constraints reject a test row that violates each invariant.
- `EXPLAIN` shows the intended index for the main queries on the new tables.
