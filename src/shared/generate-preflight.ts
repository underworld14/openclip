/**
 * src/shared/generate-preflight.ts — the configuration behind "Generate Clips"
 * (FEAT-n762y6).
 *
 * "Auto Generate Clips" was a single button with NO configuration surface at
 * all. Clip count, style, platform and min/max duration were read silently from
 * app + project settings, which made two PRD §6.3 acceptance criteria
 * unreachable: the clip-style presets (funny / educational / controversial /
 * emotional / motivational / storytelling) had no picker anywhere and
 * `clipStyle` was pinned to `'all'`, and "regenerate with a different
 * prompt/style" had no affordance. There was also no way to analyse only part of
 * a long source, so a 3-hour stream had to be sent whole — on a BYOK key the
 * user pays for.
 *
 * PURE, and in `@shared` on purpose: the defaults, the clamps and the range
 * slice are the load-bearing part, and they are asserted directly rather than
 * through a rendered dialog. The renderer owns only the widgets.
 *
 * THE DESIGN RULE, from OpusClip's submit panel: nothing is mandatory. Every
 * field arrives defaulted so the primary button is pressable the instant the
 * panel opens — configuring is an option the user takes, never a form they must
 * complete.
 */

import type { ClipStyle, Project, Settings, TranscriptSegment } from './schema'

// ============================================================================
// Clip-length presets
// ============================================================================

export type ClipLengthPresetId = 'auto' | 'short' | 'medium' | 'long'

export interface ClipLengthPreset {
  id: ClipLengthPresetId
  label: string
  minDuration: number
  maxDuration: number
}

/**
 * The buckets, mirroring OpusClip's `[0,30] [30,60] [60,90]` plus an Auto that
 * spans the app's own default bounds.
 *
 * `short` floors at 5s rather than the label's 0: a sub-5-second "clip" is not a
 * short-form video, it is an artefact of a model mis-reading a timestamp, and
 * the floor is the only thing standing between the user and an export of it.
 */
export const CLIP_LENGTH_PRESETS: readonly ClipLengthPreset[] = [
  { id: 'auto', label: 'Auto', minDuration: 15, maxDuration: 90 },
  { id: 'short', label: '0–30s', minDuration: 5, maxDuration: 30 },
  { id: 'medium', label: '30–60s', minDuration: 30, maxDuration: 60 },
  { id: 'long', label: '60–90s', minDuration: 60, maxDuration: 90 }
]

/** The preset by id, or undefined for `'custom'`. */
export function clipLengthPreset(id: ClipLengthPresetId): ClipLengthPreset {
  const found = CLIP_LENGTH_PRESETS.find((p) => p.id === id)
  // Every ClipLengthPresetId is in the table; the fallback exists so a widened
  // union in the future degrades to Auto rather than throwing at the user.
  return found ?? CLIP_LENGTH_PRESETS[0]
}

/**
 * Which bucket a min/max pair corresponds to, or `'custom'` when it matches none.
 *
 * `'custom'` is a real state, not a bug: a project whose settings say 20-70s must
 * KEEP those bounds when the panel opens. Snapping it to the nearest preset would
 * silently rewrite the user's configuration the first time they pressed Generate.
 */
export function presetIdForBounds(
  minDuration: number,
  maxDuration: number
): ClipLengthPresetId | 'custom' {
  const hit = CLIP_LENGTH_PRESETS.find(
    (p) => p.minDuration === minDuration && p.maxDuration === maxDuration
  )
  return hit?.id ?? 'custom'
}

// ============================================================================
// Style presets
// ============================================================================

export interface ClipStyleOption {
  id: ClipStyle
  label: string
  /** One line on what the model is told to prioritise, for the picker. */
  hint: string
  /**
   * The caption template this style nudges (Part K `captionPresets.ts` ids).
   *
   * LokaClip's lesson: ONE content-type control that swaps the AI prompt, the
   * subtitle preset and the layout together. One decision, coordinated effects —
   * rather than three unrelated dropdowns the user has to keep consistent by
   * hand. A NUDGE, though: an explicit caption choice is never overwritten.
   */
  captionTemplateId: string
}

