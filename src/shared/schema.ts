/**
 * src/shared/schema.ts — THE Zod source-of-truth for OpenClip's data model.
 *
 * FROZEN as part of the OUTER contract (plan E.2, Wave-1 freeze / tag
 * `contracts-outer`). Both the main and renderer processes import the inferred
 * TS types from here; the runtime Zod schemas are used for `.ocproj`
 * load-validation, AI structured-output parsing, and the contract-fixture
 * tests (plan E.7 drift detection).
 *
 * Authoritative spec: PRD v2.0.0 §9.3 (Project data model) + §7.1 (AI
 * ClipSchema). Shapes here implement the PRD exactly — nothing beyond it.
 *
 * STRICTNESS NOTE (PRD §10.3 / plan Part B — OpenAI `json_schema` strict):
 * the AI-facing `ClipSchema` (and its nested objects) use `z.strictObject`,
 * which is Zod 4's idiom for `additionalProperties: false` (Zod 4 deprecated
 * the `.object().strict()` method — verified against current Zod 4 docs).
 * `z.toJSONSchema(ClipSchema)` therefore emits `additionalProperties:false`
 * with every property `required`, exactly what OpenAI strict json_schema and
 * Anthropic `zodOutputFormat` demand. Internal persistence schemas use plain
 * `z.object` (forward-compatible: tolerate unknown keys from newer versions).
 */

import { z } from 'zod'

// ============================================================================
// FINALIZED (was provisional) — media-derived shapes. Frozen at `contracts-v1`.
// ============================================================================
// Discovered by the Stage-4 media de-risk smoke: the REAL bundled `whisper-cli`
// (whisper.cpp 1.8.4) run on Metal over a fixture with `-ml 1 --split-on-word
// --output-json-full --print-confidence`. Its on-disk JSON shape is:
//
//   { systeminfo, model, params, result: { language },
//     transcription: [ {
//       timestamps: { from: "HH:MM:SS,mmm", to: "HH:MM:SS,mmm" },  // string form
//       offsets:    { from: <ms int>,      to: <ms int> },         // MILLISECONDS
//       text: " word",                                             // leading space
//       tokens: [ { text, timestamps, offsets, id, p: <0..1 prob>, t_dtw } ]
//     }, … ] }
//
// Mapping to the PRD §9.3 shapes below (done in `parseWhisperJson`, see
// services/whisper-parse + tests/fixtures/whisper/):
//   • times are converted ms→seconds (`offsets.from/to / 1000`), ABSOLUTE.
//   • a WORD = one `transcription[]` entry (with `--split-on-word` each entry is
//     a whole word, not a sub-token piece); blank/empty-text entries (the leading
//     `[_BEG_]` and trailing `[_TT_*]` special-token entries) are dropped.
//   • `confidence` is DERIVED — whisper has no first-class word confidence; we use
//     the MEAN of the entry's non-special token `p` (probability) values, in 0..1.
//   • SEGMENTS (sentences) are grouped from the word stream on sentence-ending
//     punctuation (the LLM only ever sees segment-level text — PRD §16 budget);
//     a segment's `confidence` is the mean of its words' confidences.
//   • `result.language` → `Transcript.language` / `JobResult.transcribe.language`.
//
// These three types are now FROZEN as part of `contracts-v1`. Any further change
// is a serialized contract-change request through the trunk owner (plan E.2).

/** PRD §9.3 `WordTimestamp`. One whisper word (see derivation note above). */
export const WordTimestamp = z.object({
  word: z.string(), // trimmed entry text, e.g. "Hello" (no leading space)
  start: z.number(), // seconds, absolute (offsets.from / 1000)
  end: z.number(), // seconds, absolute (offsets.to / 1000)
  confidence: z.number() // 0..1, mean of the word's token `p` values
})
export type WordTimestamp = z.infer<typeof WordTimestamp>

/** PRD §9.3 `TranscriptSegment`. A sentence grouped from the word stream. */
export const TranscriptSegment = z.object({
  id: z.string(), // stable id, e.g. "seg-0", "seg-1", …
  start: z.number(), // seconds, absolute (first word's start)
  end: z.number(), // seconds, absolute (last word's end)
  text: z.string(), // joined word text, single-spaced + trimmed
  speakerId: z.string().optional(), // v0.4 (diarization)
  confidence: z.number() // 0..1, mean of the segment's word confidences
})
export type TranscriptSegment = z.infer<typeof TranscriptSegment>

// ============================================================================
// Caption / styling (PRD §9.3 + §6.4)
// ============================================================================

