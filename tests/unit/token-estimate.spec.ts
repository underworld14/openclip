/**
 * tests/unit/token-estimate.spec.ts — what a generate run costs, and the CJK bug
 * that made the chunker lie (FEAT-56bxyh).
 *
 * PRD §16 requires that before sending we "show estimated input tokens × the
 * selected model's known price so users aren't surprised". Nothing implemented
 * it. On BYOK the user pays per press, and this app's whole pitch is "cheap,
 * because we only ever send text" — not showing the number forfeits the
 * differentiator.
 *
 * THE REAL BUG under the missing feature: `estimateTokens` was a flat `chars/4`,
 * which is roughly right for English and badly wrong for CJK/Thai where a
 * character is often a whole token. Since that function drives the 10k chunk
 * budget, a Chinese transcript was chunked at up to ~4× the intended size — so
 * this was never only a display problem. It risked truncated model output on
 * exactly the languages whisper auto-detect makes reachable.
 */

import { describe, expect, it } from 'vitest'
import {
  CHUNK_MAX_TOKENS,
  OUTPUT_TOKENS_PER_CLIP,
  PROMPT_OVERHEAD_TOKENS,
  estimateChunkCount,
  estimateGenerateCost,
  estimateTokens,
  formatCostEstimate,
  formatTokens,
  formatUsd,
  isDenseScriptCodePoint
} from '@shared/token-estimate'
import { clipsPerChunk, estimateTokens as clientEstimateTokens } from '@main/services/ai-client'

describe('estimateTokens: the script matters', () => {
  it('keeps ~4 chars per token for Latin text', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
    expect(estimateTokens('')).toBe(0)
  })

  it('counts CJK at ~1 token per CHARACTER, not per 4', () => {
    // The bug: 100 Chinese characters were estimated at 25 tokens and are really
    // closer to 100 — so a chunk "under budget" was up to 4x over it.
    const cjk = '中'.repeat(100)
    expect(estimateTokens(cjk)).toBe(100)
    expect(estimateTokens(cjk)).toBeGreaterThan(Math.ceil(cjk.length / 4))
  })

  it('covers Japanese kana, Hangul and Thai too', () => {
    expect(estimateTokens('あ'.repeat(50))).toBe(50)
    expect(estimateTokens('カ'.repeat(50))).toBe(50)
    expect(estimateTokens('한'.repeat(50))).toBe(50)
    expect(estimateTokens('ก'.repeat(50))).toBe(50)
  })

  it('handles MIXED text by counting each part at its own rate', () => {
    // A Japanese transcript with English product names is the normal case, not
    // an edge case — one blanket rate for the whole string is wrong either way.
    expect(estimateTokens('中'.repeat(10) + 'a'.repeat(40))).toBe(20)
  })

  it('counts an astral-plane ideograph ONCE, not as two surrogates', () => {
    // U+20000 is a CJK Ext B ideograph: two UTF-16 code units, one character.
    // A `.length`-based scan would price it double.
    expect(estimateTokens('\u{20000}')).toBe(1)
  })

  it('classifies the dense ranges and nothing else', () => {
    expect(isDenseScriptCodePoint(0x4e2d)).toBe(true) // 中
    expect(isDenseScriptCodePoint(0x0061)).toBe(false) // a
    expect(isDenseScriptCodePoint(0x0301)).toBe(false) // combining acute
    expect(isDenseScriptCodePoint(0x0627)).toBe(false) // Arabic alef
  })

  it('is the SAME function the chunker uses', () => {
    // Two heuristics that could drift would make the number shown to the user a
    // lie about the requests actually sent.
    expect(clientEstimateTokens('中'.repeat(30))).toBe(estimateTokens('中'.repeat(30)))
  })
})

describe('estimateChunkCount', () => {
  it('is at least one, even for an empty transcript', () => {
    expect(estimateChunkCount(0)).toBe(1)
  })

  it('splits on the chunker’s own budget', () => {
    expect(estimateChunkCount(CHUNK_MAX_TOKENS)).toBe(1)
    expect(estimateChunkCount(CHUNK_MAX_TOKENS + 1)).toBe(2)
    expect(estimateChunkCount(CHUNK_MAX_TOKENS * 6)).toBe(6)
  })
})

