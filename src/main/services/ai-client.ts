/**
 * src/main/services/ai-client.ts — BYOK viral-clip detection (PRD §6.3, §7,
 * §10.3, §16; plan Part B). Owned by T-AI (plan E.3).
 *
 * ONE Zod schema is the source of truth — the FROZEN `ClipSchema` in
 * `@shared/schema`. It is adapted to three providers' structured-output modes:
 *   - OpenAI:    response_format json_schema { strict:true, schema } where
 *                schema = z.toJSONSchema(ClipSchema) (additionalProperties:false).
 *   - Anthropic: client.messages.parse({ output_config:{ format:
 *                zodOutputFormat(ClipSchema) } }) → parsed_output.
 *   - Ollama:    chat({ format: z.toJSONSchema(ClipSchema), stream:false }).
 *
 * The provider SDK call is isolated behind a thin `RawTransport` seam:
 * `(prompt) => Promise<{ rawText }>`. Everything downstream (repair ladder,
 * map-reduce, clamp) is PURE and unit-tested by injecting a fake transport — no
 * network ever runs in tests (PRD §18 "mock the LLM at the ai-client boundary").
 *
 * Repair ladder (PRD §16): structured mode → safeParse → ONE repair round-trip
 * echoing the Zod errors → tolerant brace/fence extraction → typed
 * {code:'INPUT_INVALID',retriable:true}. Then CLAMP in code: end>start, clamp to
 * [0,duration], drop overlaps, enforce min/max duration.
 *
 * Token budget (PRD §16): consume SEGMENT-level transcript only (word data stays
 * local). Window into ~8-12k-token chunks w/ ~10s overlap → map (candidates per
 * chunk, ABSOLUTE times) → reduce (dedupe overlaps, rank to maxClips). Cache by
 * (transcriptHash, promptVersion, model, style).
 */

import { z } from 'zod'
import { ClipSchema, type DetectedClip, type TranscriptSegment } from '@shared/schema'
import type { ClipStyle, AIProvider } from '@shared/schema'

// ============================================================================
// Prompt library (PRD §7.1–§7.3) — promptVersion participates in the cache key.
// ============================================================================

export const PROMPT_VERSION = 'viral-clip-v1'

export const SYSTEM_PROMPT = `You are ViralClipGPT, an expert video editor and viral content strategist with 10+ years of experience creating short-form content for TikTok, YouTube Shorts, and Instagram Reels.

Your task is to analyze a video transcript with timestamps and identify the most engaging moments that would perform well as viral short clips.

GUIDELINES FOR DETECTING VIRAL MOMENTS:
1. HOOKS: Strong opening statements, controversial opinions, or surprising facts in the first 3 seconds of a segment
2. EMOTIONAL PEAKS: High emotional intensity (anger, joy, sadness, excitement)
3. "AHA" MOMENTS: Insights, revelations, or counter-intuitive information
4. STORY CLIMAX: The peak of a narrative arc (problem -> tension -> resolution)
5. QUOTABLE QUOTES: Memorable one-liners or powerful statements
6. CONTROVERSY: Debates, disagreements, or challenging mainstream beliefs

AVOID:
- Filler words ("um", "uh", "like", "you know", "basically")
- Long pauses or dead air
- Repetitive explanations
- Topic transitions without a hook

CLIP REQUIREMENTS:
- A clear beginning, middle, and end; complete without full-video context
- Prioritize clips that START with a hook, not a setup

OUTPUT: Return ONLY a valid JSON object matching the provided schema. No markdown, no prose. All timestamps are absolute seconds from the start of the full video.`

/** PRD §7.3 — per-style steering appended to the user prompt. */
const STYLE_GUIDANCE: Record<ClipStyle, string> = {
  all: 'Find the strongest moments across any style.',
  funny: 'Prioritize humor, wit, unexpected punchlines, funny reactions, comedic timing.',
  educational:
    'Prioritize "did you know" facts, counter-intuitive insights, step-by-step explanations, actionable tips.',
  controversial:
    'Prioritize hot takes, "everyone is wrong about…", debates, challenging norms, bold predictions.',
  emotional:
    'Prioritize vulnerability, overcoming adversity, heartwarming moments, passionate rants, nostalgia.',
  motivational: 'Prioritize inspiring, high-energy, call-to-action moments that drive the viewer.',
  storytelling: 'Prioritize complete narrative arcs: setup, tension, and a satisfying resolution.'
}

