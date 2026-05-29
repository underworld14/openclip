/**
 * src/shared — the FROZEN contract imported (types-only) by BOTH main and
 * renderer. This barrel re-exports the three contract modules so consumers can
 * `import { ... } from '@shared'` or reach for a specific module.
 *
 * Authored + frozen in the trunk (plan E.2). After `contracts-outer` /
 * `contracts-v1`, changes route through the trunk owner only (E.1).
 *
 *   - channels.ts → IPCChannels enum + ChannelMap (PRD §10.1)
 *   - jobs.ts     → JobKind / JobEvent / JobsAPI + per-kind param/result/partial maps (PRD §10.2)
 *   - schema.ts   → Zod source-of-truth + inferred types + AI ClipSchema (PRD §9.3/§7.1)
 */

export const APP_NAME = 'OpenClip Desktop' as const
export const APP_VERSION = '2.0.0' as const

export * from './channels'
export * from './jobs'
export * from './schema'
