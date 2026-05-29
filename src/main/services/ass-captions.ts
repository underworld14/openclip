/**
 * src/main/services/ass-captions.ts — word-level KARAOKE caption generation
 * (CAPTION-BURN spine, plan E.5 / PRD §6.4). PURE: no FFmpeg, no Electron, no
 * filesystem — it turns a clip's word timestamps + a `CaptionStyle` into the
 * text of a libass `.ass` subtitle file. The export runner writes the returned
 * string to the temp job dir and burns it via the proven filtergraph
 * (`scale,crop,subtitles=<ass>:fontsdir=<paths.fontsDir()>`, fix M3).
 *
 * WHY ASS + `\k` (PRD §6.4): word-level highlight is rendered by libass's native
 * karaoke, NOT per-word `drawtext`. Each word is a `{\k<cs>}word` cue where `<cs>`
 * is the word's duration in CENTISECONDS (1cs = 10ms — the karaoke unit). libass
 * fills/highlights each word for exactly that long, in order, starting at the
 * Dialogue line's Start time. We model inter-word silence with an empty
 * `{\k<gap>}` syllable so the highlight stays time-accurate even when whisper
 * leaves gaps between words.
 *
 * TIME MODEL (the load-bearing rebasing rule): the export cut starts at the
 * clip's absolute `start` (resolveBounds), so the exported video's timeline is
 * CLIP-RELATIVE (first frame = t0). Caption times MUST therefore be rebased:
 * every word time has the clip start subtracted (`abs - clipStart`). Words are
 * also SCOPED to the clip: only words intersecting `[clipStart, clipEnd]` are
 * kept; partial overlaps are clamped to the clip bounds.
 *
 * COLOR (verified vs FFmpeg docs — `force_style='…PrimaryColour=&HCCFF0000'`):
 * ASS colors are `&HAABBGGRR` — alpha + BLUE-GREEN-RED (NOT RGB), alpha 00 =
 * fully opaque, FF = fully transparent. `#RRGGBB` is converted by reversing the
 * byte order to BGR and prefixing opaque alpha → `&H00BBGGRR`.
 *
 * STYLE MAPPING (PRD §6.4 / §9.3 `CaptionStyle`): font/size/color/bg/position/
 * animation map onto a single ASS `Style:` line + per-line override tags:
 *   - fontFamily  → Style Fontname  (must match a face in fontsdir; default
 *                   `DejaVu Sans` → build/fonts/DejaVuSans.ttf)
 *   - fontSize    → Style Fontsize
 *   - fontColor   → SecondaryColour (the PRE-highlight word color) so the
 *                   karaoke FILL reveals it; PrimaryColour is the highlight color
 *   - backgroundColor → BackColour + BorderStyle=3 (opaque box behind text)
 *   - position    → Alignment (\an numpad: bottom=2, middle=5, top=8)
 *   - animation   → a leading override block (`pop`→`\fscx/\fscy` bounce via
 *                   `\t`, `fade`→`\fad`, `typewriter`→handled by `\k` itself,
 *                   `none`→nothing). Karaoke highlight is independent of this.
 */

import type { CaptionStyle, WordTimestamp } from '@shared/schema'

// ============================================================================
// Constants
// ============================================================================

/** ASS script resolution the styles are authored against — matches the 1080×1920
 * export canvas so Fontsize/Margins are in output pixels (PlayResX/Y). */
export const ASS_PLAY_RES = { x: 1080, y: 1920 } as const

/** Default style if a caller passes none (mirrors the bundled font, PRD §6.4). */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'DejaVu Sans',
  fontSize: 64,
  fontColor: '#FFFFFF',
  backgroundColor: '#000000',
  position: 'bottom',
  animation: 'none',
  highlightCurrentWord: true,
  emojiEnabled: false
}

/** The highlight (karaoke-fill) color words turn once spoken. */
const HIGHLIGHT_COLOR_ASS = '&H0000FFFF' // opaque yellow (BGR: 00 FF FF)

// ============================================================================
// Color conversion — #RRGGBB → ASS &HAABBGGRR (BGR, alpha 00 = opaque)
// ============================================================================

/**
 * Convert a CSS-ish hex color (`#RGB`, `#RRGGBB`, `#RRGGBBAA`, or already an ASS
 * `&H…` literal) to an ASS `&HAABBGGRR` color. Reverses RGB→BGR (the load-bearing
 * gotcha) and maps CSS alpha (FF=opaque) to ASS alpha (00=opaque). Unparseable
 * input falls back to opaque white so a burn never fails on a bad style.
 */