export interface BuildUserPromptArgs {
  videoTitle: string
  durationSeconds: number
  clipStyle: ClipStyle
  numClips: number
  targetPlatform: 'tiktok' | 'youtube' | 'instagram' | 'all'
  minDuration: number
  maxDuration: number
  segments: TranscriptSegment[]
}

/** Render the segment-level transcript block (PRD §7.2 — absolute times). */
export function renderTranscript(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`).join('\n')
}

/** PRD §7.2 user prompt, parameterized for a chunk of segments. */
export function buildUserPrompt(args: BuildUserPromptArgs): string {
  return `Analyze the following video transcript and identify the best viral clip moments.

VIDEO METADATA:
- Title: ${args.videoTitle}
- Duration: ${args.durationSeconds} seconds
- Target Platform: ${args.targetPlatform}

TRANSCRIPT (segment-level, with absolute timestamps in seconds):
${renderTranscript(args.segments)}

CLIP STYLE PREFERENCE: ${args.clipStyle}
${STYLE_GUIDANCE[args.clipStyle]}

CLIP DURATION: each clip must be between ${args.minDuration} and ${args.maxDuration} seconds.
NUMBER OF CLIPS REQUESTED: ${args.numClips}

Return JSON per the schema. All timestamps are absolute seconds from the start of the full video.`
}

// ============================================================================
// The provider transport seam (the ONLY place a real SDK/network is touched).
// ============================================================================

export interface PromptPair {
  system: string
  user: string
}

/** A raw, provider-agnostic completion call. Returns the model's text output. */
export type RawTransport = (prompt: PromptPair) => Promise<{ rawText: string }>

// ============================================================================
// JSON Schema derivation (single source of truth = the frozen ClipSchema).
// ============================================================================

/**
 * Derive the JSON Schema for OpenAI strict json_schema + Ollama `format`.
 * Zod 4's `z.toJSONSchema` on the `z.strictObject`-based ClipSchema emits
 * `additionalProperties:false` with every property `required`.
 */
export function clipJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ClipSchema) as Record<string, unknown>
}

// ============================================================================
// Repair ladder (PRD §16) — pure, provider-agnostic.
// ============================================================================

/** Rung 4: strip ```json fences, else grab the outermost {...}. */
export function extractJsonCandidate(text: string): string {
  const trimmed = text.trim()
  // ```json … ``` or bare ``` … ```
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  if (fence) return fence[1].trim()
  // outermost {...}
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last !== -1 && last > first) {
    return trimmed.slice(first, last + 1)
  }
  return trimmed
}

export type ParseResult =
  | { ok: true; value: z.infer<typeof ClipSchema> }
  | { ok: false; issues: z.core.$ZodIssue[]; rawError: string }

/** Rung 2: tolerant-extract → JSON.parse → ClipSchema.safeParse. */
export function parseClipSchema(text: string): ParseResult {
  const candidate = extractJsonCandidate(text)
  let json: unknown
  try {
    json = JSON.parse(candidate)
  } catch (e) {
    return { ok: false, issues: [], rawError: e instanceof Error ? e.message : 'JSON parse error' }
  }
  const parsed = ClipSchema.safeParse(json)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues,
    rawError: z.prettifyError(parsed.error)
  }
}

export interface AiError {
  code: 'INPUT_INVALID'
  retriable: boolean
  message: string
}

export type LadderResult =
  | { ok: true; value: z.infer<typeof ClipSchema> }
  | { ok: false; error: AiError }

/** Build the rung-3 repair prompt that echoes the Zod errors back to the model. */
export function buildRepairPrompt(originalUser: string, rawError: string, rawText: string): string {
  return `${originalUser}

Your previous response was NOT valid for the required schema. Validation errors:
${rawError}

The invalid response was:
${rawText.slice(0, 4000)}

Return ONLY a corrected JSON object that is valid against the schema. No markdown, no prose.`
}

/**
 * Run the full repair ladder for ONE prompt against a transport:
 *   rung 2 safeParse → rung 3 ONE repair round-trip (echoing Zod errors) →
 *   rung 5 typed INPUT_INVALID. (Rung 1 structured-mode + rung 4 tolerant
 *   extraction are folded into `parseClipSchema`.)
 */
export async function runRepairLadder(
  transport: RawTransport,
  prompt: PromptPair
): Promise<LadderResult> {
  const first = await transport(prompt)
  const r1 = parseClipSchema(first.rawText)
  if (r1.ok) return r1

  // Rung 3: exactly ONE repair round-trip echoing the Zod errors.
  const repaired = await transport({
    system: prompt.system,
    user: buildRepairPrompt(prompt.user, r1.rawError, first.rawText)
  })
  const r2 = parseClipSchema(repaired.rawText)
  if (r2.ok) return r2

  // Rung 5: surface a typed, retriable error.
  return {
    ok: false,
    error: {
      code: 'INPUT_INVALID',
      retriable: true,
      message: `LLM output failed schema validation after one repair: ${r2.rawError || r1.rawError}`
    }
  }
}

