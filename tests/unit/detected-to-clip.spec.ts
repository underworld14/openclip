/**
 * detected-to-clip.spec.ts — detectedToClip maps the frozen AI DetectedClip
 * (snake_case) onto the app Clip. Asserts the AI-suggested social caption + hashtags
 * are CARRIED through instead of silently discarded (audit fix openclip-5cd).
 */
import { describe, it, expect } from 'vitest'
import { detectedToClip } from '@renderer/stores/projectStore/clipsSlice'
import { Clip, type DetectedClip } from '@shared/schema'

const detected: DetectedClip = {
  start_time: 10,
  end_time: 25,
  title: 'A punchy title',
  hook: 'You will not believe',
  virality_score: 8,
  clip_type: 'story',
  keywords: ['ai', 'clips'],
  virality: {
    hook_score: 9,
    engagement_score: 8,
    value_score: 7,
    shareability_score: 8,
    total_score: 80,
    hook_type: 'question'
  },
  suggested_caption: 'The one trick that changed everything 🎬',
  hashtags: ['#shorts', '#viral']
}

describe('detectedToClip (openclip-5cd)', () => {
  it('carries suggested_caption → suggestedCaption and hashtags through', () => {
    const clip = detectedToClip(detected, 0)
    expect(clip.suggestedCaption).toBe('The one trick that changed everything 🎬')
    expect(clip.hashtags).toEqual(['#shorts', '#viral'])
  })

  it('produces a Clip that round-trips through the persisted Clip schema', () => {
    const clip = detectedToClip(detected, 1)
    const parsed = Clip.parse(clip)
    expect(parsed.suggestedCaption).toBe(detected.suggested_caption)
    expect(parsed.hashtags).toEqual(detected.hashtags)
  })
})