export const CLIP_STYLE_OPTIONS: readonly ClipStyleOption[] = [
  {
    id: 'all',
    label: 'Anything',
    hint: 'Let the model pick whatever is most watchable.',
    captionTemplateId: 'default'
  },
  {
    id: 'funny',
    label: 'Funny',
    hint: 'Punchlines, banter, absurd tangents, genuine laughter.',
    captionTemplateId: 'beast-pop'
  },
  {
    id: 'educational',
    label: 'Educational',
    hint: 'Self-contained explanations, frameworks, how-to moments.',
    captionTemplateId: 'minimal'
  },
  {
    id: 'controversial',
    label: 'Controversial',
    hint: 'Hot takes, disagreement, claims people will argue about.',
    captionTemplateId: 'hormozi-bold'
  },
  {
    id: 'emotional',
    label: 'Emotional',
    hint: 'Vulnerability, adversity, heartfelt or nostalgic moments.',
    captionTemplateId: 'podcast'
  },
  {
    id: 'motivational',
    label: 'Motivational',
    hint: 'High-energy, inspiring, call-to-action moments.',
    captionTemplateId: 'hormozi'
  },
  {
    id: 'storytelling',
    label: 'Storytelling',
    hint: 'Complete arcs: setup, tension, resolution.',
    captionTemplateId: 'captionate'
  }
]

/** The caption template a style suggests, or undefined for an unknown style. */
export function captionTemplateForStyle(style: ClipStyle): string | undefined {
  return CLIP_STYLE_OPTIONS.find((o) => o.id === style)?.captionTemplateId
}

// ============================================================================
// The config
// ============================================================================

export interface PreflightRange {
  start: number
  end: number
}

export interface PreflightConfig {
  numClips: number
  lengthPreset: ClipLengthPresetId | 'custom'
  minDuration: number
  maxDuration: number
  clipStyle: ClipStyle
  /** Keyword targeting — the model is told to favour spans mentioning these. */
  keywords: string[]
  /** Free-text targeting ("find the parts about pricing"). */
  customPrompt: string
  /** Analyse only this span of the source. `null` ⇒ the whole thing. */
  range: PreflightRange | null
}

/** Hard ceiling, matching the runner's own trust-boundary clamp (openclip-9hc). */
export const MAX_CLIPS = 50
/** Keyword list caps — a prompt is not a tag cloud. */
export const MAX_KEYWORDS = 12
export const MAX_KEYWORD_LENGTH = 40
/** Free-text cap: long enough for a real instruction, short enough to not be a transcript. */
export const MAX_CUSTOM_PROMPT_LENGTH = 500

/**
 * Every field defaulted from what the app already knows, so the panel opens
 * ready to submit.
 *
 * The project's own settings win over the app defaults for style and bounds —
 * they are what a previous run wrote back, which is what makes Regenerate open
 * pre-filled rather than reset.
 */
export function defaultPreflight(project: Project, settings: Settings): PreflightConfig {
  const ps = project.settings
  const minDuration = ps.minDuration
  const maxDuration = ps.maxDuration
  return {
    numClips: settings.maxClips,
    lengthPreset: presetIdForBounds(minDuration, maxDuration),
    minDuration,
    maxDuration,
    clipStyle: ps.clipStyle,
    keywords: readStringArray(ps, 'generateKeywords'),
    customPrompt: readString(ps, 'generatePrompt'),
    range: readRange(ps, project.sourceVideo.duration)
  }
}

/**
 * `ProjectSettings` is a `z.looseObject`, so last-run values round-trip through
 * `.ocproj` without a schema break — but they arrive as `unknown` and a
 * hand-edited or older file can hold anything. Read defensively.
 */