// ============================================================================
// Clamp / overlap / min-max (PRD §16) — pure.
// ============================================================================

export interface ClampOptions {
  duration: number
  minDuration: number
  maxDuration: number
}

/** Minimal shape we clamp (accepts full DetectedClip or just times). */
type ClampInput = Pick<DetectedClip, 'start_time' | 'end_time'> & Partial<DetectedClip>

/**
 * In-code guardrails regardless of model: clamp to [0,duration], require
 * end>start, enforce min/max duration (truncate over-long to maxDuration), then
 * drop overlapping spans keeping the earlier-starting one.
 */
export function clampDetectedClips<T extends ClampInput>(clips: T[], opts: ClampOptions): T[] {
  const cleaned: T[] = []
  for (const c of clips) {
    const start = Math.max(0, Math.min(c.start_time, opts.duration))
    let end = Math.max(0, Math.min(c.end_time, opts.duration))
    if (end <= start) continue // drop inverted/zero-length
    // enforce max duration by truncating the end
    if (end - start > opts.maxDuration) end = start + opts.maxDuration
    if (end - start < opts.minDuration) continue // drop too-short
    cleaned.push({ ...c, start_time: start, end_time: end })
  }
  // drop overlaps: sort by start, keep the first, skip any that overlaps a kept one
  cleaned.sort((a, b) => a.start_time - b.start_time)
  const kept: T[] = []
  for (const c of cleaned) {
    const overlaps = kept.some((k) => c.start_time < k.end_time && c.end_time > k.start_time)
    if (!overlaps) kept.push(c)
  }
  return kept
}

// ============================================================================
// Token budget — chunking + map-reduce (PRD §16).
// ============================================================================

/** ~1 token per 4 characters (cheap heuristic, no tokenizer dependency). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface ChunkOptions {
  /** Soft token budget per chunk (~8-12k in production). */
  maxTokens: number
  /** Re-include trailing segments within this many seconds at the chunk seam. */
  overlapSeconds: number
}

export interface SegmentChunk {
  segments: TranscriptSegment[]
}

/**
 * Window segments into ~maxTokens chunks with ~overlapSeconds of overlap.
 * A single oversized segment forms its own chunk (never split mid-segment).
 * Absolute times are preserved (segment times are passed through unchanged).
 */
export function chunkSegments(segments: TranscriptSegment[], opts: ChunkOptions): SegmentChunk[] {
  if (segments.length === 0) return []
  const chunks: SegmentChunk[] = []
  let current: TranscriptSegment[] = []
  let tokens = 0

  const flush = (): void => {
    if (current.length > 0) chunks.push({ segments: current })
  }

  for (const seg of segments) {
    const segTokens = estimateTokens(seg.text)
    if (current.length > 0 && tokens + segTokens > opts.maxTokens) {
      flush()
      // start the next chunk with an overlap: trailing segments within
      // overlapSeconds of the boundary segment's end.
      const boundaryEnd = current[current.length - 1].end
      const overlap = current.filter((s) => s.end > boundaryEnd - opts.overlapSeconds)
      current = [...overlap]
      tokens = estimateTokens(current.map((s) => s.text).join(' '))
    }
    current.push(seg)
    tokens += segTokens
  }
  flush()
  return chunks
}

