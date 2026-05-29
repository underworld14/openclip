/**
 * src/shared/keep-ranges.ts — PURE math for silence/filler jump-cuts (Part I.4).
 *
 * A "keep range" is a `[start, end]` span of the SOURCE (absolute seconds) that
 * survives a jump-cut export; the gaps between keep ranges are removed silences.
 * `computeKeepRanges` turns a clip span + detected silences into the spans to
 * keep; `compressTime` maps an absolute source time onto the COMPRESSED
 * (silence-removed) clip-relative timeline so captions stay in sync.
 *
 * Shared (main builds the ffmpeg filtergraph from keep ranges; ass-captions
 * remaps word times) — no Electron/ffmpeg here, fully unit-testable.
 */

/** An inclusive `[start, end]` span in absolute source seconds. */
export type Range = [number, number]

export interface KeepRangeOptions {
  /** Only remove silences at least this long (seconds). Default 0.6. */
  minSilenceSec?: number
  /** Keep this much silence adjacent to speech on each side of a cut. Default 0.05. */
  padSec?: number
}

const DEFAULTS = { minSilenceSec: 0.6, padSec: 0.05 } as const

/** Round to whole milliseconds — keeps boundaries clean/deterministic (no float
 * dust from padding) and is far finer than any silence-cut needs. */
const r3 = (n: number): number => Math.round(n * 1000) / 1000

/**
 * Compute the spans to KEEP for a clip `[clipStart, clipEnd]` given detected
 * `silences` (absolute). Silences shorter than `minSilenceSec` are ignored; the
 * rest are shrunk by `padSec` on each side (so cuts keep a little breath) and
 * removed. Returns merged keep ranges clamped to the clip, ascending and
 * non-overlapping. Falls back to the whole clip when nothing qualifies (so the
 * caller can always render something).
 */
export function computeKeepRanges(
  clipStart: number,
  clipEnd: number,
  silences: Range[],
  opts: KeepRangeOptions = {}
): Range[] {
  const minSilence = opts.minSilenceSec ?? DEFAULTS.minSilenceSec
  const pad = opts.padSec ?? DEFAULTS.padSec
  const whole: Range[] = [[clipStart, clipEnd]]
  if (!(clipEnd > clipStart)) return whole

  // Clamp to the clip, keep only long-enough silences, shrink by pad → removed.
  const removed: Range[] = []
  for (const [s0, e0] of silences) {
    const s = Math.max(clipStart, s0)
    const e = Math.min(clipEnd, e0)
    if (e - s < minSilence) continue
    const rs = r3(s + pad)
    const re = r3(e - pad)
    if (re - rs > 0) removed.push([rs, re])
  }
  if (removed.length === 0) return whole

  // Merge overlapping/adjacent removed intervals.
  removed.sort((a, b) => a[0] - b[0])
  const mergedRemoved: Range[] = [removed[0]]
  for (let i = 1; i < removed.length; i++) {
    const last = mergedRemoved[mergedRemoved.length - 1]
    if (removed[i][0] <= last[1]) last[1] = Math.max(last[1], removed[i][1])
    else mergedRemoved.push(removed[i])
  }

  // Keep = complement of removed within [clipStart, clipEnd].
  const keep: Range[] = []
  let cursor = clipStart
  for (const [rs, re] of mergedRemoved) {
    if (rs > cursor) keep.push([cursor, rs])
    cursor = Math.max(cursor, re)
  }
  if (cursor < clipEnd) keep.push([cursor, clipEnd])

  return keep.length > 0 ? keep : whole
}

/** Total kept duration — the length of the compressed clip. */
export function keptDuration(keepRanges: Range[]): number {
  return keepRanges.reduce((acc, [a, b]) => acc + Math.max(0, b - a), 0)
}

/** Whether the keep ranges actually drop anything (vs a single full-span keep). */
export function removesAnything(keepRanges: Range[], clipStart: number, clipEnd: number): boolean {
  if (keepRanges.length !== 1) return keepRanges.length > 1
  const [a, b] = keepRanges[0]
  return a > clipStart + 1e-6 || b < clipEnd - 1e-6
}

/**
 * Map an absolute source time onto the COMPRESSED clip-relative timeline (the
 * removed gaps collapse out). Returns `null` when `t` falls strictly inside a
 * removed gap. The first keep range's start maps to 0.
 */
export function compressTime(t: number, keepRanges: Range[]): number | null {
  let acc = 0
  for (const [a, b] of keepRanges) {
    if (t < a) return null // inside the gap before this range
    if (t <= b) return acc + (t - a)
    acc += b - a
  }
  return null // after the last keep range
}

/**
 * Like `compressTime` but never null: a time in a removed gap SNAPS to the cut
 * point (the cumulative kept duration up to that gap), and a time past the end
 * clamps to the total. Used to remap caption word bounds so a word straddling a
 * cut still renders (zero-length results are dropped by the caption builder).
 */
export function compressTimeClamped(t: number, keepRanges: Range[]): number {
  let acc = 0
  for (const [a, b] of keepRanges) {
    if (t <= a) return acc // in the gap before this range (or exactly at its start)
    if (t <= b) return acc + (t - a)
    acc += b - a
  }
  return acc // past the last keep range → total kept duration
}
