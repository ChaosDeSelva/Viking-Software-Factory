# Asset hygiene

Assets are code with a license and a size cost.

## Always

- Record the source and license of every third-party asset.
- Use compressed, power-of-two-friendly sizes appropriate to the target platform.
- Commit `.import` settings and keep large binaries in version control only if the project allows.
- Remove unused assets found by a reference search.

## Never

- Never commit assets with unknown or incompatible licenses.
- Never commit exported builds or editor caches.

## Verify

- Every added asset appears in the asset license list.
- No unreferenced files were added.