describe('clipsPerChunk: stop asking every chunk for the whole batch', () => {
  it('asks a single chunk for the full count, exactly as before', () => {
    expect(clipsPerChunk(5, 1)).toBe(5)
  })

  it('asks each of N chunks for its SHARE plus slack', () => {
    // The waste: a 6-chunk video requested 6x5 = 30 clips to keep 5, paying ~6x
    // the output tokens to throw most of them away.
    expect(clipsPerChunk(5, 6)).toBe(2) // ceil(5/6)=1, +1 slack
    expect(clipsPerChunk(12, 3)).toBe(5) // ceil(12/3)=4, +1 slack
  })

  it('keeps slack rather than capping at the exact arithmetic share', () => {
    // The reduce step de-overlaps and ranks ACROSS chunks, so candidates are
    // always discarded — a chunk holding most of the good moments must not be
    // limited to its share.
    expect(clipsPerChunk(6, 3)).toBeGreaterThan(6 / 3)
  })

  it('never asks for more than the total', () => {
    expect(clipsPerChunk(1, 4)).toBe(1)
    expect(clipsPerChunk(2, 5)).toBe(2)
  })
})

describe('estimateGenerateCost', () => {
  const PRICE = { pricePerMTokIn: 3, pricePerMTokOut: 15 }

  it('charges the prompt scaffolding ONCE PER CHUNK', () => {
    // A 6-chunk video is six requests, not one. An estimate that ignored that
    // would under-report by six prompts' worth — the exact thing it exists to warn about.
    const one = estimateGenerateCost({
      transcriptTokens: 1000,
      chunkCount: 1,
      promptOverheadTokens: PROMPT_OVERHEAD_TOKENS,
      clipsPerChunk: 5,
      price: PRICE
    })
    const six = estimateGenerateCost({
      transcriptTokens: 1000,
      chunkCount: 6,
      promptOverheadTokens: PROMPT_OVERHEAD_TOKENS,
      clipsPerChunk: 5,
      price: PRICE
    })
    expect(six.inputTokens - one.inputTokens).toBe(5 * PROMPT_OVERHEAD_TOKENS)
  })

  it('prices OUTPUT tokens too — the part people forget', () => {
    const est = estimateGenerateCost({
      transcriptTokens: 0,
      chunkCount: 1,
      promptOverheadTokens: 0,
      clipsPerChunk: 5,
      price: PRICE
    })
    expect(est.outputTokens).toBe(5 * OUTPUT_TOKENS_PER_CLIP)
    expect(est.usd).toBeCloseTo((5 * OUTPUT_TOKENS_PER_CLIP * 15) / 1_000_000, 10)
  })

  it('returns usd null — not zero — when the model publishes no price', () => {
    // Zero would render as "$0", i.e. "free". That is a different claim from
    // "we do not know", and the wrong one to make about someone's own API key.
    const est = estimateGenerateCost({
      transcriptTokens: 5000,
      chunkCount: 1,
      promptOverheadTokens: 0,
      clipsPerChunk: 5,
      price: {}
    })
    expect(est.usd).toBeNull()
    expect(est.inputTokens).toBe(5000)
  })

  it('still prices when only ONE side of the price is published', () => {
    const est = estimateGenerateCost({
      transcriptTokens: 1_000_000,
      chunkCount: 1,
      promptOverheadTokens: 0,
      clipsPerChunk: 0,
      price: { pricePerMTokIn: 2 }
    })
    expect(est.usd).toBeCloseTo(2, 10)
  })

  it('treats a free model as genuinely free', () => {
    const est = estimateGenerateCost({
      transcriptTokens: 50_000,
      chunkCount: 5,
      promptOverheadTokens: 900,
      clipsPerChunk: 2,
      price: { pricePerMTokIn: 0, pricePerMTokOut: 0 }
    })
    expect(est.usd).toBe(0)
  })
})

describe('formatting', () => {
  it('shows sub-cent runs at four decimals rather than rounding to $0.00', () => {
    // The common case for this app. "$0.00" reads as free.
    expect(formatUsd(0.0031)).toBe('$0.0031')
    expect(formatUsd(1.234)).toBe('$1.23')
    expect(formatUsd(0)).toBe('$0')
  })

  it('abbreviates large token counts', () => {
    expect(formatTokens(1234)).toBe('1,234')
    expect(formatTokens(45_000)).toBe('45k')
  })

  it('shows the TOKENS even when the price is unknown', () => {
    // Hiding the whole estimate because half of it is missing tells the user
    // nothing at all.
    const line = formatCostEstimate({ inputTokens: 12_000, outputTokens: 0, usd: null }, 'my-model')
    expect(line).toContain('~12k input tokens')
    expect(line).toContain('price unknown')
    expect(line).toContain('my-model')
  })

  it('names the model and the estimate when priced', () => {
    const line = formatCostEstimate({ inputTokens: 5000, outputTokens: 2000, usd: 0.052 }, 'gpt-4o')
    expect(line).toBe('~5,000 input tokens · est. $0.05 with gpt-4o')
  })

  it('omits the model clause when there is no model to name', () => {
    expect(formatCostEstimate({ inputTokens: 100, outputTokens: 0, usd: 0.001 })).toBe(
      '~100 input tokens · est. $0.0010'
    )
  })
})