export function toAssColor(input: string): string {
  const s = input.trim()
  // Pass through an explicit ASS literal unchanged (caller knows the format).
  if (/^&H[0-9A-Fa-f]{1,8}&?$/.test(s)) {
    const hex = s.replace(/^&H/, '').replace(/&$/, '').toUpperCase().padStart(8, '0')
    return `&H${hex}`
  }
  const hex = s.replace(/^#/, '')
  let r: number,
    g: number,
    b: number,
    a = 255
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16)
    g = parseInt(hex[1] + hex[1], 16)
    b = parseInt(hex[2] + hex[2], 16)
  } else if (hex.length === 6 || hex.length === 8) {
    r = parseInt(hex.slice(0, 2), 16)
    g = parseInt(hex.slice(2, 4), 16)
    b = parseInt(hex.slice(4, 6), 16)
    if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16)
  } else {
    return '&H00FFFFFF' // opaque white fallback
  }
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return '&H00FFFFFF'
  // ASS alpha is INVERTED (00 opaque, FF transparent) vs CSS (FF opaque).
  const assAlpha = 255 - a
  const h2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0')
  return `&H${h2(assAlpha)}${h2(b)}${h2(g)}${h2(r)}`
}

// ============================================================================
// Text escaping for ASS event lines
// ============================================================================

/**
 * Escape a word for an ASS Dialogue text field. ASS uses `{…}` for override
 * blocks and `\` for special sequences (`\n`, `\N`, `\h`); a literal `{`/`}` or
 * `\` in spoken text would corrupt the cue. We neutralize them:
 *   - `\`  → `\\`  (so a literal backslash isn't read as an escape)
 *   - `{`  → `\{`  and `}` → `\}`  (so braces aren't read as override blocks)
 * Real newlines are collapsed to a space (a single word should never contain one,
 * but transcripts occasionally do). Leading/trailing whitespace is trimmed by the
 * caller; internal whitespace is preserved.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/[\r\n]+/g, ' ')
}

// ============================================================================
// Token filtering — drop whisper special / blank tokens
// ============================================================================

/**
 * Whether a word entry should be dropped before captioning. whisper emits
 * special-token entries (`[_BEG_]`, `[_TT_123]`, `[_EOT_]`, `<|…|>`) and
 * blank/whitespace-only words; none should appear as a karaoke syllable.
 */
export function isDroppableToken(word: string): boolean {
  const w = word.trim()
  if (w.length === 0) return true
  // whisper bracket special tokens: [_BEG_], [_TT_700], [_EOT_], [_SOT_], …
  if (/^\[_[A-Z]+_?\d*_?\]$/.test(w)) return true
  // angle-bracket special tokens: <|endoftext|>, <|0.00|>, <|nospeech|>, …
  if (/^<\|.*\|>$/.test(w)) return true
  return false
}

// ============================================================================
// Time helpers
// ============================================================================

/** Round seconds to whole CENTISECONDS (the `\k` unit; 1cs = 10ms). */
export function toCentiseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 100))
}

/**
 * Format absolute (clip-relative) seconds as an ASS timestamp `H:MM:SS.cc`
 * (centisecond precision — ASS uses exactly two fractional digits). Negative
 * inputs clamp to 0.
 */
