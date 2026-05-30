/**
 * src/main/services/ai-emoji.ts — PURE BYOK-AI emoji suggestion (Part K, emoji).
 *
 * Given the distinct caption words, ask the model for a per-word emoji map. The
 * result is consumed by `annotateWords`/`lookupEmoji` (caption-emphasis) when a
 * clip's caption style has `autoEmoji: 'ai'`. Provider-agnostic: it runs through
 * the same `RawTransport` seam as clip detection, so tests inject a fake
 * transport and NO network runs. Map keys are normalized with the SAME
 * `normalizeWord` the engine uses to look them up, so an entry always matches.
 *
 * Best-effort by design: an unparseable model response yields `{}` (no emoji)
 * rather than throwing — emoji are a cosmetic enhancement and must NEVER block an
 * export.
 */

import { z } from 'zod'
import { extractJsonCandidate, type PromptPair, type RawTransport } from './ai-client'
import { normalizeWord } from '@shared/caption-emphasis'

const EMOJI_MAP_SCHEMA = z.record(z.string(), z.string())

const SYSTEM_PROMPT = `You add a SINGLE relevant emoji to words for short-form video captions.
Rules:
- Return ONLY a JSON object mapping a lowercase word to ONE emoji. No prose, no markdown.
- Include a word ONLY when an emoji genuinely reinforces it; SKIP filler/function words.
- Prefer widely-supported, monochrome-friendly emoji. One emoji per word, no ZWJ sequences.
Example: {"money":"💰","fire":"🔥","idea":"💡"}`

export interface SuggestEmojiOptions {
  /** Defensive cap on entries kept from the model (default 300). */
  maxEntries?: number
}

/** Build the prompt for emoji suggestion over a distinct word list. */
export function buildEmojiPrompt(words: string[]): PromptPair {
  const distinct = Array.from(new Set(words.map((w) => w.trim()).filter(Boolean)))
  return {
    system: SYSTEM_PROMPT,
    user: `Suggest emoji for these caption words (JSON object only):\n${distinct.join(', ')}`
  }
}

/** Parse + normalize a model emoji map; tolerant of fences/prose (rung-4 extract). */
export function parseEmojiMap(rawText: string, maxEntries = 300): Record<string, string> {
  let json: unknown
  try {
    json = JSON.parse(extractJsonCandidate(rawText))
  } catch {
    return {}
  }
  const parsed = EMOJI_MAP_SCHEMA.safeParse(json)
  if (!parsed.success) return {}
  const out: Record<string, string> = {}
  for (const [word, emoji] of Object.entries(parsed.data)) {
    if (Object.keys(out).length >= maxEntries) break
    const key = normalizeWord(word)
    const glyph = emoji.trim()
    if (!key || !glyph) continue
    if (!(key in out)) out[key] = glyph
  }
  return out
}

/**
 * Suggest a normalized word→emoji map for the given caption words via the BYOK
 * transport. Returns `{}` (no emoji) when there are no usable words or the model
 * output can't be parsed — emoji are cosmetic and must never block the export.
 */
export async function suggestEmoji(
  transport: RawTransport,
  words: string[],
  opts: SuggestEmojiOptions = {}
): Promise<Record<string, string>> {
  const distinct = Array.from(new Set(words.map((w) => normalizeWord(w)).filter(Boolean)))
  if (distinct.length === 0) return {}
  const { rawText } = await transport(buildEmojiPrompt(words))
  return parseEmojiMap(rawText, opts.maxEntries)
}
