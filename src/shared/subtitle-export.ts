/**
 * src/shared/subtitle-export.ts — serialize a transcript to SRT / WebVTT / plain
 * text (FEAT-vwvgs0).
 *
 * PRD §6.2 lists transcript export as an acceptance criterion, and
 * `grep -rniE "srt|webvtt|\.vtt" src/` returned ZERO matches across the whole
 * tree: the app could burn captions into pixels but could not hand the user the
 * data. Every competitor ships SRT/VTT as data, not just as burned frames — it
 * is what you upload to YouTube, hand to a translator, or edit in a subtitle
 * editor.
 *
 * PURE: no ffmpeg, no filesystem, no Electron. The whole thing is a string
 * transformation over the transcript already in the store, which is why it lives
 * in `@shared` and is exhaustively unit-testable.
 */

import type { Transcript, TranscriptSegment } from './schema'

export type SubtitleFormat = 'srt' | 'vtt' | 'txt'

/** File extension for a format, for the save dialog and the sidecar writer. */
export function subtitleExtension(format: SubtitleFormat): string {
  return format
}

/**
 * `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT).
 *
 * The separator is the ONLY difference between the two timestamp formats, and
 * getting it wrong produces a file that silently fails to load in half the
 * players that accept it — hence one function with a flag rather than two that
 * can drift.
 */
export function formatTimestamp(seconds: number, format: 'srt' | 'vtt'): string {
  const clamped = Math.max(0, seconds)
  const totalMs = Math.round(clamped * 1000)
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const sep = format === 'srt' ? ',' : '.'
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`
}

/**
 * Cues to emit, optionally scoped and rebased to a clip.
 *
 * When `clip` is given, only segments intersecting it survive, partial overlaps
 * are clamped to its bounds, and times are rebased so the first frame is t=0 —
 * the same rule the caption burner follows. A sidecar `.srt` beside an exported
 * clip has to match that clip's timeline, not the source's.
 */
export function cuesFor(
  segments: TranscriptSegment[],
  clip?: { start: number; end: number }
): { start: number; end: number; text: string }[] {
  const cues: { start: number; end: number; text: string }[] = []
  for (const seg of segments) {
    const text = seg.text.trim()
    if (!text) continue
    if (!clip) {
      cues.push({ start: seg.start, end: seg.end, text })
      continue
    }
    if (seg.end <= clip.start || seg.start >= clip.end) continue
    const start = Math.max(seg.start, clip.start) - clip.start
    const end = Math.min(seg.end, clip.end) - clip.start
    if (end <= start) continue
    cues.push({ start, end, text })
  }
  return cues
}

/** SubRip. Cues are 1-indexed and separated by a blank line. */
export function toSrt(transcript: Transcript, clip?: { start: number; end: number }): string {
  const cues = cuesFor(transcript.segments, clip)
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${formatTimestamp(c.start, 'srt')} --> ${formatTimestamp(c.end, 'srt')}\n${c.text}`
      )
      .join('\n\n') + (cues.length > 0 ? '\n' : '')
  )
}

/** WebVTT. Same cues, dot-separated times, and the mandatory `WEBVTT` header. */
export function toVtt(transcript: Transcript, clip?: { start: number; end: number }): string {
  const cues = cuesFor(transcript.segments, clip)
  const body = cues
    .map(
      (c) => `${formatTimestamp(c.start, 'vtt')} --> ${formatTimestamp(c.end, 'vtt')}\n${c.text}`
    )
    .join('\n\n')
  return `WEBVTT\n\n${body}${cues.length > 0 ? '\n' : ''}`
}

/**
 * Plain text — no timings, one paragraph per segment.
 *
 * Worth having as its own format rather than telling people to strip an SRT:
 * this is what goes into a blog post, a show-notes draft or an LLM prompt, and
 * asking a user to clean up timestamps by hand is asking them to do work the app
 * can do for free.
 */
export function toPlainText(transcript: Transcript, clip?: { start: number; end: number }): string {
  const cues = cuesFor(transcript.segments, clip)
  return cues.map((c) => c.text).join('\n') + (cues.length > 0 ? '\n' : '')
}

/** Serialize in the requested format. */
export function serializeTranscript(
  transcript: Transcript,
  format: SubtitleFormat,
  clip?: { start: number; end: number }
): string {
  switch (format) {
    case 'srt':
      return toSrt(transcript, clip)
    case 'vtt':
      return toVtt(transcript, clip)
    case 'txt':
      return toPlainText(transcript, clip)
  }
}