export function formatAssTime(seconds: number): string {
  const cs = toCentiseconds(seconds)
  const totalCs = cs
  const h = Math.floor(totalCs / 360000)
  const m = Math.floor((totalCs % 360000) / 6000)
  const s = Math.floor((totalCs % 6000) / 100)
  const c = totalCs % 100
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${h}:${p2(m)}:${p2(s)}.${p2(c)}`
}

// ============================================================================
// Scope + rebase words to a clip
// ============================================================================

/** A word with clip-RELATIVE timestamps (clip start subtracted), special/blank dropped. */
export interface RebasedWord {
  word: string
  /** seconds, relative to the clip start (>= 0). */
  start: number
  /** seconds, relative to the clip start. */
  end: number
}

/**
 * Scope `words` to the clip's absolute `[clipStart, clipEnd]` range and rebase
 * to clip-relative time. A word is KEPT if it intersects the range (its end is
 * after clipStart AND its start is before clipEnd); partial overlaps are clamped
 * to the clip bounds. Special/blank tokens are dropped. Output is rebased
 * (clipStart subtracted), sorted by start, with non-negative monotonic times.
 */
export function scopeWordsToClip(
  words: WordTimestamp[],
  clipStart: number,
  clipEnd: number
): RebasedWord[] {
  const out: RebasedWord[] = []
  for (const w of words) {
    if (isDroppableToken(w.word)) continue
    // Intersection test against the clip range (half-open; touch at edge dropped).
    if (w.end <= clipStart || w.start >= clipEnd) continue
    const start = Math.max(w.start, clipStart) - clipStart
    const end = Math.min(w.end, clipEnd) - clipStart
    if (!(end > start)) continue // zero/negative span after clamping
    out.push({ word: w.word.trim(), start, end })
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

// ============================================================================
// Karaoke cue building — the `{\k<cs>}word` string for a line of words
// ============================================================================

/**
 * Build the ASS karaoke TEXT for an ordered run of rebased words, plus the line's
 * Start/End times. Each word becomes `{\k<dur_cs>}<escaped word>` where `dur_cs`
 * is that word's spoken duration in centiseconds. Inter-word SILENCE is modeled
 * with a leading empty syllable `{\k<gap_cs>}` so the karaoke highlight reaches
 * each word at the right moment. A single space separates words in the rendered
 * text (the space rides on the next word's syllable so it highlights with it).
 *
 * Returned `text` example for words [(0.00–0.20 "Hello"), (0.35–0.60 "World")]:
 *   `{\k20}Hello{\k15}{\k25} World`
 * (Hello: 20cs; then a 15cs gap syllable for the 0.20→0.35 silence; then World
 * 25cs prefixed with its leading space.) Line Start = first word start, End =
 * last word end.
 */
export function buildKaraokeLine(words: RebasedWord[]): {
  text: string
  startSec: number
  endSec: number
} {
  if (words.length === 0) return { text: '', startSec: 0, endSec: 0 }
  const startSec = words[0].start
  const endSec = words[words.length - 1].end

  let prevEnd = startSec
  const parts: string[] = []
  words.forEach((w, i) => {
    // Gap (silence) before this word, as an empty karaoke syllable.
    const gapCs = toCentiseconds(w.start - prevEnd)
    if (gapCs > 0) parts.push(`{\\k${gapCs}}`)
    const durCs = toCentiseconds(w.end - w.start)
    const space = i === 0 ? '' : ' '
    parts.push(`{\\k${durCs}}${space}${escapeAssText(w.word)}`)
    prevEnd = w.end
  })
  return { text: parts.join(''), startSec, endSec }
}

// ============================================================================
// Style → ASS Style line + per-line animation/position override
// ============================================================================

/** ASS `\an` numpad alignment for the caption position (center column). */
export function alignmentFor(position: CaptionStyle['position']): number {
  switch (position) {
    case 'top':
      return 8 // top-center
    case 'middle':
      return 5 // middle-center
    case 'bottom':
      return 2 // bottom-center
  }
}

/**
 * The leading override block applied to every Dialogue line for the chosen
 * animation (PRD §6.4 pop/fade/typewriter). Returned WITHOUT surrounding braces
 * (the caller wraps once, together with any other line tags). Empty string for
 * `none` and `typewriter` (typewriter is achieved by the `\k` reveal itself, so
 * no extra tag is needed).
 *   - pop  → `\fscx60\fscy60\t(0,150,\fscx100\fscy100)` (scale-bounce in)
 *   - fade → `\fad(150,0)` (150ms fade-in)
 */
export function animationOverride(animation: CaptionStyle['animation']): string {
  switch (animation) {
    case 'pop':
      return '\\fscx60\\fscy60\\t(0,150,\\fscx100\\fscy100)'
    case 'fade':
      return '\\fad(150,0)'
    case 'typewriter':
    case 'none':
    default:
      return ''
  }
}

/**
 * Build the single ASS `Style:` line for a `CaptionStyle` (style name `Karaoke`).
 * Field order is the canonical ASS V4+ Styles order (must match the Format line
 * emitted in `buildAss`). PrimaryColour is the HIGHLIGHT color (what a word turns
 * once the karaoke fill reaches it); SecondaryColour is the pre-highlight word
 * color (the user's `fontColor`) — this is what makes `\k` actually "light up"
 * each word. BorderStyle=3 + BackColour draws an opaque box behind the text
 * (the user's `backgroundColor`); Outline/Shadow give legibility.
 */
export function buildStyleLine(style: CaptionStyle): string {
  const fontColor = toAssColor(style.fontColor) // pre-highlight (SecondaryColour)
  const bg = toAssColor(style.backgroundColor) // box (BackColour)
  // Part I caption presets — all optional; the defaults reproduce the pre-Part-I
  // output byte-for-byte (yellow highlight, opaque-black outline width 3, no shadow).
  const highlight = style.highlightColor ? toAssColor(style.highlightColor) : HIGHLIGHT_COLOR_ASS
  const outlineColor = style.strokeColor ? toAssColor(style.strokeColor) : '&H00000000'
  const outlineWidth = style.strokeWidth ?? 3
  const shadow = style.shadow ? 2 : 0
  // A fully-TRANSPARENT background (ASS alpha FF) renders outlined text with NO
  // box (BorderStyle 1, the punchy preset look); a semi/opaque background draws
  // an opaque box (BorderStyle 3 — the pre-Part-I default, so existing styles
  // with an opaque `backgroundColor` are unchanged).
  const borderStyle = /^&HFF/i.test(bg) ? 1 : 3
  const fields = [
    'Karaoke', // Name
    style.fontFamily, // Fontname
    String(style.fontSize), // Fontsize
    highlight, // PrimaryColour (highlight / karaoke fill)
    fontColor, // SecondaryColour (pre-highlight word)
    outlineColor, // OutlineColour
    bg, // BackColour (box)
    '0', // Bold
    '0', // Italic
    '0', // Underline
    '0', // StrikeOut
    '100', // ScaleX
    '100', // ScaleY
    '0', // Spacing
    '0', // Angle
    String(borderStyle), // BorderStyle (3 = opaque box, 1 = outline only)
    String(outlineWidth), // Outline
    String(shadow), // Shadow
    String(alignmentFor(style.position)), // Alignment
    '60', // MarginL
    '60', // MarginR
    '80', // MarginV
    '1' // Encoding (1 = default)
  ]
  return `Style: ${fields.join(',')}`
}

// ============================================================================
// Full .ass file assembly
// ============================================================================

export interface BuildAssOptions {
  /** The clip's word timestamps (ABSOLUTE seconds — the project transcript words). */
  words: WordTimestamp[]
  /** Clip start in ABSOLUTE seconds (resolveBounds().start). */
  clipStart: number
  /** Clip end in ABSOLUTE seconds (resolveBounds().end). */
  clipEnd: number
  /** Caption style; defaults to DEFAULT_CAPTION_STYLE. */
  style?: CaptionStyle
  /**
   * Max words per caption line before a new Dialogue line starts (readability).
   * Default 7 (typical short-form caption chunk). Lines also break on a long
   * silence gap (`gapBreakSec`).
   */
  maxWordsPerLine?: number
  /** Start a new line when the silence before a word exceeds this (s). Default 0.8. */
  gapBreakSec?: number
}

/** A grouped run of words that becomes one Dialogue line. */
function groupIntoLines(
  words: RebasedWord[],
  maxWordsPerLine: number,
  gapBreakSec: number
): RebasedWord[][] {
  const lines: RebasedWord[][] = []
  let current: RebasedWord[] = []
  let prevEnd: number | null = null
  for (const w of words) {
    const longGap = prevEnd !== null && w.start - prevEnd > gapBreakSec
    if (current.length >= maxWordsPerLine || longGap) {
      if (current.length > 0) lines.push(current)
      current = []
    }
    current.push(w)
    prevEnd = w.end
  }
  if (current.length > 0) lines.push(current)
  return lines
}

const ASS_HEADER_FORMAT =
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding'

const ASS_EVENTS_FORMAT =
  'Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text'

/**
 * Build the FULL `.ass` file text for a clip's karaoke captions. Pure: returns a
 * string; the export runner writes it to `<jobTempDir>/clip-<id>.captions.ass`
 * and burns it with `subtitles=<that>:fontsdir=<paths.fontsDir()>`.
 *
 * Structure: `[Script Info]` (with PlayResX/Y = the export canvas so Fontsize is
 * in output pixels) → `[V4+ Styles]` (one `Karaoke` style from the CaptionStyle)
 * → `[Events]` (one karaoke `Dialogue` line per grouped run of words). Returns a
 * header-only file (no Dialogue lines) when no word intersects the clip.
 */
export function buildAss(opts: BuildAssOptions): string {
  const style = opts.style ?? DEFAULT_CAPTION_STYLE
  const maxWords = opts.maxWordsPerLine ?? 7
  const gapBreak = opts.gapBreakSec ?? 0.8

  const scoped = scopeWordsToClip(opts.words, opts.clipStart, opts.clipEnd)
  const lines = groupIntoLines(scoped, maxWords, gapBreak)
  const anim = animationOverride(style.animation)

  const dialogue = lines.map((run) => {
    const { text, startSec, endSec } = buildKaraokeLine(run)
    const lead = anim ? `{${anim}}` : ''
    return `Dialogue: 0,${formatAssTime(startSec)},${formatAssTime(endSec)},Karaoke,,0,0,0,,${lead}${text}`
  })

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${ASS_PLAY_RES.x}`,
    `PlayResY: ${ASS_PLAY_RES.y}`,
    '',
    '[V4+ Styles]',
    ASS_HEADER_FORMAT,
    buildStyleLine(style),
    '',
    '[Events]',
    ASS_EVENTS_FORMAT,
    ...dialogue,
    '' // trailing newline
  ].join('\n')
}
