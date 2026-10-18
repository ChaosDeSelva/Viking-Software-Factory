# Query review

Read the plan, not just the SQL.

## Always

- Use parameterized queries and explicit column lists.
- Run `EXPLAIN (ANALYZE, BUFFERS)` on a realistic data size for new or changed hot queries.
- Bound result sets with `LIMIT` and keyset pagination for large tables.
- Wrap multi-statement changes in a transaction with the right isolation and lock order.
- Lint SQL with sqlfluff when available.

## Never

- Never use `SELECT *` in application queries.
- Never run `UPDATE` or `DELETE` without a `WHERE` clause reviewed.
- Never build SQL by string concatenation.

## Verify

- The plan uses the expected index and no unexpected sequential scan on large tables.
- sqlfluff passes, or its absence is recorded as skipped.
