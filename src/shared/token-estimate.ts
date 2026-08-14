/**
 * src/shared/token-estimate.ts — script-aware token estimation and BYOK cost
 * (FEAT-56bxyh).
 *
 * PRD §16 requires that before sending we "show estimated input tokens × the
 * selected model's known price so users aren't surprised". Nothing implemented
 * it: `estimateTokens` existed in `ai-client.ts` but only fed the internal 10k
 * chunk budget, and the only price surface in the whole app was a static label
 * inside the OpenRouter model picker.
 *
 * This app's entire pitch is "cheap, because we only ever send text". Not
 * showing the number forfeits the differentiator — and on BYOK the user pays per
 * click, so an unpriced button is a trust problem, not a missing nicety.
 *
 * THE CJK BUG. The old heuristic was a flat `chars / 4`. That is roughly right
 * for English and Indonesian and badly wrong for Chinese, Japanese, Korean and
 * Thai, where one character is often a whole token — so a Chinese transcript was
 * chunked at up to ~4× the intended token budget, risking truncated model output
 * on exactly the languages whisper auto-detect makes reachable.
 *
 * PURE and in `@shared`: the chunker (main) and the estimate the user sees
 * (renderer) must agree, and the only way to guarantee that is one function.
 */

/** Characters per token for Latin-ish scripts — the long-standing heuristic. */
export const CHARS_PER_TOKEN_LATIN = 4

/**
 * Characters per token for CJK/Thai. Close to 1: these scripts pack a morpheme
 * into a character, and BPE vocabularies give most of them their own token.
 * Deliberately not below 1 — under-counting is the failure that truncates output.
 */
export const CHARS_PER_TOKEN_CJK = 1

/**
 * Does this code point belong to a script where ~1 char ≈ 1 token?
 *
 * The ranges are the dense ones, not an exhaustive Unicode survey: CJK ideographs
 * (+ the common extensions), the Japanese kana, Hangul, and Thai. A cheap range
 * check is the right tool — the alternative is shipping a real tokenizer per
 * provider, which is a dependency and a version-skew problem for an estimate.
 */
export function isDenseScriptCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x0e00 && cp <= 0x0e7f) || // Thai
    (cp >= 0x20000 && cp <= 0x2a6df) // CJK Ext B
  )
}

/**
 * Estimated tokens for a string, counting dense-script characters separately.
 *
 * Mixed text is common and is handled by construction: a Japanese transcript with
 * English product names, or Chinese with Latin numerals, costs the dense rate for
 * the dense part and the Latin rate for the rest, rather than one blanket guess
 * for the whole string.
 *
 * Iterates by CODE POINT (`for…of`), so an astral-plane ideograph counts once
 * rather than twice as two surrogate halves.
 */
export function estimateTokens(text: string): number {
  let dense = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (isDenseScriptCodePoint(cp)) dense += 1
    else other += 1
  }
  return Math.ceil(dense / CHARS_PER_TOKEN_CJK + other / CHARS_PER_TOKEN_LATIN)
}

// ============================================================================
// Cost
// ============================================================================

export interface ModelPrice {
  /** USD per 1M input tokens. Undefined ⇒ this provider publishes no price to us. */
  pricePerMTokIn?: number
  /** USD per 1M output tokens. */
  pricePerMTokOut?: number
}

export interface CostEstimate {
  inputTokens: number
  outputTokens: number
  /** Total USD, or null when the model's price is unknown. */
  usd: number | null
}

/**
 * Tokens the MODEL will produce, which the user also pays for.
 *
 * Output is the part people forget, and on a structured-output clip response it
 * is not small: each clip carries a title, a hook, keywords, a caption, hashtags
 * and a four-part virality breakdown. ~400 tokens per clip is measured from real
 * responses and is the right order of magnitude for a warning-shaped number.
 */
export const OUTPUT_TOKENS_PER_CLIP = 400