/** A stable, order-sensitive hash of segment text+times for the cache key. */
export function transcriptHash(segments: TranscriptSegment[]): string {
  let h = 0x811c9dc5
  const str = segments.map((s) => `${s.start}|${s.end}|${s.text}`).join('\n')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Reduce: dedupe overlapping candidates (keep higher score), rank, truncate. */
export function dedupeAndRank(candidates: DetectedClip[], maxClips: number): DetectedClip[] {
  // sort by score desc so the higher-scoring of an overlapping pair wins
  const byScore = [...candidates].sort((a, b) => b.virality_score - a.virality_score)
  const kept: DetectedClip[] = []
  for (const c of byScore) {
    const overlaps = kept.some((k) => c.start_time < k.end_time && c.end_time > k.start_time)
    if (!overlaps) kept.push(c)
  }
  return kept.slice(0, maxClips)
}

export interface MapReduceRequest {
  segments: TranscriptSegment[]
  system: string
  /** Build the per-chunk user prompt from that chunk's segments. */
  buildUserPrompt: (segments: TranscriptSegment[]) => string
  chunkOptions: ChunkOptions
  duration: number
  minDuration: number
  maxDuration: number
  maxClips: number
  /** Optional result cache (PRD §16): keyed by `cacheKey`. */
  cache?: Map<string, unknown>
  cacheKey?: string
}

/**
 * The full pipeline: chunk → map (one repair-laddered call per chunk) →
 * reduce (dedupe/rank to maxClips) → clamp. Caches the final ClipSchema by
 * `cacheKey` when a cache is provided.
 */
export async function mapReduceGenerate(
  transport: RawTransport,
  req: MapReduceRequest
): Promise<LadderResult> {
  if (req.cache && req.cacheKey && req.cache.has(req.cacheKey)) {
    return { ok: true, value: req.cache.get(req.cacheKey) as z.infer<typeof ClipSchema> }
  }

  const chunks = chunkSegments(req.segments, req.chunkOptions)
  const all: DetectedClip[] = []
  let lastError: AiError | null = null

  for (const chunk of chunks) {
    const result = await runRepairLadder(transport, {
      system: req.system,
      user: req.buildUserPrompt(chunk.segments)
    })
    if (result.ok) {
      all.push(...result.value.clips)
    } else {
      lastError = result.error
    }
  }

  // If every chunk failed, surface the typed error (never a silent empty set).
  if (all.length === 0 && lastError) {
    return { ok: false, error: lastError }
  }

  const clamped = clampDetectedClips(all, {
    duration: req.duration,
    minDuration: req.minDuration,
    maxDuration: req.maxDuration
  })
  const ranked = dedupeAndRank(clamped, req.maxClips)

  const value: z.infer<typeof ClipSchema> = {
    clips: ranked,
    analysis: {
      total_duration: req.duration,
      clips_found: ranked.length,
      best_clip_index: ranked.length > 0 ? 0 : 0,
      overall_virality_potential: viralityBand(ranked)
    }
  }

  if (req.cache && req.cacheKey) req.cache.set(req.cacheKey, value)
  return { ok: true, value }
}

function viralityBand(clips: DetectedClip[]): 'high' | 'medium' | 'low' {
  if (clips.length === 0) return 'low'
  const top = Math.max(...clips.map((c) => c.virality_score))
  if (top >= 8) return 'high'
  if (top >= 5) return 'medium'
  return 'low'
}

// ============================================================================
// Provider adapters — the three concrete `RawTransport`s (PRD §10.3).
// Each takes an already-constructed (injectable) SDK client so unit tests pass
// a fake and no network runs.
// ============================================================================

/** Minimal structural slice of the OpenAI client we use. */
export interface OpenAILike {
  chat: {
    completions: {
      create(body: unknown): Promise<{
        choices: Array<{ message: { content: string | null } }>
      }>
    }
  }
}

export function buildOpenAITransport(client: OpenAILike, model: string): RawTransport {
  const schema = clipJsonSchema()
  return async ({ system, user }) => {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'clips', strict: true, schema }
      }
    })
    return { rawText: res.choices[0]?.message?.content ?? '' }
  }
}

/** Minimal structural slice of the Anthropic client we use. */
export interface AnthropicLike {
  messages: {
    parse(body: unknown): Promise<{
      parsed_output?: unknown
      content?: Array<{ type: string; text?: string }>
    }>
  }
}

/**
 * Anthropic structured output via `messages.parse` + `zodOutputFormat(ClipSchema)`.
 * `zodOutputFormat` is imported lazily so the module stays importable in unit
 * tests that never construct a real client (and to avoid a hard dependency on
 * the SDK's internal parser types at module-eval time).
 */
export function buildAnthropicTransport(
  client: AnthropicLike,
  model: string,
  zodOutputFormatFn?: (schema: typeof ClipSchema) => unknown
): RawTransport {
  return async ({ system, user }) => {
    const format = zodOutputFormatFn
      ? zodOutputFormatFn(ClipSchema)
      : await defaultZodOutputFormat()
    const res = await client.messages.parse({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format }
    })
    if (res.parsed_output != null) return { rawText: JSON.stringify(res.parsed_output) }
    const text = (res.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    return { rawText: text }
  }
}

async function defaultZodOutputFormat(): Promise<unknown> {
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod')
  return zodOutputFormat(ClipSchema)
}

/** Minimal structural slice of the Ollama client we use. */
export interface OllamaLike {
  chat(body: unknown): Promise<{ message: { content: string } }>
}