function readStringArray(source: object, key: string): string[] {
  const v = (source as Record<string, unknown>)[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function readString(source: object, key: string): string {
  const v = (source as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

function readRange(source: object, duration: number): PreflightRange | null {
  const v = (source as Record<string, unknown>)['generateRange']
  if (!v || typeof v !== 'object') return null
  const { start, end } = v as { start?: unknown; end?: unknown }
  if (typeof start !== 'number' || typeof end !== 'number') return null
  return clampRange({ start, end }, duration)
}

/** Switch to a length bucket, carrying its bounds. */
export function applyLengthPreset(
  config: PreflightConfig,
  id: ClipLengthPresetId
): PreflightConfig {
  const preset = clipLengthPreset(id)
  return {
    ...config,
    lengthPreset: id,
    minDuration: preset.minDuration,
    maxDuration: preset.maxDuration
  }
}

/**
 * Split a raw keyword field into a clean list: comma OR newline separated,
 * trimmed, de-duplicated case-insensitively, capped.
 *
 * De-duplication is case-insensitive but preserves the FIRST spelling the user
 * typed — echoing their own casing back is what makes the chips read as theirs.
 */
export function parseKeywords(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[,\n]/)) {
    const kw = part.trim().slice(0, MAX_KEYWORD_LENGTH)
    if (!kw) continue
    const key = kw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(kw)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

/** Clamp a range into `[0, duration]` and drop it if it inverts or collapses. */
export function clampRange(range: PreflightRange, duration: number): PreflightRange | null {
  const start = Math.max(0, Math.min(range.start, duration))
  const end = Math.max(0, Math.min(range.end, duration))
  if (end - start < 1) return null
  return { start, end }
}

/** True when the range spans (effectively) the whole source, so sending it is noise. */
export function rangeCoversAll(range: PreflightRange | null, duration: number): boolean {
  if (!range) return true
  return range.start <= 0.001 && range.end >= duration - 0.001
}

/**
 * Clamp everything to the range the backend will accept, so an out-of-band value
 * can never reach the provider (and the user's key).
 *
 * The runner clamps `numClips` at its own trust boundary too. That is not
 * redundant: this one keeps the DIALOG honest about what will happen, and the
 * runner's keeps the JOB honest about what arrives over IPC.
 */
export function normalizePreflight(config: PreflightConfig, duration: number): PreflightConfig {
  const numClips = Math.max(1, Math.min(MAX_CLIPS, Math.floor(config.numClips) || 1))
  const minDuration = Math.max(1, Math.round(config.minDuration))
  // A max below the min asks for a set that cannot exist — widen rather than
  // silently returning nothing.
  const maxDuration = Math.max(minDuration, Math.round(config.maxDuration))
  const range = config.range ? clampRange(config.range, duration) : null
  return {
    ...config,
    numClips,
    minDuration,
    maxDuration,
    keywords: parseKeywords(config.keywords.join(',')),
    customPrompt: config.customPrompt.trim().slice(0, MAX_CUSTOM_PROMPT_LENGTH),
    // A full-coverage range is dropped so the cache key and the prompt match a
    // plain whole-video run — otherwise "analyse everything" would miss the
    // cache against an identical earlier run.
    range: rangeCoversAll(range, duration) ? null : range
  }
}

/**
 * The segments inside the range, or all of them when there is none.
 *
 * Partial overlaps are KEPT, matching every other span rule in the app: a
 * segment straddling the start is speech the user's chosen window contains, and
 * dropping it would hand the model a transcript that begins mid-sentence.
 */
export function sliceSegmentsToRange(
  segments: TranscriptSegment[],
  range: PreflightRange | null
): TranscriptSegment[] {
  if (!range) return segments
  return segments.filter((s) => s.end > range.start && s.start < range.end)
}

/**
 * The last-run values to persist back into `ProjectSettings`, so Regenerate
 * opens where the user left off.
 */
export function preflightToProjectSettings(
  config: PreflightConfig
): Record<string, unknown> & { clipStyle: ClipStyle; minDuration: number; maxDuration: number } {
  return {
    clipStyle: config.clipStyle,
    minDuration: config.minDuration,
    maxDuration: config.maxDuration,
    generateKeywords: config.keywords,
    generatePrompt: config.customPrompt,
    generateRange: config.range
  }
}

/** A one-line description of what pressing Generate will do, for the button row. */
export function preflightSummary(config: PreflightConfig, duration: number): string {
  const style = CLIP_STYLE_OPTIONS.find((o) => o.id === config.clipStyle)
  const parts = [
    `${config.numClips} clip${config.numClips === 1 ? '' : 's'}`,
    `${config.minDuration}–${config.maxDuration}s`,
    style ? style.label.toLowerCase() : config.clipStyle
  ]
  if (config.range && !rangeCoversAll(config.range, duration)) {
    parts.push(`${formatClock(config.range.start)}–${formatClock(config.range.end)}`)
  }
  if (config.keywords.length > 0) parts.push(`${config.keywords.length} keyword(s)`)
  if (config.customPrompt) parts.push('custom prompt')
  return parts.join(' · ')
}

/** `M:SS` / `H:MM:SS`, for the range summary only. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
