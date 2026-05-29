/**
 * src/main/services/whisper-parse.ts — pure whisper-cli JSON → contract mapper
 * (TRUNK INFRA, frozen at `contracts-v1`).
 *
 * The Stage-4 media de-risk smoke ran the REAL bundled `whisper-cli`
 * (whisper.cpp 1.8.4) on Metal with `-ml 1 --split-on-word --output-json-full
 * --print-confidence` and captured its on-disk JSON shape (the canonical fixture
 * is `tests/fixtures/whisper/real-whisper-cli-tiny-ml1-sow.json`). This module is
 * the single, pure, unit-tested transform from that JSON into the frozen
 * `WordTimestamp[]` / `TranscriptSegment[]` contract shapes (PRD §9.3 / §6.2).
 *
 * It is intentionally trunk-owned (not T-Media) because the contract
 * finalization is *proven by* this transform — T-Media builds the spawn/stream
 * RUNNER (`services/whisper.ts` + `services/jobs/transcribe-runner.ts`) on top of
 * it. Pure, dependency-free (no Electron, no child_process) → fully testable.
 *
 * REAL whisper-cli JSON (the parts we consume):
 *   { result: { language: "en" },
 *     transcription: [ {
 *       offsets: { from: <ms int>, to: <ms int> },   // MILLISECONDS, absolute
 *       text: " word",                               // leading space, may be ""
 *       tokens: [ { text: "...", p: <0..1>, ... } ]  // `[_BEG_]`/`[_TT_*]` = special
 *     }, … ] }
 */

import type { TranscriptSegment, WordTimestamp } from '@shared/schema'

// ============================================================================
// Minimal structural typing of the whisper-cli JSON we actually read
// ============================================================================

interface WhisperToken {
  text: string
  p?: number
}

interface WhisperEntry {
  offsets: { from: number; to: number } // milliseconds
  text: string
  tokens?: WhisperToken[]
}

export interface WhisperJson {
  result?: { language?: string }
  transcription: WhisperEntry[]
}

export interface ParsedTranscript {
  language: string
  words: WordTimestamp[]
  segments: TranscriptSegment[]
}

// ============================================================================
// Helpers (pure)
// ============================================================================

/** whisper special tokens look like `[_BEG_]`, `[_TT_232]`, `[_EOT_]`, … */
function isSpecialToken(text: string): boolean {
  return /^\[_.*_?\]$/.test(text.trim()) || /^\[_/.test(text.trim())
}

/** ms → seconds, rounded to ms precision to avoid float noise. */
function msToSec(ms: number): number {
  return Math.round(ms) / 1000
}

/**
 * Confidence for one whisper entry = mean of its NON-special token `p` values.
 * whisper has no first-class word confidence; `p` is the token probability
 * (0..1). Returns 0 when no probabilities are present.
 */
function entryConfidence(entry: WhisperEntry): number {
  const ps = (entry.tokens ?? [])
    .filter((t) => !isSpecialToken(t.text))
    .map((t) => t.p)
    .filter((p): p is number => typeof p === 'number')
  if (ps.length === 0) return 0
  const sum = ps.reduce((a, b) => a + b, 0)
  return sum / ps.length
}

/** A word ends a sentence when its trimmed text ends in `.`, `!`, `?`, or `…`. */
function endsSentence(word: string): boolean {
  return /[.!?…]["')\]]?$/.test(word.trim())
}

// ============================================================================
// Word extraction
// ============================================================================

/**
 * Map whisper `transcription[]` entries to `WordTimestamp[]`.
 * Drops blank/empty-text entries (the leading `[_BEG_]` and trailing `[_TT_*]`
 * special-token entries whose `text` is empty/whitespace). Times → seconds.
 */
export function extractWords(json: WhisperJson): WordTimestamp[] {
  const words: WordTimestamp[] = []
  for (const entry of json.transcription ?? []) {
    const word = entry.text.trim()
    if (word.length === 0) continue // skip [_BEG_]/[_TT_*]-only blank entries
    words.push({
      word,
      start: msToSec(entry.offsets.from),
      end: msToSec(entry.offsets.to),
      confidence: entryConfidence(entry)
    })
  }
  return words
}

// ============================================================================
// Segment (sentence) grouping
// ============================================================================

/**
 * Group a word stream into sentence-level `TranscriptSegment[]` on terminal
 * punctuation. The LLM only ever sees segment-level text (PRD §16 token budget).
 * Each segment's `confidence` is the mean of its words' confidences; a trailing
 * partial sentence (no terminal punctuation) is flushed as its own segment.
 */
export function groupSegments(words: WordTimestamp[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  let bucket: WordTimestamp[] = []

  const flush = (): void => {
    if (bucket.length === 0) return
    const start = bucket[0].start
    const end = bucket[bucket.length - 1].end
    const text = bucket
      .map((w) => w.word)
      .join(' ')
      .replace(/\s+([.!?,…])/g, '$1') // tidy "word ." → "word."
      .trim()
    const confidence = bucket.reduce((a, w) => a + w.confidence, 0) / bucket.length
    segments.push({ id: `seg-${segments.length}`, start, end, text, confidence })
    bucket = []
  }

  for (const w of words) {
    bucket.push(w)
    if (endsSentence(w.word)) flush()
  }
  flush() // trailing partial sentence

  return segments
}

// ============================================================================
// Top-level
// ============================================================================

/**
 * Parse the full whisper-cli `--output-json-full` document into the frozen
 * contract shapes. `language` comes from `result.language` (PRD §6.2
 * auto-detect), defaulting to `"en"` if whisper omits it.
 */
export function parseWhisperJson(json: WhisperJson): ParsedTranscript {
  const words = extractWords(json)
  const segments = groupSegments(words)
  return {
    language: json.result?.language ?? 'en',
    words,
    segments
  }
}
