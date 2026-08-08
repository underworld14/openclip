/**
 * formatBytes — human file size for the whisper model rows (FEAT-1k76hk).
 *
 * Its own module so `TranscriptionSettings.tsx` exports only components
 * (react-refresh/only-export-components), matching how `settingsView`,
 * `clipView` and `Dashboard.view` split pure helpers out of their `.tsx`.
 */

/** Whisper models run 75MB–2.9GB, so MB/GB is the only useful range. */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const gb = bytes / 1_000_000_000
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1_000_000)} MB`
}
