/**
 * Shared hardening for every short-lived `pg.Pool` this harness opens
 * (standing rule 22). Split into its own module because `measure.ts`
 * runs a real batch at import time and is therefore not importable by
 * tests.
 *
 * `connectionTimeoutMillis` bounds connection ESTABLISHMENT only. An
 * established query needs `query_timeout` or it can hang forever
 * (TRO-544 post-merge review finding). Both bounds ride together here so
 * no future pool copies one without the other.
 */
export const HARNESS_POOL_OPTIONS = {
  connectionTimeoutMillis: 10_000,
  query_timeout: 15_000,
} as const;
