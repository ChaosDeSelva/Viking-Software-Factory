/** Wire protocol version. Bumped only on breaking changes to envelopes, schemas or endpoints. */
export const PROTOCOL_VERSION = 1 as const;
/**
 * `@mimir/protocol` package version (semver; additive changes bump the minor). Also the OpenAPI
 * `info.version`. Kept equal to `package.json` by a test.
 */
export const PROTOCOL_PACKAGE_VERSION = "0.2.0";
