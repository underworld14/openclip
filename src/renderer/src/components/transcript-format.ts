/**
 * transcript-format — pure presentation helpers for TranscriptPanel (T-Media,
 * E.3). Kept in its own module so the component file only exports a component
 * (react-refresh boundary).
 */

/** seconds → `m:ss` (or `h:mm:ss`) for a segment timestamp label (PRD §6.2). */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