/**
 * Estimate the spend for one generate run.
 *
 * `chunkCount` matters because map-reduce sends the SYSTEM PROMPT and the
 * per-chunk instructions once per chunk — a 6-chunk video is 6 requests, not
 * one, and an estimate that ignored that would under-report the thing it exists
 * to warn about.
 */
export function estimateGenerateCost(args: {
  /** Estimated tokens of transcript text actually being sent. */
  transcriptTokens: number
  /** Number of map-reduce chunks (≥1). */
  chunkCount: number
  /** Tokens of fixed prompt scaffolding per chunk. */
  promptOverheadTokens: number
  /** Clips requested PER CHUNK. */
  clipsPerChunk: number
  price: ModelPrice
}): CostEstimate {
  const chunks = Math.max(1, Math.round(args.chunkCount))
  const inputTokens = Math.ceil(args.transcriptTokens + chunks * args.promptOverheadTokens)
  const outputTokens = Math.ceil(chunks * args.clipsPerChunk * OUTPUT_TOKENS_PER_CLIP)
  const { pricePerMTokIn, pricePerMTokOut } = args.price
  if (pricePerMTokIn === undefined && pricePerMTokOut === undefined) {
    return { inputTokens, outputTokens, usd: null }
  }
  const usd =
    (inputTokens / 1_000_000) * (pricePerMTokIn ?? 0) +
    (outputTokens / 1_000_000) * (pricePerMTokOut ?? 0)
  return { inputTokens, outputTokens, usd }
}

/**
 * The chunk token budget, and the fixed prompt scaffolding per chunk.
 *
 * Both live HERE rather than in `ai-client.ts` so the renderer can predict the
 * chunk count without importing the main process (lint `import/no-restricted-paths`).
 * `ai-client` reads them from here, so the number the user is shown and the
 * requests actually sent cannot diverge.
 */
export const CHUNK_MAX_TOKENS = 10_000

/**
 * Tokens of system prompt + per-chunk instructions, paid once PER CHUNK.
 *
 * Measured from the shipped `SYSTEM_PROMPT` + `buildUserPrompt` scaffolding.
 * Approximate on purpose: it exists to stop a 6-chunk estimate from under-
 * reporting by six prompts' worth, not to be exact.
 */
export const PROMPT_OVERHEAD_TOKENS = 900

/**
 * How many chunks a transcript of this many tokens will be split into.
 *
 * Mirrors `chunkSegments`' budget so the renderer can price a run without
 * running the chunker. Segment boundaries make the real count vary by one either
 * way; for a cost estimate that is well inside the noise.
 */
export function estimateChunkCount(transcriptTokens: number): number {
  return Math.max(1, Math.ceil(transcriptTokens / CHUNK_MAX_TOKENS))
}

/** Compact token count: "1,234" under 10k, "12k" above — an estimate, shown as one. */
export function formatTokens(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US')
  return `${Math.round(n / 1000).toLocaleString('en-US')}k`
}

/**
 * "$0.0123" for small amounts, "$1.23" above a cent.
 *
 * Sub-cent runs are the common case for this app and rounding them to "$0.00"
 * would read as "free" — which is a different claim than "very cheap", and the
 * wrong one to make about someone's own API key.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/**
 * The line shown next to Generate.
 *
 * When the price is unknown the TOKEN count is still shown. The ticket is
 * explicit about this and it is the right call: "~12k input tokens · price
 * unknown for this model" is informative, and hiding the estimate entirely
 * because half of it is missing tells the user nothing at all.
 */
export function formatCostEstimate(est: CostEstimate, modelLabel?: string): string {
  const tokens = `~${formatTokens(est.inputTokens)} input tokens`
  if (est.usd === null) {
    return `${tokens} · price unknown${modelLabel ? ` for ${modelLabel}` : ''}`
  }
  return `${tokens} · est. ${formatUsd(est.usd)}${modelLabel ? ` with ${modelLabel}` : ''}`
}