/** PRD §9.3 `CaptionStyle`. Mapped to ASS `Style:` / `force_style` at burn time. */
export const CaptionStyle = z.object({
  fontFamily: z.string(),
  fontSize: z.number(),
  fontColor: z.string(), // hex / ASS color
  backgroundColor: z.string(),
  position: z.enum(['top', 'middle', 'bottom']),
  animation: z.enum(['none', 'pop', 'fade', 'typewriter']),
  highlightCurrentWord: z.boolean(),
  emojiEnabled: z.boolean()
})
export type CaptionStyle = z.infer<typeof CaptionStyle>

/**
 * A single rendered caption cue (PRD §9.3 "Caption … as in v1, unchanged").
 * Word entries drive the karaoke `\k` centisecond fill (PRD §6.4).
 */
export const Caption = z.object({
  start: z.number(), // seconds, relative to the clip
  end: z.number(), // seconds, relative to the clip
  text: z.string(),
  words: z.array(WordTimestamp).optional(), // per-word karaoke timing
  style: CaptionStyle.optional()
})
export type Caption = z.infer<typeof Caption>

// ============================================================================
// Clip (PRD §9.3) — note editedStart/editedEnd for the minimal-timeline trim
// ============================================================================

export const ClipStatus = z.enum(['suggested', 'approved', 'edited', 'exported'])
export type ClipStatus = z.infer<typeof ClipStatus>

/** PRD §9.3 `Clip`. */
export const Clip = z.object({
  id: z.string(),
  startTime: z.number(), // seconds, absolute (AI-suggested span start)
  endTime: z.number(), // seconds, absolute (AI-suggested span end)
  title: z.string(),
  hook: z.string(),
  viralityScore: z.number(), // 1-10
  clipType: z.string(),
  keywords: z.array(z.string()),
  status: ClipStatus,
  editedStart: z.number().optional(), // timeline trim (overrides startTime on export)
  editedEnd: z.number().optional(), // timeline trim (overrides endTime on export)
  captions: z.array(Caption).optional(),
  thumbnailPath: z.string().optional()
})
export type Clip = z.infer<typeof Clip>

// ============================================================================
// Speaker (PRD §9.3, v0.4 — typed now, unused in MVP)
// ============================================================================

export const Speaker = z.object({
  id: z.string(),
  label: z.string(), // "Speaker A", "Speaker B", or user-renamed
  color: z.string().optional() // per-speaker caption color (v0.4)
})
export type Speaker = z.infer<typeof Speaker>

// ============================================================================
// Project-level settings (PRD §9.3 `Project.settings`)
// ============================================================================

export const TargetPlatform = z.enum(['tiktok', 'youtube', 'instagram', 'all'])
export type TargetPlatform = z.infer<typeof TargetPlatform>

export const AspectRatio = z.enum(['9:16', '1:1', '4:5', '16:9'])
export type AspectRatio = z.infer<typeof AspectRatio>

export const ClipStyle = z.enum([
  'all',
  'funny',
  'educational',
  'controversial',
  'emotional',
  'motivational',
  'storytelling'
])
export type ClipStyle = z.infer<typeof ClipStyle>

/** Per-project generation/export settings (PRD §9.3 `Project.settings`). */
export const ProjectSettings = z.object({
  targetPlatform: TargetPlatform,
  aspectRatio: AspectRatio,
  clipStyle: ClipStyle,
  maxClips: z.number(),
  minDuration: z.number(), // default 15
  maxDuration: z.number() // default 90
})
export type ProjectSettings = z.infer<typeof ProjectSettings>

// ============================================================================
// Brand template (PRD §6.8 / §9.3, v0.5 — typed now, unused in MVP)
// ============================================================================

export const BrandTemplate = z.object({
  id: z.string(),
  name: z.string(),
  logoPath: z.string().optional(),
  brandColors: z.array(z.string()).optional(),
  fontFamily: z.string().optional(),
  introPath: z.string().optional(),
  outroPath: z.string().optional()
})
export type BrandTemplate = z.infer<typeof BrandTemplate>

// ============================================================================
// Export history (PRD §9.3 `ExportRecord … as in v1, unchanged`)
// ============================================================================

export const ExportRecord = z.object({
  id: z.string(),
  clipId: z.string(),
  outputPath: z.string(),
  exportedAt: z.number(), // epoch ms
  width: z.number(),
  height: z.number(),
  format: z.string() // e.g. "mp4"
})
export type ExportRecord = z.infer<typeof ExportRecord>

// ============================================================================
// Source video metadata (PRD §9.3 `Project.sourceVideo`)
// ============================================================================

