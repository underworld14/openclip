/**
 * src/shared — types & contracts imported by BOTH main and renderer.
 *
 * STAGE 1 (scaffold) intentionally leaves this near-empty: the trunk owner
 * authors the frozen contract here per plan E.2 (`channels.ts`, `jobs.ts`,
 * `schema.ts`). This barrel exists so the `@shared/*` alias and the
 * `tsconfig.shared.json` project resolve and compile cleanly from day one.
 */

/** Placeholder app metadata; replaced by the real contract in the trunk phase. */
export const APP_NAME = 'OpenClip Desktop' as const
export const APP_VERSION = '2.0.0' as const
