# Migration safety

A migration runs once against production data. Make it safe, small and reviewable.

## Always

- Keep one logical change per migration with a forward step and a documented rollback.
- Use expand-and-contract: add nullable column, backfill in batches, then add constraints.
- Create indexes with `CREATE INDEX CONCURRENTLY` and add constraints `NOT VALID` then `VALIDATE`.
- Set `lock_timeout` and `statement_timeout` in migrations that take locks.
- Run the migration dry-run on a copy of the schema before review.

## Never

- Never edit a migration that has already been applied.
- Never rewrite a large table or take `ACCESS EXCLUSIVE` locks during traffic.
- Never drop a column still read by deployed code.

## Verify

- The dry-run applies cleanly to an empty and to a populated database.
- A rollback or forward-fix path is documented for the change.