export const VideoResolution = z.object({
  width: z.number(),
  height: z.number()
})
export type VideoResolution = z.infer<typeof VideoResolution>

export const SourceVideo = z.object({
  path: z.string(),
  duration: z.number(), // seconds
  resolution: VideoResolution,
  fps: z.number(),
  format: z.string()
})
export type SourceVideo = z.infer<typeof SourceVideo>

// ============================================================================
// Transcript (PRD §9.3 `Project.transcript`)
// ============================================================================

export const Transcript = z.object({
  language: z.string(), // from whisper `result.language` (PRD §6.2 auto-detect)
  segments: z.array(TranscriptSegment),
  // Word stream is kept LOCAL (drives karaoke captions); never sent to the LLM
  // (PRD §16 token budget). Shape finalized at `contracts-v1` (Stage-4 smoke).
  words: z.array(WordTimestamp),
  speakers: z.array(Speaker).optional() // v0.4
})
export type Transcript = z.infer<typeof Transcript>

// ============================================================================
// Project (PRD §9.3 — the top-level .ocproj document)
// ============================================================================

export const Project = z.object({
  id: z.string(), // UUID
  name: z.string(),
  createdAt: z.number(), // epoch ms
  updatedAt: z.number(), // epoch ms
  sourceVideo: SourceVideo,
  transcript: Transcript,
  clips: z.array(Clip),
  settings: ProjectSettings,
  brandTemplate: BrandTemplate.optional(), // v0.5 (typed now, unused in MVP)
  exportHistory: z.array(ExportRecord)
})
export type Project = z.infer<typeof Project>

/** App-global `Settings` (PRD §11.2 Settings screen, plan `settingsStore`). */
export const AIProvider = z.enum(['openai', 'anthropic', 'google', 'ollama'])
export type AIProvider = z.infer<typeof AIProvider>

export const Settings = z.object({
  aiProvider: AIProvider,
  model: z.string(), // resolved current model id (PRD §4.3 — not hardcoded)
  baseUrl: z.string().optional(), // for Ollama / custom endpoints
  whisperModel: z.enum(['tiny', 'base', 'small', 'medium', 'turbo', 'large-v3']),
  language: z.string().optional(), // undefined => whisper auto-detect
  aspectRatio: AspectRatio,
  maxClips: z.number(),
  minDuration: z.number(),
  maxDuration: z.number(),
  forceCpu: z.boolean(), // GPU fallback override (PRD §14)
  telemetryOptIn: z.boolean() // opt-in only (PRD §12.3)
})
export type Settings = z.infer<typeof Settings>

// ============================================================================
// AI ClipSchema (PRD §7.1) — the LLM clip-detection structured output.
// strictObject => additionalProperties:false + all required (OpenAI strict
// json_schema / Anthropic zodOutputFormat). snake_case keys MATCH the prompt
// contract in PRD §7.1 verbatim.
// ============================================================================

export const ClipTypeEnum = z.enum([
  'hook',
  'emotional',
  'aha',
  'story',
  'quote',
  'controversy',
  'visual'
])
export type ClipTypeEnum = z.infer<typeof ClipTypeEnum>

/** One detected clip candidate (PRD §7.1 output object). */
export const DetectedClip = z.strictObject({
  start_time: z.number(), // absolute seconds from start of full video
  end_time: z.number(), // absolute seconds
  title: z.string(), // catchy title, < 60 chars (enforced in prompt)
  hook: z.string(), // one sentence: why this moment is engaging
  virality_score: z.number(), // 1-10
  clip_type: ClipTypeEnum,
  keywords: z.array(z.string()),
  suggested_caption: z.string(), // short social caption
  hashtags: z.array(z.string())
})
export type DetectedClip = z.infer<typeof DetectedClip>

/** Run-level analysis block (PRD §7.1). */
export const ClipAnalysis = z.strictObject({
  total_duration: z.number(), // seconds
  clips_found: z.number(),
  best_clip_index: z.number(),
  overall_virality_potential: z.enum(['high', 'medium', 'low'])
})
export type ClipAnalysis = z.infer<typeof ClipAnalysis>

/**
 * The AI viral-clip-detection output schema (PRD §7.1 / §10.3).
 * This is the single Zod schema adapted per provider:
 *   - OpenAI:    response_format json_schema { strict:true, schema }
 *   - Anthropic: output_config.format = zodOutputFormat(ClipSchema)
 *   - Ollama:    format = z.toJSONSchema(ClipSchema)
 */
export const ClipSchema = z.strictObject({
  clips: z.array(DetectedClip),
  analysis: ClipAnalysis
})
export type ClipSchema = z.infer<typeof ClipSchema>
