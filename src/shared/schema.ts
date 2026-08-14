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
 * Anthropic `zodOutputFormat` demand. Internal persistence schemas use
 * `z.looseObject` so they are TRULY forward-compatible: unknown keys from a NEWER
 * app version survive a load→re-save round-trip instead of being silently STRIPPED
 * (audit fix openclip-9uq — plain `z.object` strips unknown keys in Zod 4, which
 * meant an older build opening a newer `.ocproj` permanently dropped every newer
 * field on the next autosave). The AI strictObject schemas stay strict.
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
export const WordTimestamp = z.looseObject({
  word: z.string(), // trimmed entry text, e.g. "Hello" (no leading space)
  start: z.number(), // seconds, absolute (offsets.from / 1000)
  end: z.number(), // seconds, absolute (offsets.to / 1000)
  confidence: z.number() // 0..1, mean of the word's token `p` values
})
export type WordTimestamp = z.infer<typeof WordTimestamp>

/** PRD §9.3 `TranscriptSegment`. A sentence grouped from the word stream. */
export const TranscriptSegment = z.looseObject({
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
export const CaptionStyle = z.looseObject({
  fontFamily: z.string(),
  fontSize: z.number(),
  fontColor: z.string(), // hex / ASS color
  backgroundColor: z.string(),
  position: z.enum(['top', 'middle', 'bottom']),
  animation: z.enum(['none', 'pop', 'fade', 'typewriter']),
  highlightCurrentWord: z.boolean(),
  emojiEnabled: z.boolean(),
  // Part I — caption-preset styling (Hormozi/MrBeast/TikTok/…). All OPTIONAL so
  // pre-Part-I `.ocproj` still validate and ass-captions reproduces today's
  // output byte-for-byte when absent (defaults: yellow highlight, black outline
  // width 3, no shadow).
  highlightColor: z.string().optional(), // karaoke current-word fill (PrimaryColour)
  strokeColor: z.string().optional(), // text outline (OutlineColour)
  strokeWidth: z.number().optional(), // outline thickness (ASS Outline)
  shadow: z.boolean().optional(), // drop shadow on/off (ASS Shadow)
  // Part K — caption template gallery + auto-emoji + keyword highlight. ALL
  // OPTIONAL so pre-Part-K `.ocproj` still validate AND ass-captions reproduces
  // today's `.ass` output BYTE-FOR-BYTE when absent (no keyword recolor/scale, no
  // per-word animation, no emoji, default 7 words/line — see ass-captions.ts).
  keywordColor: z.string().optional(), // distinct fill for emphasized (keyword) words
  keywordScale: z.number().optional(), // % scale applied to keyword words (absent ⇒ none)
  keywordBold: z.boolean().optional(), // embolden keyword words
  perWordAnimation: z.enum(['none', 'bounce', 'pop']).optional(), // inline per-word reveal anim
  autoEmoji: z.enum(['off', 'local', 'ai']).optional(), // emoji source (local dict / BYOK AI)
  emojiPosition: z.enum(['after', 'before']).optional(), // emoji placement vs the word
  wordsPerLine: z.number().optional() // caption line length (absent ⇒ buildAss default 7)
})
export type CaptionStyle = z.infer<typeof CaptionStyle>

/**
 * A single rendered caption cue (PRD §9.3 "Caption … as in v1, unchanged").
 * Word entries drive the karaoke `\k` centisecond fill (PRD §6.4).
 */
export const Caption = z.looseObject({
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

/**
 * `rejected` is HIDDEN, not deleted (FEAT-k28j7h). Reject used to splice the clip
 * out of the store, and autosave persisted that ~800ms later — a single misclick
 * destroyed an AI result permanently, with no confirmation and no undo anywhere
 * in the app. Adding a status keeps the clip on disk and makes the action
 * reversible. Persistence schemas are `looseObject`, so a project written by an
 * older build (which cannot produce this value) still loads unchanged.
 */
export const ClipStatus = z.enum(['suggested', 'approved', 'edited', 'exported', 'rejected'])
export type ClipStatus = z.infer<typeof ClipStatus>

/**
 * Persisted 4-D virality breakdown on a Clip (Part I — supoclip-style scoring).
 * Optional so pre-Part-I `.ocproj` documents still validate (absent ⇒ only the
 * 1-10 headline `viralityScore` is shown). Each sub-score is 0-25; `total` 0-100.
 */
export const ClipVirality = z.looseObject({
  hook: z.number(),
  engagement: z.number(),
  value: z.number(),
  shareability: z.number(),
  total: z.number()
})
export type ClipVirality = z.infer<typeof ClipVirality>

/** PRD §9.3 `Clip`. */
export const Clip = z.looseObject({
  id: z.string(),
  startTime: z.number(), // seconds, absolute (AI-suggested span start)
  endTime: z.number(), // seconds, absolute (AI-suggested span end)
  title: z.string(),
  hook: z.string(),
  viralityScore: z.number(), // 1-10 headline (derived from virality.total/10)
  clipType: z.string(),
  keywords: z.array(z.string()),
  status: ClipStatus,
  editedStart: z.number().optional(), // timeline trim (overrides startTime on export)
  editedEnd: z.number().optional(), // timeline trim (overrides endTime on export)
  captions: z.array(Caption).optional(),
  thumbnailPath: z.string().optional(),
  // Part I — optional 4-D breakdown + opening-hook type (absent on old projects).
  virality: ClipVirality.optional(),
  hookType: z.string().optional(),
  // AI-suggested social post metadata carried from DetectedClip (audit fix
  // openclip-5cd): the model produces these per clip, so persist them instead of
  // discarding — a social caption + hashtags for the user when posting the clip.
  // Optional ⇒ absent on old projects and on clips created before detection.
  suggestedCaption: z.string().optional(),
  hashtags: z.array(z.string()).optional()
})
export type Clip = z.infer<typeof Clip>

// ============================================================================
// Speaker (PRD §9.3, v0.4 — typed now, unused in MVP)
// ============================================================================

export const Speaker = z.looseObject({
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
export const ProjectSettings = z.looseObject({
  targetPlatform: TargetPlatform,
  aspectRatio: AspectRatio,
  clipStyle: ClipStyle,
  maxClips: z.number(),
  minDuration: z.number(), // default 15
  maxDuration: z.number(), // default 90
  // Part K — the selected caption template id (captionPresets.ts). Optional so
  // pre-Part-K `.ocproj` validate; absent ⇒ the app-default caption style.
  captionTemplateId: z.string().optional(),
  // Part K (emoji) — the auto-emoji source the user picked in ExportPanel
  // ('off' default / 'local' built-in dict / 'ai' BYOK suggestions). Persisted
  // here so the WYSIWYG preview and the export agree. Optional ⇒ pre-Part-K
  // `.ocproj` validate (absent ⇒ no emoji).
  autoEmoji: z.enum(['off', 'local', 'ai']).optional(),
  /**
   * How a source that does not match `aspectRatio` is fitted (FEAT-bd87vz):
   * `fill` centre-crops, `letterbox` pads with black bars, `blur` pads with a
   * blurred copy of the frame. Optional so pre-existing `.ocproj` validate;
   * absent ⇒ `fill`, the historical behaviour.
   */
  fitMode: z.enum(['fill', 'letterbox', 'blur']).optional()
})
export type ProjectSettings = z.infer<typeof ProjectSettings>

// ============================================================================
// Brand template (PRD §6.8 / §9.3, v0.5 — typed now, unused in MVP)
// ============================================================================

export const BrandTemplate = z.looseObject({
  id: z.string(),
  name: z.string(),
  logoPath: z.string().optional(),
  brandColors: z.array(z.string()).optional(),
  fontFamily: z.string().optional(),
  introPath: z.string().optional(),
  outroPath: z.string().optional(),
  // Part K (brand kit) — logo overlay placement + a brand-defined base caption
  // style. All OPTIONAL; brand kit was dormant so nothing depends on these.
  logoPosition: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
  logoScale: z.number().optional(), // logo width as a fraction of output width (default 0.18)
  logoMargin: z.number().optional(), // inset px at the 1080-wide canvas (default 48)
  captionStyle: CaptionStyle.optional() // brand base caption style (merged over the preset)
})
export type BrandTemplate = z.infer<typeof BrandTemplate>

// ============================================================================
// Export history (PRD §9.3 `ExportRecord … as in v1, unchanged`)
// ============================================================================

export const ExportRecord = z.looseObject({
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

export const VideoResolution = z.looseObject({
  width: z.number(),
  height: z.number()
})
export type VideoResolution = z.infer<typeof VideoResolution>

export const SourceVideo = z.looseObject({
  path: z.string(),
  duration: z.number(), // seconds
  resolution: VideoResolution,
  fps: z.number(),
  format: z.string(),
  // True when OpenClip downloaded/owns this file (URL imports → it lives under
  // <userData>/media/<projectId>/ and is deleted with the project, Part H). A
  // file import sets this false/absent — the user's original is NEVER touched.
  // Optional so pre-Part-H .ocproj documents still validate (absent ⇒ not owned).
  appOwned: z.boolean().optional()
})
export type SourceVideo = z.infer<typeof SourceVideo>

// ============================================================================
// Transcript (PRD §9.3 `Project.transcript`)
// ============================================================================

export const Transcript = z.looseObject({
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

export const Project = z.looseObject({
  id: z.string(), // UUID
  name: z.string(),
  createdAt: z.number(), // epoch ms
  updatedAt: z.number(), // epoch ms
  sourceVideo: SourceVideo,
  transcript: Transcript,
  clips: z.array(Clip),
  settings: ProjectSettings,
  brandTemplate: BrandTemplate.optional(), // v0.5 (typed now, unused in MVP)
  // Part K (brand kit) — id of the active APP-LEVEL brand (brands live in the
  // brand library, not inlined here). Optional ⇒ pre-Part-K `.ocproj` validate.
  activeBrandId: z.string().optional(),
  exportHistory: z.array(ExportRecord)
})
export type Project = z.infer<typeof Project>

/** App-global `Settings` (PRD §11.2 Settings screen, plan `settingsStore`). */
export const AIProvider = z.enum(['openai', 'anthropic', 'google', 'ollama', 'openrouter'])
export type AIProvider = z.infer<typeof AIProvider>

export const Settings = z.looseObject({
  aiProvider: AIProvider,
  model: z.string(), // resolved current model id (PRD §4.3 — not hardcoded)
  baseUrl: z.string().optional(), // for Ollama / custom endpoints
  // Part K (emoji) — an INDEPENDENT provider + model for AI emoji suggestion
  // (ENHANCE_CAPTIONS, mode:'emoji'). Both OPTIONAL: absent ⇒ fall back to
  // `aiProvider`/`model`. The key for `emojiProvider` lives in the same
  // per-provider keyVault, so no extra secret plumbing is needed.
  emojiProvider: AIProvider.optional(),
  emojiModel: z.string().optional(),
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

/**
 * Opening-hook taxonomy (Part I — supoclip). How the clip OPENS (orthogonal to
 * `clip_type`, which is the content category).
 */
export const HookType = z.enum(['question', 'statement', 'statistic', 'story', 'contrast', 'none'])
export type HookType = z.infer<typeof HookType>

/**
 * 4-dimensional virality breakdown (Part I — adopted from supoclip's rubric).
 * Plain `z.number()` (NO min/max/int) deliberately — the AI-facing schema must
 * stay within OpenAI strict json_schema's supported keyword subset (same reason
 * `virality_score` is unconstrained); the prompt states the 0-25 bands and
 * `reconcileVirality` (ai-client) clamps + recomputes `total_score` in code.
 */
export const ViralityBreakdown = z.strictObject({
  hook_score: z.number(), // 0-25 — opening hook strength
  engagement_score: z.number(), // 0-25 — entertainment/emotional pull
  value_score: z.number(), // 0-25 — insight/information value
  shareability_score: z.number(), // 0-25 — "I need to send this" factor
  total_score: z.number(), // 0-100 — sum of the four sub-scores
  hook_type: HookType
})
export type ViralityBreakdown = z.infer<typeof ViralityBreakdown>

/** One detected clip candidate (PRD §7.1 output object). */
export const DetectedClip = z.strictObject({
  start_time: z.number(), // absolute seconds from start of full video
  end_time: z.number(), // absolute seconds
  title: z.string(), // catchy title, < 60 chars (enforced in prompt)
  hook: z.string(), // one sentence: why this moment is engaging
  virality_score: z.number(), // 1-10 headline (derived from virality.total_score/10)
  virality: ViralityBreakdown, // Part I — the 4-D breakdown + hook type
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

// ============================================================================
// AI title + caption generation outputs (PRD §7.4 / §7.5) — audit fix openclip-xgk.
// These were plain TS interfaces in channels.ts with no Zod schema, so (unlike
// ClipSchema) the title/caption generators had no strict-json source for
// z.toJSONSchema / zodOutputFormat, no safeParse/repair path, and no contract fixture.
// Modeled as z.strictObject (→ additionalProperties:false, all-required) exactly like
// ClipSchema so the same strict structured-output adapter can drive them when §7.4/§7.5
// are wired; the channel result types are inferred from these.
// ============================================================================

/** One AI-suggested title option (PRD §7.4). */
export const TitleOptionSchema = z.strictObject({
  title: z.string(),
  hook: z.string(),
  psychology: z.string() // why this title hooks (the angle/principle)
})
export type TitleOption = z.infer<typeof TitleOptionSchema>

export const GenerateTitlesResultSchema = z.strictObject({
  options: z.array(TitleOptionSchema)
})
export type GenerateTitlesResult = z.infer<typeof GenerateTitlesResultSchema>

/** One rewritten caption segment (PRD §7.5, rewrite mode). */
export const EnhancedCaptionSchema = z.strictObject({
  start_time: z.number(),
  end_time: z.number(),
  text: z.string()
})
export type EnhancedCaption = z.infer<typeof EnhancedCaptionSchema>

export const EnhanceCaptionsResultSchema = z.strictObject({
  enhanced_captions: z.array(EnhancedCaptionSchema),
  // Part K (emoji mode): normalized word → emoji. Absent on the rewrite path. A dynamic
  // dictionary, so it relaxes additionalProperties for ITS values only.
  emoji_map: z.record(z.string(), z.string()).optional()
})
export type EnhanceCaptionsResult = z.infer<typeof EnhanceCaptionsResultSchema>