export function buildOllamaTransport(client: OllamaLike, model: string): RawTransport {
  const format = clipJsonSchema()
  return async ({ system, user }) => {
    const res = await client.chat({
      model,
      stream: false,
      format,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
    return { rawText: res.message?.content ?? '' }
  }
}

// ============================================================================
// Transport factory — construct the right provider transport from a provider
// id + model + decrypted key (the key is used MAIN-SIDE only; PRD §12.2).
// ============================================================================

/** OpenRouter (Part H) — OpenAI-compatible gateway base URL + attribution headers. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_APP_URL = 'https://openclip.app'
export const OPENROUTER_APP_TITLE = 'OpenClip'

export interface TransportFactoryArgs {
  provider: AIProvider
  model: string
  apiKey: string | null
  baseUrl?: string
}

/**
 * Build the concrete provider transport. Lazily imports each SDK so importing
 * this module (e.g. from a renderer-adjacent test) never eagerly loads all
 * three SDKs. Google is not wired in the MVP (PRD §4.3 "later").
 */
export async function createTransport(args: TransportFactoryArgs): Promise<RawTransport> {
  switch (args.provider) {
    case 'openai': {
      const { default: OpenAI } = await import('openai')
      const client = new OpenAI({ apiKey: args.apiKey ?? '', baseURL: args.baseUrl })
      return buildOpenAITransport(client as unknown as OpenAILike, args.model)
    }
    case 'openrouter': {
      // OpenRouter is OpenAI-API-compatible (Part H): reuse the OpenAI transport
      // (json_schema strict) with the OpenRouter base URL + the optional
      // attribution headers. The repair ladder covers any model whose structured
      // output isn't perfect; the picker only lists structured-capable models.
      const { default: OpenAI } = await import('openai')
      const client = new OpenAI({
        apiKey: args.apiKey ?? '',
        baseURL: args.baseUrl ?? OPENROUTER_BASE_URL,
        defaultHeaders: { 'HTTP-Referer': OPENROUTER_APP_URL, 'X-Title': OPENROUTER_APP_TITLE }
      })
      return buildOpenAITransport(client as unknown as OpenAILike, args.model)
    }
    case 'anthropic': {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const client = new Anthropic({ apiKey: args.apiKey ?? '' })
      return buildAnthropicTransport(client as unknown as AnthropicLike, args.model)
    }
    case 'ollama': {
      const { Ollama } = await import('ollama')
      const client = new Ollama({ host: args.baseUrl })
      return buildOllamaTransport(client as unknown as OllamaLike, args.model)
    }
    case 'google':
      throw new Error('Google provider is not wired in the MVP (PRD §4.3)')
    default: {
      const exhaustive: never = args.provider
      throw new Error(`unknown provider ${String(exhaustive)}`)
    }
  }
}

// ============================================================================
// Top-level generate — used by ipc/ai.ts. Chunks segments, map-reduces, clamps,
// and returns a validated ClipSchema (or a typed error).
// ============================================================================

export interface GenerateClipsArgs {
  transport: RawTransport
  segments: TranscriptSegment[]
  videoTitle: string
  durationSeconds: number
  clipStyle: ClipStyle
  numClips: number
  targetPlatform: 'tiktok' | 'youtube' | 'instagram' | 'all'
  minDuration: number
  maxDuration: number
  model: string
  cache?: Map<string, unknown>
}

/** Production cache key (PRD §16): transcriptHash, promptVersion, model, style. */
export function clipCacheKey(
  segments: TranscriptSegment[],
  model: string,
  style: ClipStyle
): string {
  return `${transcriptHash(segments)}|${PROMPT_VERSION}|${model}|${style}`
}

export function generateClips(args: GenerateClipsArgs): Promise<LadderResult> {
  return mapReduceGenerate(args.transport, {
    segments: args.segments,
    system: SYSTEM_PROMPT,
    buildUserPrompt: (chunkSegs) =>
      buildUserPrompt({
        videoTitle: args.videoTitle,
        durationSeconds: args.durationSeconds,
        clipStyle: args.clipStyle,
        numClips: args.numClips,
        targetPlatform: args.targetPlatform,
        minDuration: args.minDuration,
        maxDuration: args.maxDuration,
        segments: chunkSegs
      }),
    chunkOptions: { maxTokens: 10_000, overlapSeconds: 10 },
    duration: args.durationSeconds,
    minDuration: args.minDuration,
    maxDuration: args.maxDuration,
    maxClips: args.numClips,
    cache: args.cache,
    cacheKey: clipCacheKey(args.segments, args.model, args.clipStyle)
  })
}
