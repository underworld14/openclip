/**
 * src/shared/caption-emphasis.ts — PURE keyword-emphasis + auto-emoji annotation
 * (Part K, Step 1).
 *
 * A single transformation over the (scoped, rebased) word stream that BOTH the
 * `.ass` burn (`buildKaraokeLine`) and the DOM preview consume — so emphasized
 * words and emoji render identically in the preview and the export. Annotation
 * is purely additive: with no `keywords` and `autoEmoji` off it returns words
 * unchanged (no `isKeyword`, no `emoji`) ⇒ the burn output is byte-for-byte the
 * pre-Part-K `.ass` (golden tests stay green).
 *
 * AUTO-EMOJI is local-first: a deterministic keyword→emoji dictionary by default;
 * an opt-in BYOK-AI map (`aiEmojiMap`, produced by `ai-emoji.suggestEmoji` and
 * wired through the ENHANCE_CAPTIONS IPC in Step 2) overrides the local lookup.
 * NOTE: libass (the FFmpeg build) renders only MONOCHROME emoji glyphs, so the
 * burn uses a bundled monochrome emoji font (Step 2) while the DOM preview shows
 * full-color OS emoji — a documented preview/burn divergence.
 */

import type { RebasedWord } from './caption-layout'

/** A word annotated for emphasis/emoji. Extra fields are OPTIONAL so a plain
 * `RebasedWord` is a valid `AnnotatedWord` and emits byte-identical karaoke. */
export type AnnotatedWord = RebasedWord & {
  /** This word matched the clip's keyword list ⇒ render with emphasis. */
  isKeyword?: boolean
  /** An emoji to render alongside this word (auto-emoji). */
  emoji?: string
}

/**
 * Local keyword→emoji dictionary (offline, deterministic). Keys are normalized
 * (lowercase, alphanumerics only — see `normalize`). Intentionally small + high
 * signal; extend over time. Monochrome-safe glyphs are preferred for the burn.
 */
export const EMOJI_DICT: Record<string, string> = {
  money: '💰',
  cash: '💰',
  dollar: '💵',
  dollars: '💵',
  rich: '🤑',
  fire: '🔥',
  best: '🔥',
  hot: '🔥',
  love: '❤️',
  heart: '❤️',
  idea: '💡',
  think: '💡',
  smart: '🧠',
  brain: '🧠',
  win: '🏆',
  winner: '🏆',
  warning: '⚠️',
  danger: '⚠️',
  time: '⏰',
  fast: '⚡',
  speed: '⚡',
  energy: '⚡',
  rocket: '🚀',
  growth: '📈',
  grow: '📈',
  up: '📈',
  star: '⭐',
  amazing: '⭐',
  music: '🎵',
  video: '🎬',
  phone: '📱',
  secret: '🤫',
  shh: '🤫',
  stop: '✋',
  yes: '✅',
  correct: '✅',
  no: '❌',
  wrong: '❌',
  laugh: '😂',
  funny: '😂',
  cry: '😢',
  shock: '😱',
  crazy: '🤯',
  mind: '🤯',
  hundred: '💯',
  party: '🎉',
  celebrate: '🎉'
}

/** Normalize a transcript word for matching: lowercase, strip non-alphanumerics
 * (so `Money,` / `"money"` / `money.` all match the keyword `money`). Unicode-aware. */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** Look up an emoji for a word: the AI map (if provided) wins over the local dict. */
export function lookupEmoji(
  word: string,
  dict: Record<string, string> = EMOJI_DICT,
  aiMap?: Record<string, string>
): string | undefined {
  const key = normalizeWord(word)
  if (!key) return undefined
  if (aiMap && aiMap[key]) return aiMap[key]
  return dict[key]
}

export interface AnnotateOptions {
  /** Words to emphasize (usually `Clip.keywords`); matched case/punctuation-insensitively. */
  keywords?: string[]
  /** Emoji source: 'off' (default), 'local' (built-in dict), or 'ai' (BYOK map). */
  autoEmoji?: 'off' | 'local' | 'ai'
  /** The BYOK-AI emoji map (normalized keys → emoji), used when `autoEmoji === 'ai'`. */
  aiEmojiMap?: Record<string, string>
  /** Override the local dictionary (tests). */
  dict?: Record<string, string>
}

/**
 * Annotate each word with `isKeyword` (matched the keyword list) and an optional
 * `emoji`. A no-op (returns equivalent plain words) when there are no keywords
 * and `autoEmoji` is off/undefined — preserving byte-for-byte `.ass` output.
 */
export function annotateWords(words: RebasedWord[], opts: AnnotateOptions = {}): AnnotatedWord[] {
  const keywordSet = new Set((opts.keywords ?? []).map(normalizeWord).filter((k) => k.length > 0))
  const emojiOn = opts.autoEmoji === 'local' || opts.autoEmoji === 'ai'
  const aiMap = opts.autoEmoji === 'ai' ? opts.aiEmojiMap : undefined
  const dict = opts.dict ?? EMOJI_DICT
  return words.map((w) => {
    const out: AnnotatedWord = { word: w.word, start: w.start, end: w.end }
    if (keywordSet.size > 0 && keywordSet.has(normalizeWord(w.word))) out.isKeyword = true
    if (emojiOn) {
      const emoji = lookupEmoji(w.word, dict, aiMap)
      if (emoji) out.emoji = emoji
    }
    return out
  })
}
