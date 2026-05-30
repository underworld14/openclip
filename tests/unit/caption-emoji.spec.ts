/**
 * tests/unit/caption-emoji.spec.ts — the renderer AI-emoji fetch helper (Part K).
 * Pure + bridge-injected: asserts clip-scoped word collection, the independent
 * emoji provider/model resolution, and the best-effort no-emoji fallbacks.
 */

import { describe, expect, it, vi } from 'vitest'
import { clipCaptionWords, fetchAiEmojiMap } from '@renderer/components/caption-emoji'
import type { Clip, Settings, WordTimestamp } from '@shared/schema'

const clip = {
  id: 'c1',
  startTime: 0,
  endTime: 10,
  title: 't',
  hook: 'h',
  viralityScore: 5,
  clipType: 'hook',
  keywords: [],
  status: 'approved'
} as Clip

const words: WordTimestamp[] = [
  { word: 'Money', start: 1, end: 1.4, confidence: 1 },
  { word: 'money', start: 2, end: 2.4, confidence: 1 }, // dup (case-insensitive)
  { word: 'fire', start: 3, end: 3.4, confidence: 1 },
  { word: 'later', start: 20, end: 20.4, confidence: 1 } // outside the clip span
]

const settings: Pick<Settings, 'aiProvider' | 'model' | 'emojiProvider' | 'emojiModel'> = {
  aiProvider: 'openai',
  model: 'gpt-4o-mini',
  emojiProvider: 'ollama',
  emojiModel: 'llama3.2'
}

describe('clipCaptionWords', () => {
  it('keeps distinct in-span words (case-insensitive), drops out-of-span', () => {
    expect(clipCaptionWords(words, clip)).toEqual(['Money', 'fire'])
  })
})

describe('fetchAiEmojiMap', () => {
  const bridgeWith = (res: unknown): { ai: { enhanceCaptions: ReturnType<typeof vi.fn> } } => ({
    ai: { enhanceCaptions: vi.fn(async () => res) }
  })

  it('returns undefined for non-ai modes without calling the bridge', async () => {
    const bridge = bridgeWith({ enhanced_captions: [] })
    expect(
      await fetchAiEmojiMap({ bridge: bridge as never, settings, words, clip, autoEmoji: 'off' })
    ).toBeUndefined()
    expect(
      await fetchAiEmojiMap({ bridge: bridge as never, settings, words, clip, autoEmoji: 'local' })
    ).toBeUndefined()
    expect(bridge.ai.enhanceCaptions).not.toHaveBeenCalled()
  })

  it('resolves the INDEPENDENT emoji provider/model and returns the map', async () => {
    const bridge = bridgeWith({ enhanced_captions: [], emoji_map: { money: '💰', fire: '🔥' } })
    const map = await fetchAiEmojiMap({
      bridge: bridge as never,
      settings,
      words,
      clip,
      autoEmoji: 'ai'
    })
    expect(map).toEqual({ money: '💰', fire: '🔥' })
    expect(bridge.ai.enhanceCaptions).toHaveBeenCalledWith({
      provider: 'ollama',
      model: 'llama3.2',
      transcript: '',
      mode: 'emoji',
      words: ['Money', 'fire']
    })
  })

  it('falls back to the clip provider/model when emoji ones are unset', async () => {
    const bridge = bridgeWith({ enhanced_captions: [], emoji_map: {} })
    await fetchAiEmojiMap({
      bridge: bridge as never,
      settings: { aiProvider: 'anthropic', model: 'claude' },
      words,
      clip,
      autoEmoji: 'ai'
    })
    expect(bridge.ai.enhanceCaptions).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic', model: 'claude' })
    )
  })

  it('returns {} (never throws) when the bridge errors', async () => {
    const bridge = {
      ai: {
        enhanceCaptions: vi.fn(async () => {
          throw new Error('provider down')
        })
      }
    }
    expect(
      await fetchAiEmojiMap({ bridge: bridge as never, settings, words, clip, autoEmoji: 'ai' })
    ).toEqual({})
  })

  it('returns undefined when the clip has no caption words (no bridge call)', async () => {
    const bridge = bridgeWith({ enhanced_captions: [] })
    expect(
      await fetchAiEmojiMap({ bridge: bridge as never, settings, words: [], clip, autoEmoji: 'ai' })
    ).toBeUndefined()
    expect(bridge.ai.enhanceCaptions).not.toHaveBeenCalled()
  })
})
