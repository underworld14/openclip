/**
 * src/main/services/ffmpeg.ts — the FFmpeg BARREL (plan E.4 decoupling pattern).
 *
 * This is a pure re-export aggregator so consumers can `import { … } from
 * '@main/services/ffmpeg'` while each concern lives in its own one-writer file:
 *
 *   - ffmpeg-core    (TRUNK)    — spawn wrapper + stderr→progress parser   [here, frozen]
 *   - ffmpeg-extract (T-Media)  — 16kHz WAV extraction (PRD §6.1)
 *   - ffmpeg-export  (spine)    — frame-accurate cut + 9:16 reframe (PRD §6.5/§6.9)
 *   - ffmpeg-caption (spine)    — libass burn step composed into export (PRD §6.4)
 *
 * The trunk authors ONLY this barrel + ffmpeg-core. Each later track ADDS its
 * own `export * from './ffmpeg-<concern>'` line below in the marked seam when
 * it lands its module — they never co-edit ffmpeg-core or each other (E.4).
 */

export * from './ffmpeg-core'

// ── SEAM: fan-out tracks append their re-exports below (one writer per line) ──
export * from './ffmpeg-extract'
export * from './ffmpeg-export'
export * from './ffmpeg-caption'
