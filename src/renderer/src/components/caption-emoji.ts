/**
 * caption-emoji — PURE, bridge-injected helper to fetch the BYOK-AI emoji map for
 * a clip's captions (Part K / openclip-bfs). Used by ExportPanel + batch-export
 * when the caption style's `autoEmoji === 'ai'`. No React / no store, so it is
 * unit-testable against the mock bridge.
 *
 * The emoji AI provider/model is INDEPENDENT of clip detection: it resolves
 * `settings.emojiProvider/emojiModel` and falls back to the clip `aiProvider/model`
 * when unset. The map is cosmetic — any failure yields `undefined` (no emoji),
 * never an export-blocking error.
 */

import type { Clip, Settings, WordTimestamp } from '@shared/schema'
import { resolveBounds } from '@shared/clip-bounds'
import type { OpenClipBridge } from './export-run'

/** Distinct caption words within a clip's resolved span (the emoji-prompt input). */
export function clipCaptionWords(words: WordTimestamp[], clip: Clip): string[] {
  const { start, end } = resolveBounds(clip)
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of words) {
    if (w.start < start || w.start > end) continue
    const t = w.word.trim()
    const key = t.toLowerCase()
    if (!t || seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * Fetch the AI emoji map for a clip when `autoEmoji === 'ai'`. Returns `undefined`
 * for non-'ai' modes, when the clip has no caption words, or on any bridge error
 * (cosmetic — the export proceeds with no emoji).
 */
export async function fetchAiEmojiMap(args: {
  bridge: Pick<OpenClipBridge, 'ai'>
  settings: Pick<Settings, 'aiProvider' | 'model' | 'emojiProvider' | 'emojiModel'>
  words: WordTimestamp[]
  clip: Clip
  autoEmoji: 'off' | 'local' | 'ai' | undefined
}): Promise<Record<string, string> | undefined> {
  if (args.autoEmoji !== 'ai') return undefined
  const words = clipCaptionWords(args.words, args.clip)
  if (words.length === 0) return undefined
  try {
    const res = await args.bridge.ai.enhanceCaptions({
      provider: args.settings.emojiProvider ?? args.settings.aiProvider,
      model: args.settings.emojiModel ?? args.settings.model,
      transcript: '',
      mode: 'emoji',
      words
    })
    return res.emoji_map ?? {}
  } catch {
    return {}
  }
}
