/**
 * src/main/services/whisper.ts — the whisper BARREL (plan E.4 decoupling pattern).
 *
 * Pure re-export aggregator so consumers `import { … } from
 * '@main/services/whisper'` while each concern lives in its own one-writer file:
 *
 *   - whisper-parse (TRUNK)    — pure whisper-cli JSON → contract mapper   [here, frozen]
 *   - whisper-spawn (T-Media)  — spawn whisper-cli, stream stderr progress (PRD §6.2)
 *
 * The trunk authors ONLY this barrel + whisper-parse (the proven transform that
 * finalized the `WordTimestamp`/`TranscriptSegment` contract at `contracts-v1`).
 * T-Media ADDS its own `export * from './whisper-spawn'` line in the marked seam
 * when it lands the runner — it never edits whisper-parse (E.4 "no shared file").
 */

export * from './whisper-parse'

// ── SEAM: T-Media appends its re-export below (one writer per line) ──
export * from './whisper-spawn'
